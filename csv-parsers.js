// ============================================================
// csv-parsers.js — Bank statement CSV adapters
// Each parser normalises its bank's format into a standard
// transaction array before anything touches the database.
//
// Standard output row:
// {
//   date:        string  — ISO 8601 "YYYY-MM-DD"
//   description: string  — cleaned description text
//   amount:      number  — signed float (positive = in, negative = out)
//   balance:     number|null
// }
// ============================================================

// ── Core CSV tokeniser ────────────────────────────────────────
// Handles quoted fields, escaped quotes (""), \r\n and \n.
function tokeniseCSV(text) {
  const lines = [];
  const rows  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const raw of rows) {
    const line = raw.trim();
    if (line === '') continue;
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    lines.push(fields);
  }
  return lines;
}

// ── Date parsers ──────────────────────────────────────────────

// DD/MM/YYYY  →  YYYY-MM-DD
function parseDMY(str) {
  const s = String(str).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// YYYY/MM/DD or YYYY-MM-DD  →  YYYY-MM-DD
function parseYMD(str) {
  const s = String(str).trim();
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// "01 Mar 2024" or "1 March 2024"  →  YYYY-MM-DD
const MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  january:1, february:2, march:3, april:4,
  june:6, july:7, august:8, september:9,
  october:10, november:11, december:12,
};
function parseDMonY(str) {
  const s = String(str).trim();
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const d  = m[1];
  const mo = MONTH_MAP[m[2].toLowerCase()];
  const y  = m[3];
  if (!mo) return null;
  return `${y}-${String(mo).padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// Try all date formats, return ISO string or null
function parseDate(str) {
  return parseDMY(str) || parseYMD(str) || parseDMonY(str) || null;
}

// ── Amount parsers ────────────────────────────────────────────

// Strip currency symbols, spaces, thousands separators; return float or null
function parseAmount(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim().replace(/[R\s]/g, '').replace(/,(?=\d{3})/g, '');
  if (s === '' || s === '-' || s === '—') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Description cleaner ───────────────────────────────────────
// Collapse multiple spaces; strip leading/trailing whitespace.
// Capitec-specific: remove long numeric reference prefixes.
function cleanDesc(str, stripRefs) {
  let s = String(str || '').replace(/\s+/g, ' ').trim();
  if (stripRefs) {
    // Remove patterns like "REF 1234567890 " or "123456789 " at the start
    s = s.replace(/^(REF\s+)?[\d]{6,}\s+/i, '').trim();
  }
  return s || 'No description';
}

// ── Header index helper ───────────────────────────────────────
// Find column index by lowercase partial match in a header row.
function colIdx(headers, ...candidates) {
  for (const cand of candidates) {
    const idx = headers.findIndex(h => h.toLowerCase().includes(cand.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── Validation helper ─────────────────────────────────────────
function parseError(msg) {
  return { ok: false, error: msg, rows: [] };
}
function parseOk(rows) {
  return { ok: true, error: null, rows };
}

// ============================================================
// ABSA PARSER
// Expected columns: Date, Description, Amount (signed), Balance
// Date format: DD/MM/YYYY
// Amount: single column, negative = debit, positive = credit
// ============================================================
function parseABSA(text) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File is empty or has no data rows.');

  // Find the header row (first row with "date" in it)
  let headerIdx = lines.findIndex(row =>
    row.some(c => c.toLowerCase().includes('date'))
  );
  if (headerIdx === -1) return parseError('Could not find a header row. Expected columns: Date, Description, Amount, Balance.');

  const headers = lines[headerIdx];
  const iDate   = colIdx(headers, 'date');
  const iDesc   = colIdx(headers, 'description', 'narration', 'detail', 'reference');
  const iAmt    = colIdx(headers, 'amount', 'transaction amount');
  const iBal    = colIdx(headers, 'balance', 'running balance');

  if (iDate === -1) return parseError('Missing "Date" column. ABSA export should have: Date, Description, Amount, Balance.');
  if (iDesc === -1) return parseError('Missing "Description" column.');
  if (iAmt  === -1) return parseError('Missing "Amount" column. ABSA uses a single signed amount column.');

  const rows = [];
  const errors = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(c => c === '')) continue; // blank line

    const rawDate = row[iDate]  || '';
    const rawDesc = row[iDesc]  || '';
    const rawAmt  = row[iAmt]   || '';
    const rawBal  = iBal !== -1 ? (row[iBal] || '') : '';

    const date = parseDate(rawDate);
    if (!date) {
      errors.push(`Row ${i + 1}: unrecognised date "${rawDate}" — skipped.`);
      continue;
    }

    const amount = parseAmount(rawAmt);
    if (amount === null) {
      errors.push(`Row ${i + 1}: unrecognised amount "${rawAmt}" — skipped.`);
      continue;
    }

    rows.push({
      date,
      description: cleanDesc(rawDesc, false),
      amount,
      balance: parseAmount(rawBal),
    });
  }

  if (rows.length === 0) return parseError('No valid transactions found. ' + errors.join(' '));
  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// STANDARD BANK PARSER
// Expected columns: Date, Description, Debit, Credit, Balance
// Date format: DD/MM/YYYY
// Debit column: positive number (money out) → converted to negative
// Credit column: positive number (money in) → kept positive
// ============================================================
function parseStandardBank(text) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File is empty or has no data rows.');

  let headerIdx = lines.findIndex(row =>
    row.some(c => c.toLowerCase().includes('date'))
  );
  if (headerIdx === -1) return parseError('Could not find a header row. Expected: Date, Description, Debit, Credit, Balance.');

  const headers = lines[headerIdx];
  const iDate   = colIdx(headers, 'date');
  const iDesc   = colIdx(headers, 'description', 'transaction details', 'narration', 'detail');
  const iDebit  = colIdx(headers, 'debit');
  const iCredit = colIdx(headers, 'credit');
  const iBal    = colIdx(headers, 'balance', 'running balance');

  if (iDate   === -1) return parseError('Missing "Date" column.');
  if (iDesc   === -1) return parseError('Missing "Description" column.');
  if (iDebit  === -1 && iCredit === -1)
    return parseError('Missing both "Debit" and "Credit" columns. Standard Bank export should have separate Debit and Credit columns.');

  const rows   = [];
  const errors = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(c => c === '')) continue;

    const rawDate   = row[iDate]              || '';
    const rawDesc   = row[iDesc]              || '';
    const rawDebit  = iDebit  !== -1 ? (row[iDebit]  || '') : '';
    const rawCredit = iCredit !== -1 ? (row[iCredit] || '') : '';
    const rawBal    = iBal    !== -1 ? (row[iBal]    || '') : '';

    const date = parseDate(rawDate);
    if (!date) {
      errors.push(`Row ${i + 1}: unrecognised date "${rawDate}" — skipped.`);
      continue;
    }

    const debit  = parseAmount(rawDebit);
    const credit = parseAmount(rawCredit);

    // One of debit or credit must be present
    if (debit === null && credit === null) {
      errors.push(`Row ${i + 1}: no amount in Debit or Credit columns — skipped.`);
      continue;
    }

    // Normalise: credit positive, debit negative
    let amount;
    if (credit !== null && credit !== 0) {
      amount = Math.abs(credit);
    } else if (debit !== null && debit !== 0) {
      amount = -Math.abs(debit);
    } else {
      // Both zero — skip
      continue;
    }

    rows.push({
      date,
      description: cleanDesc(rawDesc, false),
      amount,
      balance: parseAmount(rawBal),
    });
  }

  if (rows.length === 0) return parseError('No valid transactions found. ' + errors.join(' '));
  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// CAPITEC PARSER
// Expected columns: Date, Transaction Description, Money In, Money Out, Balance
// Date format: YYYY/MM/DD (or YYYY-MM-DD)
// Description: may contain numeric reference prefixes — strip them
// ============================================================
function parseCapitec(text) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File is empty or has no data rows.');

  let headerIdx = lines.findIndex(row =>
    row.some(c => c.toLowerCase().includes('date'))
  );
  if (headerIdx === -1) return parseError('Could not find a header row. Expected: Date, Transaction Description, Money In, Money Out, Balance.');

  const headers = lines[headerIdx];
  const iDate   = colIdx(headers, 'date');
  const iDesc   = colIdx(headers, 'description', 'transaction description', 'details', 'narration');
  const iIn     = colIdx(headers, 'money in', 'credit', 'in');
  const iOut    = colIdx(headers, 'money out', 'debit', 'out');
  const iBal    = colIdx(headers, 'balance', 'available balance', 'closing');

  if (iDate === -1) return parseError('Missing "Date" column.');
  if (iDesc === -1) return parseError('Missing "Description" / "Transaction Description" column.');
  if (iIn  === -1 && iOut === -1) return parseError('Missing "Money In" and "Money Out" columns.');

  const rows   = [];
  const errors = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(c => c === '')) continue;

    const rawDate = row[iDate] || '';
    const rawDesc = row[iDesc] || '';
    const rawIn   = iIn  !== -1 ? (row[iIn]  || '') : '';
    const rawOut  = iOut !== -1 ? (row[iOut] || '') : '';
    const rawBal  = iBal !== -1 ? (row[iBal] || '') : '';

    const date = parseDate(rawDate);
    if (!date) {
      errors.push(`Row ${i + 1}: unrecognised date "${rawDate}" — skipped.`);
      continue;
    }

    const moneyIn  = parseAmount(rawIn);
    const moneyOut = parseAmount(rawOut);

    if (moneyIn === null && moneyOut === null) {
      errors.push(`Row ${i + 1}: no amount found — skipped.`);
      continue;
    }

    let amount;
    if (moneyIn !== null && moneyIn !== 0) {
      amount = Math.abs(moneyIn);
    } else if (moneyOut !== null && moneyOut !== 0) {
      amount = -Math.abs(moneyOut);
    } else {
      continue;
    }

    rows.push({
      date,
      description: cleanDesc(rawDesc, true), // strip reference numbers
      amount,
      balance: parseAmount(rawBal),
    });
  }

  if (rows.length === 0) return parseError('No valid transactions found. ' + errors.join(' '));
  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// NEDBANK PARSER
// Nedbank exports have several metadata/header rows before the
// actual data. We scan forward until we find a row that looks
// like a real column header (contains "date" and an amount column).
// ============================================================
function parseNedbank(text) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File is empty or has no data rows.');

  // Scan for the actual column header row
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    const hasDate   = row.some(c => c.toLowerCase().trim() === 'date' || c.toLowerCase().includes('transaction date'));
    const hasAmount = row.some(c =>
      c.toLowerCase().includes('debit') ||
      c.toLowerCase().includes('credit') ||
      c.toLowerCase().includes('amount')
    );
    if (hasDate && hasAmount) { headerIdx = i; break; }
  }

  if (headerIdx === -1) {
    return parseError(
      'Could not locate the data column header row. ' +
      'Nedbank exports typically have account details before the transaction table. ' +
      'Expected a row containing "Date" and "Debit"/"Credit"/"Amount".'
    );
  }

  const headers = lines[headerIdx];
  const iDate   = colIdx(headers, 'transaction date', 'date');
  const iDesc   = colIdx(headers, 'description', 'transaction details', 'narration', 'detail');
  const iDebit  = colIdx(headers, 'debit');
  const iCredit = colIdx(headers, 'credit');
  const iAmt    = (iDebit === -1 && iCredit === -1) ? colIdx(headers, 'amount') : -1;
  const iBal    = colIdx(headers, 'balance', 'running balance', 'closing balance');

  if (iDate === -1) return parseError('Found header row but could not identify a "Date" column.');
  if (iDesc === -1) return parseError('Found header row but could not identify a "Description" column.');
  if (iDebit === -1 && iCredit === -1 && iAmt === -1)
    return parseError('Found header row but could not identify amount columns (Debit/Credit or Amount).');

  const rows   = [];
  const errors = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(c => c === '')) continue;

    // Some Nedbank exports have a summary/footer after a blank separator
    // If we find a row that is entirely non-numeric in date position, stop.
    const rawDate = row[iDate] || '';
    if (!rawDate && i > headerIdx + 2) continue;

    const date = parseDate(rawDate);
    if (!date) {
      errors.push(`Row ${i + 1}: unrecognised date "${rawDate}" — skipped.`);
      continue;
    }

    const rawDesc   = row[iDesc]              || '';
    const rawDebit  = iDebit  !== -1 ? (row[iDebit]  || '') : '';
    const rawCredit = iCredit !== -1 ? (row[iCredit] || '') : '';
    const rawAmt    = iAmt    !== -1 ? (row[iAmt]    || '') : '';
    const rawBal    = iBal    !== -1 ? (row[iBal]    || '') : '';

    let amount;
    if (iAmt !== -1) {
      // Single signed amount column
      amount = parseAmount(rawAmt);
      if (amount === null) {
        errors.push(`Row ${i + 1}: unrecognised amount "${rawAmt}" — skipped.`);
        continue;
      }
    } else {
      const debit  = parseAmount(rawDebit);
      const credit = parseAmount(rawCredit);
      if (debit === null && credit === null) {
        errors.push(`Row ${i + 1}: no amount in Debit or Credit columns — skipped.`);
        continue;
      }
      if (credit !== null && credit !== 0) {
        amount = Math.abs(credit);
      } else if (debit !== null && debit !== 0) {
        amount = -Math.abs(debit);
      } else {
        continue;
      }
    }

    rows.push({
      date,
      description: cleanDesc(rawDesc, false),
      amount,
      balance: parseAmount(rawBal),
    });
  }

  if (rows.length === 0) return parseError('No valid transactions found after the header row. ' + errors.join(' '));
  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// DISPATCHER — call the right parser by bank key
// ============================================================
function parseCSV(bank, text) {
  const t = (text || '').trim();
  if (!t) return parseError('File is empty.');

  switch (bank) {
    case 'absa':          return parseABSA(t);
    case 'standard_bank': return parseStandardBank(t);
    case 'capitec':       return parseCapitec(t);
    case 'nedbank':       return parseNedbank(t);
    default:
      return parseError(`Unknown bank "${bank}". Must be one of: absa, standard_bank, capitec, nedbank.`);
  }
}

// ============================================================
// OPENING BALANCES CSV PARSER
// Template format: account_code, account_name, debit, credit
// Validates that debits == credits before returning.
// ============================================================
function parseOpeningBalancesCSV(text) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File must have a header row and at least one data row.');

  const headers = lines[0];
  const iCode   = colIdx(headers, 'account_code', 'code');
  const iName   = colIdx(headers, 'account_name', 'name', 'description');
  const iDebit  = colIdx(headers, 'debit');
  const iCredit = colIdx(headers, 'credit');
  const iAmt    = (iDebit === -1 || iCredit === -1) ? colIdx(headers, 'amount') : -1;

  if (iCode === -1) return parseError('Missing "account_code" column.');
  if (iName === -1) return parseError('Missing "account_name" column.');
  if (iDebit === -1 && iCredit === -1 && iAmt === -1)
    return parseError('Missing amount columns. Template needs "debit" and "credit" columns (or a single "amount" column with signed values).');

  const rows   = [];
  const errors = [];
  let totalDebits = 0, totalCredits = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(c => c === '')) continue;

    const code = (row[iCode] || '').trim();
    const name = (row[iName] || '').trim();
    if (!code || !name) {
      errors.push(`Row ${i + 1}: missing account code or name — skipped.`);
      continue;
    }

    let amount;
    if (iAmt !== -1) {
      amount = parseAmount(row[iAmt] || '');
      if (amount === null) {
        errors.push(`Row ${i + 1}: invalid amount — skipped.`);
        continue;
      }
      if (amount > 0) totalDebits  += amount;
      else            totalCredits += Math.abs(amount);
    } else {
      const d = parseAmount(row[iDebit]  || '') || 0;
      const c = parseAmount(row[iCredit] || '') || 0;
      if (d === 0 && c === 0) {
        errors.push(`Row ${i + 1}: both debit and credit are zero — skipped.`);
        continue;
      }
      totalDebits  += d;
      totalCredits += c;
      // Debit = positive (asset/expense side), Credit = negative (liability/equity/income side)
      amount = d > 0 ? d : -c;
    }

    rows.push({ account_code: code, account_name: name, amount });
  }

  if (rows.length === 0) return parseError('No valid rows found. ' + errors.join(' '));

  // Validate that trial balance is in balance (debits = credits)
  const diff = Math.abs(totalDebits - totalCredits);
  if (diff > 0.01) {
    return parseError(
      `Opening balances do not balance. ` +
      `Total debits: R ${totalDebits.toFixed(2)}, ` +
      `Total credits: R ${totalCredits.toFixed(2)}, ` +
      `Difference: R ${diff.toFixed(2)}. ` +
      `Fix the file and re-import.`
    );
  }

  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// EXPORTS
// ============================================================
window.Parsers = {
  parseCSV,
  parseABSA,
  parseStandardBank,
  parseCapitec,
  parseNedbank,
  parseOpeningBalancesCSV,
  // Expose helpers for testing
  _parseDate:   parseDate,
  _parseAmount: parseAmount,
  _tokeniseCSV: tokeniseCSV,
};

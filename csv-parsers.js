// ============================================================
// csv-parsers.js — Universal bank statement CSV parser
//
// All banks (ABSA, Standard Bank, Capitec, Nedbank) use the
// same standard column structure:
//
//   Date | Description | Category | Money In | Money Out | Fee | Balance
//
// Category and Fee are optional columns — parsed but not stored.
// Money In and Money Out are both positive numbers.
// amount = Money In (positive) or Money Out (negative).
// If both are present on a row, Money In takes precedence.
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
function cleanDesc(str) {
  return String(str || '').replace(/\s+/g, ' ').trim() || 'No description';
}

// ── Header index helper ───────────────────────────────────────
function colIdx(headers, ...candidates) {
  for (const cand of candidates) {
    const idx = headers.findIndex(h => h.toLowerCase().includes(cand.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── Result helpers ────────────────────────────────────────────
function parseError(msg) { return { ok: false, error: msg, rows: [] }; }
function parseOk(rows)   { return { ok: true,  error: null, rows }; }

// ============================================================
// UNIVERSAL PARSER
// Standard column structure (all four banks):
//   Date | Description | Category | Money In | Money Out | Fee | Balance
//
// - Category is informational — not stored.
// - Fee is informational — not stored (fees appear as their own rows).
// - Money In and Money Out are both positive numbers.
// - If a row has Money In, amount = +MoneyIn.
//   If a row has Money Out, amount = -MoneyOut.
// ============================================================
function parseUniversal(text, bankLabel) {
  const lines = tokeniseCSV(text);
  if (lines.length < 2) return parseError('File is empty or has no data rows.');

  // Find the header row — first row containing "date"
  const headerIdx = lines.findIndex(row =>
    row.some(c => c.toLowerCase().trim() === 'date')
  );
  if (headerIdx === -1) {
    return parseError(
      'Could not find a header row. ' +
      'The first row must contain: Date, Description, Category, Money In, Money Out, Fee, Balance'
    );
  }

  const headers = lines[headerIdx];
  const iDate   = colIdx(headers, 'date');
  const iDesc   = colIdx(headers, 'description');
  const iIn     = colIdx(headers, 'money in');
  const iOut    = colIdx(headers, 'money out');
  const iBal    = colIdx(headers, 'balance');
  // Category and Fee are parsed but not stored
  // iCat and iFee could be added if needed in future

  if (iDate === -1) return parseError(
    'Missing "Date" column. Required columns: Date, Description, Category, Money In, Money Out, Fee, Balance'
  );
  if (iDesc === -1) return parseError(
    'Missing "Description" column. Required columns: Date, Description, Category, Money In, Money Out, Fee, Balance'
  );
  if (iIn === -1 && iOut === -1) return parseError(
    'Missing "Money In" and "Money Out" columns. Required columns: Date, Description, Category, Money In, Money Out, Fee, Balance'
  );

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
      errors.push(`Row ${i + 1}: no amount in Money In or Money Out — skipped.`);
      continue;
    }

    let amount;
    if (moneyIn !== null && moneyIn !== 0) {
      amount = Math.abs(moneyIn);
    } else if (moneyOut !== null && moneyOut !== 0) {
      amount = -Math.abs(moneyOut);
    } else {
      // Both zero — skip (e.g. a pure balance row)
      continue;
    }

    rows.push({
      date,
      description: cleanDesc(rawDesc),
      amount,
      balance: parseAmount(rawBal),
    });
  }

  if (rows.length === 0) {
    return parseError('No valid transactions found. ' + errors.join(' '));
  }
  return { ...parseOk(rows), warnings: errors };
}

// ============================================================
// DISPATCHER — all banks now use the universal parser
// The bank parameter is kept for compatibility with the import
// flow (it becomes the source_bank label on each transaction).
// ============================================================
function parseCSV(bank, text) {
  const t = (text || '').trim();
  if (!t) return parseError('File is empty.');

  switch (bank) {
    case 'absa':
    case 'standard_bank':
    case 'capitec':
    case 'nedbank':
      return parseUniversal(t, bank);
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
      amount = d > 0 ? d : -c;
    }

    rows.push({ account_code: code, account_name: name, amount });
  }

  if (rows.length === 0) return parseError('No valid rows found. ' + errors.join(' '));

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
  parseUniversal,
  parseOpeningBalancesCSV,
  // Expose helpers for testing
  _parseDate:   parseDate,
  _parseAmount: parseAmount,
  _tokeniseCSV: tokeniseCSV,
};

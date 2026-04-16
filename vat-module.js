// ============================================================
// vat-module.js — South African VAT calculations and reporting
//
// SA VAT rate: 15% (effective 1 April 2018)
// VAT is always inclusive in bank statement amounts.
// The VAT component is extracted (not added on top).
//
// Terminology used throughout:
//   Output VAT  — VAT collected on sales (money in)
//   Input VAT   — VAT paid on purchases/expenses (money out, claimable)
//   Net VAT     — Output VAT minus Input VAT
//                 Positive = payable to SARS
//                 Negative = refund due from SARS
// ============================================================

const VAT_RATE = 0.15;           // 15%
const VAT_INCLUSIVE_FACTOR = VAT_RATE / (1 + VAT_RATE); // ≈ 0.130435

// ── Core arithmetic ───────────────────────────────────────────

// Extract VAT from a VAT-inclusive amount.
// e.g. R115.00 inclusive → VAT = R15.00, exclusive = R100.00
function extractVAT(inclusiveAmount) {
  return round2(Math.abs(inclusiveAmount) * VAT_INCLUSIVE_FACTOR);
}

// Exclusive amount given inclusive total.
function exclusiveAmount(inclusiveAmount) {
  return round2(Math.abs(inclusiveAmount) - extractVAT(inclusiveAmount));
}

// Add VAT onto an exclusive amount.
function addVAT(exclusiveAmt) {
  return round2(exclusiveAmt * (1 + VAT_RATE));
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Apply VAT to a transaction row ────────────────────────────
// Used when the user confirms VAT type during import.
// Mutates a copy of the row — does not modify the original.
function applyVATToRow(row, vatType) {
  if (!vatType || vatType === 'none') {
    return { ...row, vat_type: 'none', vat_amount: 0 };
  }
  const vat = extractVAT(row.amount);
  return { ...row, vat_type: vatType, vat_amount: vat };
}

// Apply VAT type to an entire batch of rows.
// Only applies to rows where account_type is income/cost_of_sales/expense.
// Asset, liability, equity accounts are excluded from VAT.
function applyVATToBatch(rows, vatType, coa) {
  if (!vatType || vatType === 'none') return rows;

  // Build a set of account codes that are VAT-eligible
  const vatEligible = new Set(
    (coa || [])
      .filter(a => ['income', 'cost_of_sales', 'expense'].includes(a.account_type))
      .map(a => a.account_code)
  );

  return rows.map(row => {
    // Unclassified rows — tag with import-level VAT type, calculate later
    if (!row.account_code) {
      return { ...row, vat_type: vatType, vat_amount: 0 };
    }
    // Only apply VAT to eligible account types
    if (!vatEligible.has(row.account_code)) {
      return { ...row, vat_type: 'none', vat_amount: 0 };
    }
    return applyVATToRow(row, vatType);
  });
}

// ── VAT report calculations ───────────────────────────────────

// Build a full VAT report for a client, year, and optional period filter.
// transactions: array from DB (already filtered by client + year)
// period:       null = full year, string = specific period
//
// Returns:
// {
//   outputVAT:   number,   — VAT collected on sales
//   inputVAT:    number,   — VAT paid on purchases (claimable)
//   netVAT:      number,   — outputVAT - inputVAT (positive = owe SARS)
//   outputRows:  [],       — individual output VAT transactions
//   inputRows:   [],       — individual input VAT transactions
//   byPeriod:    {}        — breakdown keyed by period string
// }
function buildVATReport(transactions, period) {
  const filtered = period
    ? transactions.filter(t => t.period === period)
    : transactions;

  // Only transactions with actual VAT amounts
  const vatRows = filtered.filter(t => t.vat_type !== 'none' && t.vat_amount > 0);

  const outputRows = vatRows.filter(t => t.vat_type === 'output');
  const inputRows  = vatRows.filter(t => t.vat_type === 'input');

  const outputVAT = round2(outputRows.reduce((s, t) => s + (t.vat_amount || 0), 0));
  const inputVAT  = round2(inputRows.reduce((s, t) => s + (t.vat_amount || 0), 0));
  const netVAT    = round2(outputVAT - inputVAT);

  // Period breakdown (for the period selector in the UI)
  const byPeriod = {};
  for (const t of vatRows) {
    if (!byPeriod[t.period]) {
      byPeriod[t.period] = { outputVAT: 0, inputVAT: 0, netVAT: 0 };
    }
    if (t.vat_type === 'output') byPeriod[t.period].outputVAT = round2(byPeriod[t.period].outputVAT + (t.vat_amount || 0));
    if (t.vat_type === 'input')  byPeriod[t.period].inputVAT  = round2(byPeriod[t.period].inputVAT  + (t.vat_amount || 0));
  }
  for (const p of Object.keys(byPeriod)) {
    byPeriod[p].netVAT = round2(byPeriod[p].outputVAT - byPeriod[p].inputVAT);
  }

  return { outputVAT, inputVAT, netVAT, outputRows, inputRows, byPeriod };
}

// ── VAT 201 summary builder ───────────────────────────────────
// Formats the report into a structure ready for rendering / export.
// Matches the layout of a SARS VAT201 return.
function buildVAT201(vatReport, clientName, financialYear, period) {
  const { outputVAT, inputVAT, netVAT, outputRows, inputRows, byPeriod } = vatReport;

  // Gross sales = sum of output-VAT transaction amounts (inclusive)
  const grossSales     = round2(outputRows.reduce((s, t) => s + Math.abs(t.amount), 0));
  const grossPurchases = round2(inputRows.reduce((s, t) => s + Math.abs(t.amount), 0));

  // Exclusive amounts
  const exclusiveSales     = round2(grossSales     - outputVAT);
  const exclusivePurchases = round2(grossPurchases - inputVAT);

  return {
    clientName,
    financialYear,
    period: period || 'Full year',
    // Field 1 — Standard-rated supplies (exclusive)
    field1:  exclusiveSales,
    // Field 4A — Output VAT
    field4A: outputVAT,
    // Field 15 — Standard-rated purchases (exclusive)
    field15: exclusivePurchases,
    // Field 17 — Input VAT
    field17: inputVAT,
    // Field 20 — Net VAT payable (+) or refundable (-)
    field20: netVAT,
    // Supporting detail
    grossSales,
    grossPurchases,
    outputRows,
    inputRows,
    byPeriod,
    isRefund: netVAT < 0,
    label:    netVAT >= 0 ? 'VAT payable to SARS' : 'VAT refund due',
  };
}

// ── VAT period helpers ────────────────────────────────────────

const _MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
];

// Parse a 1-based month number from a period string like "March 2024".
function _monthFromPeriod(period) {
  const lower = (period || '').toLowerCase();
  const idx = _MONTH_NAMES.findIndex(m => lower.startsWith(m));
  return idx >= 0 ? idx + 1 : 0;
}

// Parse the 4-digit year from a period string.
function _yearFromPeriod(period) {
  const m = (period || '').match(/\d{4}/);
  return m ? parseInt(m[0]) : 0;
}

// Build a human-readable 2-month label like "Feb 2024 – Mar 2024".
function _twoMonthLabel(m1, y1, m2, y2) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1, 3);
  return `${cap(_MONTH_NAMES[m1 - 1])} ${y1} – ${cap(_MONTH_NAMES[m2 - 1])} ${y2}`;
}

// Map a single period string to its 2-month filing group key.
//   two_month_odd         → periods close on odd months  (Jan,Mar,May,Jul,Sep,Nov)
//                           pairs: Dec→Jan | Feb→Mar | Apr→May | Jun→Jul | Aug→Sep | Oct→Nov
//   two_month_even        → periods close on even months (Feb,Apr,Jun,Aug,Oct,Dec)
//                           pairs: Jan→Feb | Mar→Apr | May→Jun | Jul→Aug | Sep→Oct | Nov→Dec
//   two_month_odd_or_even → same grouping as two_month_odd (odd close months by default)
function _filingGroupKey(period, vatPeriod) {
  const month = _monthFromPeriod(period);
  const year  = _yearFromPeriod(period);
  if (!month || !year) return period;

  if (vatPeriod === 'two_month_odd' || vatPeriod === 'two_month_odd_or_even') {
    // Close month is odd; pair = (even, odd)
    if (month % 2 === 1) {
      // This is the closing month — pair with previous (even) month
      const pm = month === 1 ? 12 : month - 1;
      const py = month === 1 ? year - 1 : year;
      return _twoMonthLabel(pm, py, month, year);
    } else {
      // This is the opening month — pair with next (odd) month
      return _twoMonthLabel(month, year, month + 1, year);
    }
  }

  if (vatPeriod === 'two_month_even') {
    // Close month is even; pair = (odd, even)
    if (month % 2 === 0) {
      // Closing month — pair with previous (odd) month
      return _twoMonthLabel(month - 1, year, month, year);
    } else {
      // Opening month — pair with next (even) month
      const nm = month + 1;
      const ny = nm > 12 ? year + 1 : year;
      return _twoMonthLabel(month, year, nm > 12 ? 1 : nm, ny);
    }
  }

  return period; // fallback for monthly / unknown
}

// Get all periods that have VAT transactions, sorted chronologically.
function getVATPeriods(vatReport) {
  return Object.keys(vatReport.byPeriod).sort();
}

// vatPeriod: 'monthly' | 'two_month_odd' | 'two_month_even' | 'two_month_odd_or_even' | 'yearly'
// Returns the distinct filing period labels (already de-duped and sorted) that
// the VAT module should generate a VAT201 for.
function getFilingPeriods(allPeriods, vatPeriod) {
  if (vatPeriod === 'monthly') return allPeriods;
  if (vatPeriod === 'yearly')  return allPeriods.length > 0 ? ['Annual'] : [];

  // 2-month variants — collapse pairs into one label each
  const seen = new Set();
  const result = [];
  for (const p of allPeriods) {
    const key = _filingGroupKey(p, vatPeriod);
    if (!seen.has(key)) { seen.add(key); result.push(key); }
  }
  return result;
}

// ── VAT number validator ──────────────────────────────────────
// SA VAT numbers are 10 digits starting with 4.
function validateVATNumber(vatNumber) {
  const s = String(vatNumber || '').replace(/\s/g, '');
  if (!s) return { valid: false, error: 'VAT number is required.' };
  if (!/^\d{10}$/.test(s)) return { valid: false, error: 'SA VAT numbers are 10 digits.' };
  if (s[0] !== '4') return { valid: false, error: 'SA VAT numbers start with 4.' };
  return { valid: true, error: null };
}

// ── VAT activation flow ───────────────────────────────────────
// Called when user enters a VAT number on a client.
// Returns the update payload for DB.Clients.update().
function activateVAT(vatNumber, vatPeriod) {
  const validation = validateVATNumber(vatNumber);
  if (!validation.valid) return { ok: false, error: validation.error };
  if (!vatPeriod) return { ok: false, error: 'Please select a VAT filing period.' };
  return {
    ok:     true,
    update: { vat_number: vatNumber.replace(/\s/g, ''), vat_active: true, vat_period: vatPeriod },
  };
}

// ── Format helpers ────────────────────────────────────────────
function fmtZAR(n) {
  const abs = Math.abs(n || 0);
  const formatted = abs.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n < 0 ? '(R ' : 'R ') + formatted + (n < 0 ? ')' : '');
}

// ============================================================
// EXPORTS
// ============================================================
window.VAT = {
  VAT_RATE,
  VAT_INCLUSIVE_FACTOR,
  extractVAT,
  exclusiveAmount,
  addVAT,
  applyVATToRow,
  applyVATToBatch,
  buildVATReport,
  buildVAT201,
  getVATPeriods,
  getFilingPeriods,
  validateVATNumber,
  activateVAT,
  fmtZAR,
  round2,
};

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
// '2monthly' groups consecutive pairs: Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec.
function _filingGroupKey(period, vatPeriod) {
  const month = _monthFromPeriod(period);
  const year  = _yearFromPeriod(period);
  if (!month || !year) return period;

  if (vatPeriod === '2monthly') {
    // Odd months open a pair, even months close it
    if (month % 2 === 1) {
      // Opening month — pair with the next (even) month
      return _twoMonthLabel(month, year, month + 1, year);
    } else {
      // Closing month — pair with the previous (odd) month
      return _twoMonthLabel(month - 1, year, month, year);
    }
  }

  return period; // fallback for monthly / unknown
}

// Get all periods that have VAT transactions, sorted chronologically.
function getVATPeriods(vatReport) {
  return Object.keys(vatReport.byPeriod).sort();
}

// vatPeriod: 'monthly' | '2monthly' | 'yearly'
// Returns the distinct filing period labels (de-duped, sorted) for the VAT report selector.
function getFilingPeriods(allPeriods, vatPeriod) {
  if (vatPeriod === 'monthly') return allPeriods;
  if (vatPeriod === 'yearly')  return allPeriods.length > 0 ? ['Annual'] : [];

  // 2monthly — collapse consecutive-month pairs
  const seen   = new Set();
  const result = [];
  for (const p of allPeriods) {
    const key = _filingGroupKey(p, vatPeriod);
    if (!seen.has(key)) { seen.add(key); result.push(key); }
  }
  return result;
}

// ── Enhanced VAT report ───────────────────────────────────────
// Builds a full line-by-line VAT report for the enhanced report view.
// transactions: all transactions for the client/year (already loaded)
// vatPeriod:    'monthly' | '2monthly' | 'yearly'
// periodFilter: null = full year, or a filing period label string
//
// Returns:
// {
//   ok, periodFilter, availablePeriods,
//   incomeLines, expenseLines,
//   totalIncomeInclusive, totalOutputVAT, totalIncomeExclusive,
//   totalExpensesInclusive, totalInputVAT, totalExpensesExclusive,
//   netVAT, isRefund
// }
function buildEnhancedVATReport(transactions, vatPeriod, periodFilter) {
  // Only transactions with VAT amounts
  const vatTxs = (transactions || []).filter(
    t => t.vat_type !== 'none' && (t.vat_amount || 0) > 0
  );

  // Assign each VAT transaction its filing group
  const withGroup = vatTxs.map(t => ({
    ...t,
    _group: vatPeriod === 'monthly' ? (t.period || '')
          : vatPeriod === 'yearly'  ? 'Annual'
          : _filingGroupKey(t.period || '', '2monthly'),
  }));

  // Distinct filing periods available (for the selector)
  const seen = new Set();
  const availablePeriods = [];
  for (const t of withGroup) {
    if (!seen.has(t._group)) { seen.add(t._group); availablePeriods.push(t._group); }
  }
  availablePeriods.sort();

  // Filter to the chosen period
  const filtered = periodFilter
    ? withGroup.filter(t => t._group === periodFilter)
    : withGroup;

  const outputTxs = filtered.filter(t => t.vat_type === 'output');
  const inputTxs  = filtered.filter(t => t.vat_type === 'input');

  const mkLine = t => ({
    date:        t.date,
    description: t.description,
    inclusive:   round2(Math.abs(t.amount)),
    vatAmount:   round2(t.vat_amount || 0),
    exclusive:   round2(Math.abs(t.amount) - (t.vat_amount || 0)),
  });

  const incomeLines  = outputTxs.map(mkLine);
  const expenseLines = inputTxs.map(mkLine);

  const totalIncomeInclusive   = round2(incomeLines.reduce((s, l) => s + l.inclusive, 0));
  const totalOutputVAT         = round2(incomeLines.reduce((s, l) => s + l.vatAmount, 0));
  const totalIncomeExclusive   = round2(incomeLines.reduce((s, l) => s + l.exclusive, 0));
  const totalExpensesInclusive = round2(expenseLines.reduce((s, l) => s + l.inclusive, 0));
  const totalInputVAT          = round2(expenseLines.reduce((s, l) => s + l.vatAmount, 0));
  const totalExpensesExclusive = round2(expenseLines.reduce((s, l) => s + l.exclusive, 0));
  const netVAT                 = round2(totalOutputVAT - totalInputVAT);

  return {
    ok: true,
    periodFilter: periodFilter || null,
    availablePeriods,
    incomeLines,  expenseLines,
    totalIncomeInclusive,  totalOutputVAT,  totalIncomeExclusive,
    totalExpensesInclusive, totalInputVAT,  totalExpensesExclusive,
    netVAT, isRefund: netVAT < 0,
  };
}

// ── VAT reconciliation (running statement of account) ─────────
// Chains every filing period's net VAT into a running balance — exactly
// what a VAT control account looks like on the Balance Sheet, assuming
// nothing has actually been paid to / refunded by SARS yet (the caller
// is responsible for confirming that; this function has no way to know
// about real-world settlements that never hit the bank statements).
// transactions: VAT-tagged transactions spanning as many years as needed
// (the caller must supply the full multi-year set — this module has no
// concept of "financial year").
// Returns { ok, rows: [{ period, sortKey, output, input, net, isRefund,
//   runningBalance, runningIsRefund }], totals: {...} }
function buildVATReconciliation(transactions, vatPeriod) {
  const vatTxs = (transactions || []).filter(t => t.vat_type !== 'none' && (t.vat_amount || 0) > 0);
  if (!vatTxs.length) return { ok: true, rows: [], totals: { output: 0, input: 0, net: 0 } };

  // Group by the transaction's actual DATE, not its stored `period` string —
  // a journal line's period is something like "JNL-1" (its journal number),
  // not a calendar month, so grouping by t.period alone splits a journal's
  // VAT into its own bogus bucket instead of merging it into the filing
  // period its date actually falls in.
  const monthAbbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const twoMonthLabel = (m0, y) => { // m0 = 0-based month of the PAIR START (even index: 0,2,4,6,8,10)
    return `${monthAbbr[m0]} ${y} – ${monthAbbr[m0+1]} ${y}`;
  };
  const groupOf = t => {
    const d = new Date(t.date);
    const m = d.getMonth(), y = d.getFullYear();
    if (vatPeriod === 'monthly') return `${monthAbbr[m]} ${y}`;
    if (vatPeriod === 'yearly')  return 'Annual';
    const pairStart = Math.floor(m / 2) * 2; // 2-monthly
    return twoMonthLabel(pairStart, y);
  };
  const sortKeyOf = t => {
    const d = new Date(t.date);
    return d.getFullYear() * 12 + d.getMonth();
  };

  const buckets = new Map(); // label -> { output, input, sortKey }
  for (const t of vatTxs) {
    const key = groupOf(t);
    if (!buckets.has(key)) buckets.set(key, { output: 0, input: 0, sortKey: sortKeyOf(t) });
    const b = buckets.get(key);
    if (t.vat_type === 'output') b.output = round2(b.output + t.vat_amount);
    else if (t.vat_type === 'input') b.input = round2(b.input + t.vat_amount);
    b.sortKey = Math.min(b.sortKey, sortKeyOf(t));
  }

  const periods = [...buckets.keys()].sort((a, b) => buckets.get(a).sortKey - buckets.get(b).sortKey);

  let running = 0;
  const rows = periods.map(period => {
    const b = buckets.get(period);
    const net = round2(b.output - b.input);
    running = round2(running + net);
    return {
      period,
      output: b.output,
      input: b.input,
      net,
      isRefund: net < 0,
      runningBalance: running,
      runningIsRefund: running < 0,
    };
  });

  const totals = {
    output: round2(rows.reduce((s, r) => s + r.output, 0)),
    input:  round2(rows.reduce((s, r) => s + r.input, 0)),
    net:    round2(rows.reduce((s, r) => s + r.net, 0)),
  };

  return { ok: true, rows, totals };
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
function activateVAT(vatNumber, vatPeriod, vatRegDate) {
  const validation = validateVATNumber(vatNumber);
  if (!validation.valid) return { ok: false, error: validation.error };
  if (!vatPeriod) return { ok: false, error: 'Please select a VAT filing period.' };
  return {
    ok:     true,
    update: {
      vat_number:            vatNumber.replace(/\s/g, ''),
      vat_active:            true,
      vat_period:            vatPeriod,
      vat_registration_date: vatRegDate || null,
    },
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
  buildEnhancedVATReport,
  buildVATReconciliation,
  getVATPeriods,
  getFilingPeriods,
  validateVATNumber,
  activateVAT,
  fmtZAR,
  round2,
};

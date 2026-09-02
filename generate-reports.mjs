import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const sb = createClient(
  'https://tdmvypmwibnqfhvqhzxs.supabase.co',
  'sb_publishable_BueRizNjkXMlAm4XOSnWfQ_omfe001x'
);

const REPORTS_DIR = join(import.meta.dirname, 'reports');

// ── Helpers ──────────────────────────────────────────────────────
const r2 = n => Math.round((n || 0) * 100) / 100;
const fmt = n => {
  const v = Math.round(n || 0);
  const abs = Math.abs(v);
  const s = abs.toLocaleString('en-ZA');
  return v < 0 ? `(R ${s})` : `R ${s}`;
};
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function fetchAll(qb) {
  let all = [], offset = 0;
  while (true) {
    const { data, error } = await qb.range(offset, offset + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return all;
}

// ── HTML Shell ───────────────────────────────────────────────────
function htmlShell(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, sans-serif; color: #1a1a1a; margin: 32px; font-size: 11pt; }
  h1 { color: #145A32; font-size: 1.3rem; margin-bottom: 4px; }
  h2 { color: #145A32; font-size: 1.05rem; border-bottom: 2px solid #145A32; padding-bottom: 4px; margin-top: 28px; }
  h3 { color: #1E8449; font-size: 0.95rem; margin-top: 20px; margin-bottom: 6px; }
  .sub { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 16px; }
  col.lbl { width: auto; } col.amt { width: 140px; }
  th { background: #145A32; color: #fff; padding: 8px 12px; font-size: 0.82rem; text-align: left; }
  th.r { text-align: right; }
  td { padding: 6px 12px; font-size: 0.85rem; border-bottom: 1px solid #e8e8e8; }
  td.r { text-align: right; white-space: nowrap; }
  tr.section td { font-weight: 700; color: #145A32; padding-top: 14px; border-bottom: 2px solid #145A32; }
  tr.subtotal td { font-weight: 600; background: #D4F5E2; }
  tr.total td { font-weight: 700; border-top: 2px solid #145A32; border-bottom: 2px double #145A32; }
  tr.indent td:first-child { padding-left: 24px; }
  .t-account { border: 2px solid #145A32; margin-bottom: 18px; page-break-inside: avoid; }
  .t-account .t-title { background: #145A32; color: #fff; padding: 6px 12px; font-weight: 700; font-size: 0.85rem; }
  .t-account table { margin: 0; }
  .t-account td { border: 1px solid #C8E6C9; padding: 4px 8px; font-size: 0.8rem; }
  .t-account td.r { width: 100px; }
  @media print { body { margin: 16px; } h1 { font-size: 1.1rem; } .page-break { page-break-before: always; } }
</style></head><body>${body}</body></html>`;
}

function header(clientName, reportTitle, periodStr) {
  return `<h1>${esc(clientName)}</h1>
<div style="font-weight:600;font-size:0.95rem;">${esc(reportTitle)}</div>
<div class="sub">${esc(periodStr)}<br><em>Figures in Rand</em></div>`;
}

// ── ITR12 Categories (commission earners) ────────────────────────
const ITR12_INCOME = [
  { code: 'ITR-INC-COMM', name: 'Commission received' },
  { code: 'ITR-INC-RENT', name: 'Rental income' },
  { code: 'ITR-INC-INT',  name: 'Interest received' },
  { code: 'ITR-INC-OTH',  name: 'Other income' },
];
const ITR12_EXPENSES = [
  { code: 'ITR-EXP-ACC', name: 'Accounting fees' },
  { code: 'ITR-EXP-ADV', name: 'Advertising' },
  { code: 'ITR-EXP-BNK', name: 'Bank charges' },
  { code: 'ITR-EXP-CEL', name: 'Cell phone' },
  { code: 'ITR-EXP-DEP', name: 'Depreciation' },
  { code: 'ITR-EXP-ENT', name: 'Entertainment' },
  { code: 'ITR-EXP-INS', name: 'Insurance' },
  { code: 'ITR-EXP-INT', name: 'Internet' },
  { code: 'ITR-EXP-LEG', name: 'Legal fees' },
  { code: 'ITR-EXP-OFF', name: 'Office expenses' },
  { code: 'ITR-EXP-HOM', name: 'Home office expenses' },
  { code: 'ITR-EXP-PRI', name: 'Printing & stationery' },
  { code: 'ITR-EXP-REP', name: 'Repairs & maintenance' },
  { code: 'ITR-EXP-SUB', name: 'Subscriptions' },
  { code: 'ITR-EXP-TEL', name: 'Telephone' },
  { code: 'ITR-EXP-TRV', name: 'Travel' },
  { code: 'ITR-EXP-OTH', name: 'Other expenses' },
];
const ITR12_PERSONAL = [
  { code: 'ITR-PERS-DRW', name: 'Drawings' },
  { code: 'ITR-PERS-P2P', name: 'Personal transfers' },
  { code: 'ITR-PERS-SAL', name: 'Salary (IRP5)' },
  { code: 'ITR-PERS-OTH', name: 'Other personal' },
];

// ── Commission Earner Reports ────────────────────────────────────
function buildCommissionReports(clientName, year, transactions, fye) {
  const sorted = [...transactions].sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
  const fyLabel = `FY${year}`;
  const periodStr = `Financial year ${year}`;

  // Net by account code
  const netByCode = {};
  for (const t of transactions) {
    const code = t.account_code || '_UNCLASSIFIED';
    netByCode[code] = r2((netByCode[code] || 0) + (parseFloat(t.amount) || 0));
  }

  // ── Income Statement ──
  const mapLines = (cats, invert) => cats.map(c => ({
    name: c.name, code: c.code,
    amount: Math.round(invert ? -(netByCode[c.code] || 0) : (netByCode[c.code] || 0))
  })).filter(l => l.amount !== 0);

  const incomeLines = mapLines(ITR12_INCOME, false);
  const expenseLines = mapLines(ITR12_EXPENSES, true);
  const personalLines = mapLines(ITR12_PERSONAL, true);
  const totalIncome = incomeLines.reduce((s, l) => s + l.amount, 0);
  const totalExpenses = expenseLines.reduce((s, l) => s + l.amount, 0);
  const netIncome = totalIncome - totalExpenses;
  const totalPersonal = personalLines.reduce((s, l) => s + l.amount, 0);

  let isBody = header(clientName, 'Income Statement', periodStr);
  isBody += `<table><col class="lbl"/><col class="amt"/>`;
  isBody += `<tr class="section"><td colspan="2">Income</td></tr>`;
  incomeLines.forEach(l => { isBody += `<tr class="indent"><td>${esc(l.name)}</td><td class="r">${fmt(l.amount)}</td></tr>`; });
  isBody += `<tr class="subtotal"><td>Total Income</td><td class="r">${fmt(totalIncome)}</td></tr>`;
  isBody += `<tr class="section"><td colspan="2">Expenses</td></tr>`;
  expenseLines.forEach(l => { isBody += `<tr class="indent"><td>${esc(l.name)}</td><td class="r">${fmt(l.amount)}</td></tr>`; });
  isBody += `<tr class="subtotal"><td>Total Expenses</td><td class="r">${fmt(totalExpenses)}</td></tr>`;
  isBody += `<tr class="total"><td>Net Income</td><td class="r">${fmt(netIncome)}</td></tr>`;
  isBody += `</table>`;

  // ── Cash Flow ──
  const cfOpIn = Math.round(transactions.filter(t => t.account_code && t.account_code.startsWith('ITR-INC')).reduce((s, t) => s + parseFloat(t.amount), 0));
  const cfOpOut = Math.round(transactions.filter(t => t.account_code && t.account_code.startsWith('ITR-EXP')).reduce((s, t) => s + parseFloat(t.amount), 0));
  const cfOpNet = cfOpIn + cfOpOut;
  const cfFin = Math.round(transactions.filter(t => t.account_code && t.account_code.startsWith('ITR-PERS')).reduce((s, t) => s + parseFloat(t.amount), 0));
  const cfUncl = Math.round(transactions.filter(t => !t.account_code).reduce((s, t) => s + parseFloat(t.amount), 0));
  const cfNet = cfOpNet + cfFin + cfUncl;

  let cfBody = header(clientName, 'Cash Flow Statement', periodStr);
  cfBody += `<table><col class="lbl"/><col class="amt"/>`;
  cfBody += `<tr class="section"><td colspan="2">Cash flows from operating activities</td></tr>`;
  cfBody += `<tr class="indent"><td>Cash receipts from income</td><td class="r">${fmt(cfOpIn)}</td></tr>`;
  cfBody += `<tr class="indent"><td>Cash paid for expenses</td><td class="r">${fmt(cfOpOut)}</td></tr>`;
  cfBody += `<tr class="subtotal"><td>Net cash from operating activities</td><td class="r">${fmt(cfOpNet)}</td></tr>`;
  cfBody += `<tr class="section"><td colspan="2">Cash flows from financing activities</td></tr>`;
  cfBody += `<tr class="indent"><td>Drawings / personal</td><td class="r">${fmt(cfFin)}</td></tr>`;
  cfBody += `<tr class="subtotal"><td>Net cash from financing activities</td><td class="r">${fmt(cfFin)}</td></tr>`;
  if (cfUncl !== 0) {
    cfBody += `<tr class="section"><td colspan="2">Unclassified</td></tr>`;
    cfBody += `<tr class="indent"><td>Unclassified transactions</td><td class="r">${fmt(cfUncl)}</td></tr>`;
  }
  cfBody += `<tr class="total"><td>Net cash movement</td><td class="r">${fmt(cfNet)}</td></tr>`;
  cfBody += `</table>`;

  // ── GL / T-Accounts ──
  const allCodes = [...new Set(transactions.map(t => t.account_code || '_UNCLASSIFIED'))].sort();
  const codeNames = {};
  [...ITR12_INCOME, ...ITR12_EXPENSES, ...ITR12_PERSONAL].forEach(c => { codeNames[c.code] = c.name; });
  codeNames['_UNCLASSIFIED'] = 'Unclassified';

  let glBody = header(clientName, 'General Ledger — T-Accounts', periodStr);
  for (const code of allCodes) {
    const codeTxs = transactions.filter(t => (t.account_code || '_UNCLASSIFIED') === code);
    const debits = codeTxs.filter(t => parseFloat(t.amount) < 0);
    const credits = codeTxs.filter(t => parseFloat(t.amount) >= 0);
    const totalDr = Math.round(debits.reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0));
    const totalCr = Math.round(credits.reduce((s, t) => s + parseFloat(t.amount), 0));

    glBody += `<div class="t-account">`;
    glBody += `<div class="t-title">${esc(codeNames[code] || code)} (${code})</div>`;
    glBody += `<table><tr><th style="width:50%;border-right:2px solid #145A32;">Debit (money out)</th><th style="width:50%;">Credit (money in)</th></tr>`;
    const maxRows = Math.max(debits.length, credits.length);
    for (let i = 0; i < maxRows; i++) {
      const dr = debits[i];
      const cr = credits[i];
      glBody += `<tr>`;
      glBody += `<td style="border-right:2px solid #C8E6C9;">${dr ? esc(dr.date) + ' ' + esc((dr.description||'').substring(0, 30)) + ' <span style="float:right;">' + fmt(Math.abs(parseFloat(dr.amount))) + '</span>' : ''}</td>`;
      glBody += `<td>${cr ? esc(cr.date) + ' ' + esc((cr.description||'').substring(0, 30)) + ' <span style="float:right;">' + fmt(parseFloat(cr.amount)) + '</span>' : ''}</td>`;
      glBody += `</tr>`;
    }
    glBody += `<tr style="font-weight:700;border-top:2px solid #145A32;">`;
    glBody += `<td style="border-right:2px solid #C8E6C9;">Total: ${fmt(totalDr)}</td>`;
    glBody += `<td>Total: ${fmt(totalCr)}</td></tr>`;
    glBody += `</table></div>`;
  }

  return {
    is: htmlShell(`${clientName} - Income Statement - ${fyLabel}`, isBody),
    cf: htmlShell(`${clientName} - Cash Flow - ${fyLabel}`, cfBody),
    gl: htmlShell(`${clientName} - General Ledger - ${fyLabel}`, glBody),
  };
}

// ── Company Reports ──────────────────────────────────────────────
function buildCompanyReports(clientName, year, transactions, coa, openingBalances) {
  const fyLabel = `FY${year}`;
  const periodStr = `Financial year ${year}`;
  const classified = transactions.filter(t => t.account_code);

  // Group by account
  const netByCode = {};
  for (const t of classified) {
    netByCode[t.account_code] = r2((netByCode[t.account_code] || 0) + (parseFloat(t.amount) || 0));
  }

  // Group COA by type
  const coaByType = {};
  for (const a of coa) {
    if (!coaByType[a.account_type]) coaByType[a.account_type] = [];
    coaByType[a.account_type].push(a);
  }

  // ── Income Statement ──
  const incomeAccts = (coaByType['income'] || []).sort((a, b) => a.account_code.localeCompare(b.account_code));
  const expenseAccts = (coaByType['expense'] || (coaByType['expenses'] || [])).sort((a, b) => a.account_code.localeCompare(b.account_code));
  const cosAccts = (coaByType['cost_of_sales'] || []).sort((a, b) => a.account_code.localeCompare(b.account_code));

  let totalIncome = 0, totalExpenses = 0, totalCOS = 0;
  let isBody = header(clientName, 'Income Statement', periodStr);
  isBody += `<table><col class="lbl"/><col class="amt"/>`;

  isBody += `<tr class="section"><td colspan="2">Revenue</td></tr>`;
  incomeAccts.forEach(a => {
    const amt = Math.round(-(netByCode[a.account_code] || 0));
    if (amt !== 0) { totalIncome += amt; isBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
  });
  isBody += `<tr class="subtotal"><td>Total Revenue</td><td class="r">${fmt(totalIncome)}</td></tr>`;

  if (cosAccts.length) {
    isBody += `<tr class="section"><td colspan="2">Cost of Sales</td></tr>`;
    cosAccts.forEach(a => {
      const amt = Math.round(netByCode[a.account_code] || 0);
      if (amt !== 0) { totalCOS += amt; isBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
    });
    isBody += `<tr class="subtotal"><td>Total Cost of Sales</td><td class="r">${fmt(totalCOS)}</td></tr>`;
    isBody += `<tr class="subtotal"><td>Gross Profit</td><td class="r">${fmt(totalIncome - totalCOS)}</td></tr>`;
  }

  isBody += `<tr class="section"><td colspan="2">Operating Expenses</td></tr>`;
  expenseAccts.forEach(a => {
    const amt = Math.round(netByCode[a.account_code] || 0);
    if (amt !== 0) { totalExpenses += amt; isBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
  });
  isBody += `<tr class="subtotal"><td>Total Expenses</td><td class="r">${fmt(totalExpenses)}</td></tr>`;
  const netProfit = totalIncome - totalCOS - totalExpenses;
  isBody += `<tr class="total"><td>Net Profit / (Loss)</td><td class="r">${fmt(netProfit)}</td></tr>`;
  isBody += `</table>`;

  // ── Balance Sheet ──
  const assetAccts = [...(coaByType['asset'] || []), ...(coaByType['non_current_asset'] || []), ...(coaByType['current_asset'] || [])].sort((a, b) => a.account_code.localeCompare(b.account_code));
  const liabAccts = [...(coaByType['liability'] || []), ...(coaByType['non_current_liability'] || []), ...(coaByType['current_liability'] || [])].sort((a, b) => a.account_code.localeCompare(b.account_code));
  const equityAccts = (coaByType['equity'] || []).sort((a, b) => a.account_code.localeCompare(b.account_code));

  const obByCode = {};
  (openingBalances || []).forEach(ob => { obByCode[ob.account_code] = parseFloat(ob.amount) || 0; });

  let totalAssets = 0, totalLiab = 0, totalEquity = 0;
  let bsBody = header(clientName, 'Balance Sheet', periodStr);
  bsBody += `<table><col class="lbl"/><col class="amt"/>`;

  bsBody += `<tr class="section"><td colspan="2">Assets</td></tr>`;
  assetAccts.forEach(a => {
    const amt = Math.round((obByCode[a.account_code] || 0) + (netByCode[a.account_code] || 0));
    if (amt !== 0) { totalAssets += amt; bsBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
  });
  bsBody += `<tr class="subtotal"><td>Total Assets</td><td class="r">${fmt(totalAssets)}</td></tr>`;

  bsBody += `<tr class="section"><td colspan="2">Equity</td></tr>`;
  equityAccts.forEach(a => {
    const amt = Math.round(-((obByCode[a.account_code] || 0) + (netByCode[a.account_code] || 0)));
    if (amt !== 0) { totalEquity += amt; bsBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
  });
  totalEquity += netProfit;
  bsBody += `<tr class="indent"><td>Retained earnings (current year)</td><td class="r">${fmt(netProfit)}</td></tr>`;
  bsBody += `<tr class="subtotal"><td>Total Equity</td><td class="r">${fmt(totalEquity)}</td></tr>`;

  bsBody += `<tr class="section"><td colspan="2">Liabilities</td></tr>`;
  liabAccts.forEach(a => {
    const amt = Math.round(-((obByCode[a.account_code] || 0) + (netByCode[a.account_code] || 0)));
    if (amt !== 0) { totalLiab += amt; bsBody += `<tr class="indent"><td>${esc(a.account_name)}</td><td class="r">${fmt(amt)}</td></tr>`; }
  });
  bsBody += `<tr class="subtotal"><td>Total Liabilities</td><td class="r">${fmt(totalLiab)}</td></tr>`;
  bsBody += `<tr class="total"><td>Total Equity and Liabilities</td><td class="r">${fmt(totalEquity + totalLiab)}</td></tr>`;
  bsBody += `</table>`;

  // ── Cash Flow ──
  const opTypes = new Set(['income', 'expense', 'expenses', 'cost_of_sales']);
  const invTypes = new Set(['asset', 'non_current_asset']);
  const finTypes = new Set(['liability', 'non_current_liability', 'current_liability', 'equity']);
  const coaTypeMap = {};
  coa.forEach(a => { coaTypeMap[a.account_code] = a.account_type; });

  let cfOp = 0, cfInv = 0, cfFin = 0;
  for (const [code, net] of Object.entries(netByCode)) {
    const type = coaTypeMap[code] || '';
    if (opTypes.has(type)) cfOp += net;
    else if (invTypes.has(type)) cfInv += net;
    else if (finTypes.has(type)) cfFin += net;
  }
  cfOp = Math.round(cfOp); cfInv = Math.round(cfInv); cfFin = Math.round(cfFin);
  const cfNet = cfOp + cfInv + cfFin;

  let cfBody = header(clientName, 'Cash Flow Statement', periodStr);
  cfBody += `<table><col class="lbl"/><col class="amt"/>`;
  cfBody += `<tr class="section"><td colspan="2">Operating activities</td></tr>`;
  cfBody += `<tr class="indent"><td>Net cash from operations</td><td class="r">${fmt(cfOp)}</td></tr>`;
  cfBody += `<tr class="section"><td colspan="2">Investing activities</td></tr>`;
  cfBody += `<tr class="indent"><td>Net cash from investing</td><td class="r">${fmt(cfInv)}</td></tr>`;
  cfBody += `<tr class="section"><td colspan="2">Financing activities</td></tr>`;
  cfBody += `<tr class="indent"><td>Net cash from financing</td><td class="r">${fmt(cfFin)}</td></tr>`;
  cfBody += `<tr class="total"><td>Net cash movement</td><td class="r">${fmt(cfNet)}</td></tr>`;
  cfBody += `</table>`;

  // ── GL / T-Accounts ──
  const allCodes = [...new Set(transactions.map(t => t.account_code).filter(Boolean))].sort();
  const coaNameMap = {};
  coa.forEach(a => { coaNameMap[a.account_code] = a.account_name; });

  let glBody = header(clientName, 'General Ledger — T-Accounts', periodStr);
  for (const code of allCodes) {
    const codeTxs = transactions.filter(t => t.account_code === code);
    const debits = codeTxs.filter(t => parseFloat(t.amount) > 0);
    const credits = codeTxs.filter(t => parseFloat(t.amount) <= 0);
    const totalDr = Math.round(debits.reduce((s, t) => s + parseFloat(t.amount), 0));
    const totalCr = Math.round(credits.reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0));

    glBody += `<div class="t-account">`;
    glBody += `<div class="t-title">${esc(coaNameMap[code] || code)} (${code})</div>`;
    glBody += `<table><tr><th style="width:50%;border-right:2px solid #145A32;">Debit</th><th style="width:50%;">Credit</th></tr>`;
    const maxRows = Math.max(debits.length, credits.length);
    for (let i = 0; i < maxRows; i++) {
      const dr = debits[i];
      const cr = credits[i];
      glBody += `<tr>`;
      glBody += `<td style="border-right:2px solid #C8E6C9;">${dr ? esc(dr.date) + ' ' + esc((dr.description||'').substring(0, 30)) + ' <span style="float:right;">' + fmt(parseFloat(dr.amount)) + '</span>' : ''}</td>`;
      glBody += `<td>${cr ? esc(cr.date) + ' ' + esc((cr.description||'').substring(0, 30)) + ' <span style="float:right;">' + fmt(Math.abs(parseFloat(cr.amount))) + '</span>' : ''}</td>`;
      glBody += `</tr>`;
    }
    glBody += `<tr style="font-weight:700;border-top:2px solid #145A32;">`;
    glBody += `<td style="border-right:2px solid #C8E6C9;">Total: ${fmt(totalDr)}</td>`;
    glBody += `<td>Total: ${fmt(totalCr)}</td></tr>`;
    glBody += `</table></div>`;
  }

  // Unclassified
  const unclTxs = transactions.filter(t => !t.account_code);
  if (unclTxs.length) {
    glBody += `<div class="t-account"><div class="t-title">Unclassified (${unclTxs.length} transactions)</div>`;
    glBody += `<table><tr><th>Date</th><th>Description</th><th class="r">Amount</th></tr>`;
    unclTxs.forEach(t => {
      glBody += `<tr><td>${esc(t.date)}</td><td>${esc((t.description||'').substring(0,50))}</td><td class="r">${fmt(parseFloat(t.amount))}</td></tr>`;
    });
    glBody += `</table></div>`;
  }

  return {
    is: htmlShell(`${clientName} - Income Statement - ${fyLabel}`, isBody),
    bs: htmlShell(`${clientName} - Balance Sheet - ${fyLabel}`, bsBody),
    cf: htmlShell(`${clientName} - Cash Flow - ${fyLabel}`, cfBody),
    gl: htmlShell(`${clientName} - General Ledger - ${fyLabel}`, glBody),
  };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching clients...');
  const { data: clients } = await sb.from('clients').select('*');

  mkdirSync(join(REPORTS_DIR, 'Individuals'), { recursive: true });
  mkdirSync(join(REPORTS_DIR, 'Companies'), { recursive: true });

  for (const c of clients) {
    const isIndividual = c.entity_type === 'commission_earner';
    const folder = isIndividual ? 'Individuals' : 'Companies';
    const safeName = c.name.replace(/[<>:"/\\|?*]/g, '_');
    const clientDir = join(REPORTS_DIR, folder, safeName);
    mkdirSync(clientDir, { recursive: true });

    // Find all years for this client
    const years = new Set();
    for (const y of ['2024','2025','2026','2027','FY2024','FY2025','FY2026','FY2027']) {
      const { count } = await sb.from('transactions').select('id', { count: 'exact', head: true }).eq('client_id', c.id).eq('financial_year', y);
      if (count > 0) years.add(y);
    }

    if (!years.size) {
      console.log(`  ${c.name}: no transaction data, skipping`);
      continue;
    }

    const { data: coa } = await sb.from('chart_of_accounts').select('*').eq('client_id', c.id);

    for (const year of [...years].sort()) {
      console.log(`  ${c.name} — ${year}...`);
      const yearDir = join(clientDir, year.startsWith('FY') ? year : `FY${year}`);
      mkdirSync(yearDir, { recursive: true });

      const txs = await fetchAll(
        sb.from('transactions').select('*').eq('client_id', c.id).eq('financial_year', year).order('date').order('id')
      );

      if (isIndividual) {
        const reports = buildCommissionReports(c.name, year, txs, c.financial_year_end);
        writeFileSync(join(yearDir, 'Income_Statement.html'), reports.is);
        writeFileSync(join(yearDir, 'Cash_Flow.html'), reports.cf);
        writeFileSync(join(yearDir, 'General_Ledger.html'), reports.gl);
        console.log(`    ✓ IS, CF, GL (${txs.length} txs)`);
      } else {
        const { data: ob } = await sb.from('opening_balances').select('*').eq('client_id', c.id).eq('financial_year', year);
        const reports = buildCompanyReports(c.name, year, txs, coa, ob);
        writeFileSync(join(yearDir, 'Income_Statement.html'), reports.is);
        writeFileSync(join(yearDir, 'Balance_Sheet.html'), reports.bs);
        writeFileSync(join(yearDir, 'Cash_Flow.html'), reports.cf);
        writeFileSync(join(yearDir, 'General_Ledger.html'), reports.gl);
        console.log(`    ✓ IS, BS, CF, GL (${txs.length} txs)`);
      }
    }
  }

  // ── Export raw data per client ──
  console.log('\nExporting client data...');
  for (const c of clients) {
    const isIndividual = c.entity_type === 'commission_earner';
    const folder = isIndividual ? 'Individuals' : 'Companies';
    const safeName = c.name.replace(/[<>:"/\\|?*]/g, '_');
    const dataDir = join(REPORTS_DIR, folder, safeName, 'data');
    mkdirSync(dataDir, { recursive: true });

    const txs = await fetchAll(
      sb.from('transactions').select('*').eq('client_id', c.id).order('date').order('id')
    );
    if (!txs.length) { console.log(`  ${c.name}: no data`); continue; }

    const { data: coa } = await sb.from('chart_of_accounts').select('*').eq('client_id', c.id);
    const { data: ob } = await sb.from('opening_balances').select('*').eq('client_id', c.id);

    writeFileSync(join(dataDir, 'transactions.json'), JSON.stringify(txs, null, 2));
    if (coa && coa.length) writeFileSync(join(dataDir, 'chart_of_accounts.json'), JSON.stringify(coa, null, 2));
    if (ob && ob.length) writeFileSync(join(dataDir, 'opening_balances.json'), JSON.stringify(ob, null, 2));

    // CSV of transactions
    const csvHeader = 'date,description,amount,balance,account_code,account_name,financial_year,period';
    const csvRows = txs.map(t =>
      [t.date, '"'+(t.description||'').replace(/"/g,'""')+'"', t.amount, t.balance, t.account_code||'', '"'+(t.account_name||'')+'"', t.financial_year, t.period||''].join(',')
    );
    writeFileSync(join(dataDir, 'transactions.csv'), csvHeader + '\n' + csvRows.join('\n'));

    console.log(`  ${c.name}: ${txs.length} txs, ${coa?.length||0} COA, ${ob?.length||0} OB`);
  }

  console.log('\n✓ All reports and data saved to:', REPORTS_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });

// ============================================================
// export.js — PDF and CSV export for all financial outputs
//
// PDF:  Uses the browser print API with a dedicated #print-target
//       element that is shown only during print. No external lib.
// CSV:  Builds comma-separated strings and triggers a download.
//
// All exports include client name, financial year, and date stamp.
// Amounts use the South African locale (R 1 234.56).
// ============================================================

// ── Shared helpers ────────────────────────────────────────────

function todayDMY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function fmtNum(n) {
  return (n || 0).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Escape a single CSV cell value.
function csvCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Convert a 2D array to a CSV string.
function toCSV(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

// Trigger a file download in the browser.
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function safeFilename(str) {
  return String(str || '').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').slice(0, 40);
}

// ── Print / PDF ───────────────────────────────────────────────
// Injects HTML into #print-target and calls window.print().
// The target element is styled in styles.css to show only during print.

let _printTarget = null;

function getPrintTarget() {
  if (!_printTarget) {
    _printTarget = document.getElementById('print-target');
    if (!_printTarget) {
      _printTarget = document.createElement('div');
      _printTarget.id = 'print-target';
      document.body.appendChild(_printTarget);
    }
  }
  return _printTarget;
}

function printStatement(title, clientName, financialYear, period, bodyHTML) {
  const target = getPrintTarget();
  target.innerHTML = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;font-size:11pt;max-width:700px;margin:0 auto;">
      <div style="text-align:center;margin-bottom:28px;padding-bottom:14px;border-bottom:2px solid #111;">
        <div style="font-size:15pt;font-weight:800;margin-bottom:2px;">${escapeHTML(clientName)}</div>
        <div style="font-size:11pt;font-weight:700;margin-top:6px;">${escapeHTML(title)}</div>
        <div style="font-size:9pt;color:#555;margin-top:4px;">
          Financial year: ${escapeHTML(financialYear)}
          ${period ? ' &mdash; Period: ' + escapeHTML(period) : ''}
        </div>
        <div style="font-size:8.5pt;color:#888;margin-top:3px;">Generated: ${todayDMY()}</div>
      </div>
      ${bodyHTML}
    </div>`;
  window.print();
}

// Print the full financial pack (all statements on one print job).
function printFullPack(clientName, financialYear, pack) {
  const { IS, BS, CF, TB, VAT } = pack;
  const F = window.FinancialOutputs;

  let sections = [];

  if (IS && IS.ok) {
    sections.push(`<h2 style="font-size:12pt;font-weight:700;margin:28px 0 10px;page-break-before:auto;">Income Statement</h2>${F.renderIS(IS.data, null, false)}`);
  }
  if (BS && BS.ok) {
    sections.push(`<h2 style="font-size:12pt;font-weight:700;margin:28px 0 10px;page-break-before:always;">Balance Sheet</h2>${F.renderBS(BS.data, null)}`);
  }
  if (CF && CF.ok) {
    sections.push(`<h2 style="font-size:12pt;font-weight:700;margin:28px 0 10px;page-break-before:always;">Cash Flow Statement</h2>${F.renderCF(CF.data)}`);
  }
  if (TB && TB.ok) {
    sections.push(`<h2 style="font-size:12pt;font-weight:700;margin:28px 0 10px;page-break-before:always;">Trial Balance</h2>${F.renderTB(TB.data)}`);
  }
  if (VAT && VAT.outputVAT + VAT.inputVAT > 0) {
    const vat201 = window.VAT.buildVAT201(VAT, clientName, financialYear, null);
    sections.push(`<h2 style="font-size:12pt;font-weight:700;margin:28px 0 10px;page-break-before:always;">VAT Report</h2>${F.renderVATReport(vat201)}`);
  }

  printStatement('Financial Statements', clientName, financialYear, null, sections.join(''));
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── CSV exports ───────────────────────────────────────────────

function exportISCSV(data, clientName, financialYear) {
  const { incomeLines, cosLines, expLines,
          revenue, totalCOS, grossProfit, totalExpenses, netProfit,
          comparativeAvailable } = data;

  const header = comparativeAvailable
    ? ['Account', 'Description', 'Prior Year (R)', 'Current Year (R)']
    : ['Account', 'Description', 'Current Year (R)'];

  const rows = [
    [`${clientName} — Income Statement — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    header,
    ['', 'INCOME', '', ''],
  ];

  incomeLines.forEach(l => {
    rows.push(comparativeAvailable
      ? [l.code, l.name, fmtNum(l.comparative), fmtNum(l.current)]
      : [l.code, l.name, fmtNum(l.current)]);
  });
  rows.push(comparativeAvailable
    ? ['', 'Total Income', fmtNum(data.revComparative), fmtNum(revenue)]
    : ['', 'Total Income', fmtNum(revenue)]);

  if (cosLines.length > 0) {
    rows.push(['', 'COST OF SALES', '', '']);
    cosLines.forEach(l => {
      rows.push(comparativeAvailable
        ? [l.code, l.name, fmtNum(l.comparative), fmtNum(l.current)]
        : [l.code, l.name, fmtNum(l.current)]);
    });
    rows.push(comparativeAvailable
      ? ['', 'Total Cost of Sales', fmtNum(data.cosCom), fmtNum(totalCOS)]
      : ['', 'Total Cost of Sales', fmtNum(totalCOS)]);
  }

  rows.push(comparativeAvailable
    ? ['', 'GROSS PROFIT', fmtNum(data.grossProfitCom), fmtNum(grossProfit)]
    : ['', 'GROSS PROFIT', fmtNum(grossProfit)]);

  rows.push(['', 'EXPENSES', '', '']);
  expLines.forEach(l => {
    rows.push(comparativeAvailable
      ? [l.code, l.name, fmtNum(l.comparative), fmtNum(l.current)]
      : [l.code, l.name, fmtNum(l.current)]);
  });
  rows.push(comparativeAvailable
    ? ['', 'Total Expenses', fmtNum(data.expCom), fmtNum(totalExpenses)]
    : ['', 'Total Expenses', fmtNum(totalExpenses)]);

  rows.push(comparativeAvailable
    ? ['', netProfit >= 0 ? 'NET PROFIT' : 'NET LOSS', fmtNum(data.netProfitCom), fmtNum(netProfit)]
    : ['', netProfit >= 0 ? 'NET PROFIT' : 'NET LOSS', fmtNum(netProfit)]);

  const filename = `IS_${safeFilename(clientName)}_FY${financialYear}.csv`;
  downloadFile(toCSV(rows), filename, 'text/csv');
}

function exportBSCSV(data, clientName, financialYear) {
  const { assetLines, liabLines, equityLines,
          totalAssets, totalLiabilities, totalEquity, totalLiabEquity,
          comparativeAvailable } = data;

  const header = comparativeAvailable
    ? ['Account', 'Description', 'Prior Year (R)', 'Current Year (R)']
    : ['Account', 'Description', 'Current Year (R)'];

  const rows = [
    [`${clientName} — Balance Sheet — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    header,
  ];

  const addSection = (label, lines, total, totalCom) => {
    rows.push(['', label.toUpperCase(), '', '']);
    lines.forEach(l => {
      rows.push(comparativeAvailable
        ? [l.code, l.name, fmtNum(l.comparative), fmtNum(l.current)]
        : [l.code, l.name, fmtNum(l.current)]);
    });
    rows.push(comparativeAvailable
      ? ['', `Total ${label}`, fmtNum(totalCom), fmtNum(total)]
      : ['', `Total ${label}`, fmtNum(total)]);
    rows.push([]);
  };

  addSection('Assets',      assetLines, totalAssets,      data.assetsCom);
  addSection('Liabilities', liabLines,  totalLiabilities, data.liabCom);
  addSection('Equity',      equityLines,totalEquity,      data.equityCom);

  rows.push(comparativeAvailable
    ? ['', 'TOTAL LIABILITIES & EQUITY', fmtNum(data.liabCom + data.equityCom), fmtNum(totalLiabEquity)]
    : ['', 'TOTAL LIABILITIES & EQUITY', fmtNum(totalLiabEquity)]);

  downloadFile(toCSV(rows), `BS_${safeFilename(clientName)}_FY${financialYear}.csv`, 'text/csv');
}

function exportCFCSV(data, clientName, financialYear) {
  const { opLines, operating, invLines, investing,
          finLines, financing, netMovement, bankOB, closingBankBalance } = data;

  const rows = [
    [`${clientName} — Cash Flow Statement — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    ['Section', 'Description', 'Amount (R)'],
    ['Operating Activities', '', ''],
  ];

  opLines.forEach(l => rows.push(['', l.name, fmtNum(l.amount)]));
  rows.push(['', 'Net cash from operating activities', fmtNum(operating)]);
  rows.push([]);
  rows.push(['Investing Activities', '', '']);
  invLines.forEach(l => rows.push(['', l.name, fmtNum(l.amount)]));
  rows.push(['', 'Net cash from investing activities', fmtNum(investing)]);
  rows.push([]);
  rows.push(['Financing Activities', '', '']);
  finLines.forEach(l => rows.push(['', l.name, fmtNum(l.amount)]));
  rows.push(['', 'Net cash from financing activities', fmtNum(financing)]);
  rows.push([]);
  rows.push(['', 'Net movement in cash', fmtNum(netMovement)]);
  rows.push(['', 'Opening bank balance', fmtNum(bankOB)]);
  rows.push(['', 'Closing bank balance', fmtNum(closingBankBalance)]);

  downloadFile(toCSV(rows), `CF_${safeFilename(clientName)}_FY${financialYear}.csv`, 'text/csv');
}

function exportTBCSV(data, clientName, financialYear) {
  const {
    incomeLines, cosLines, expLines,
    grossIncome, totalCOS, grossProfit, totalExpenses, netProfit,
    assetLines, liabLines, equityLines,
    totalAssets, totalLiabilities, totalEquity, balanceEffect,
    totalDebits, totalCredits,
  } = data;

  const lr  = l  => [l.code, l.name, l.debit ? fmtNum(l.debit) : '', l.credit ? fmtNum(l.credit) : ''];
  const dr  = (lbl, amt) => ['', lbl, amt >= 0 ? '' : fmtNum(Math.abs(amt)), amt >= 0 ? fmtNum(amt) : ''];
  const sub = (lbl, drAmt, crAmt) => ['', lbl, drAmt != null ? fmtNum(drAmt) : '', crAmt != null ? fmtNum(crAmt) : ''];

  const rows = [
    [`${clientName} — Trial Balance — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    ['Account Code', 'Account Name', 'Debit (R)', 'Credit (R)'],
    [],
    ['', 'SECTION 1 — INCOME STATEMENT ACCOUNTS', '', ''],
    ['', 'Income', '', ''],
  ];
  incomeLines.forEach(l => rows.push(lr(l)));
  rows.push(sub('Gross Income', null, grossIncome));

  rows.push(['', 'Cost of Sales', '', '']);
  cosLines.forEach(l => rows.push(lr(l)));
  rows.push(dr(grossProfit >= 0 ? 'Gross Profit' : 'Gross Loss', grossProfit));

  rows.push(['', 'Expenses', '', '']);
  expLines.forEach(l => rows.push(lr(l)));
  rows.push(dr(netProfit >= 0 ? 'Net Profit' : 'Net Loss', netProfit));

  rows.push([]);
  rows.push(['', 'SECTION 2 — BALANCE SHEET ACCOUNTS', '', '']);
  rows.push(['', 'Assets (including Bank)', '', '']);
  assetLines.forEach(l => rows.push(lr(l)));
  rows.push(sub('Total Assets', totalAssets, null));

  rows.push(['', 'Liabilities', '', '']);
  liabLines.forEach(l => rows.push(lr(l)));
  rows.push(sub('Total Liabilities', null, totalLiabilities));

  rows.push(['', 'Equity', '', '']);
  equityLines.forEach(l => rows.push(lr(l)));
  rows.push(sub('Total Equity', null, totalEquity));

  const beOk = Math.abs(balanceEffect) <= 0.02;
  rows.push(dr(beOk ? 'Balance Effect — Balance Sheet balances' : 'Balance Effect — IMBALANCE', beOk ? 0 : balanceEffect));

  rows.push([]);
  rows.push(['', 'GRAND TOTAL', fmtNum(totalDebits), fmtNum(totalCredits)]);

  downloadFile(toCSV(rows), `TB_${safeFilename(clientName)}_FY${financialYear}.csv`, 'text/csv');
}

function exportVATCSV(vat201, clientName, financialYear) {
  const { field1, field4A, field15, field17, field20,
          grossSales, grossPurchases, outputRows, inputRows,
          isRefund, label, byPeriod } = vat201;

  const rows = [
    [`${clientName} — VAT Report — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    ['Field', 'Description', 'Amount (R)'],
    ['1',   'Standard-rated supplies (excl. VAT)', fmtNum(field1)],
    ['4A',  'Output VAT at 15%',                   fmtNum(field4A)],
    [],
    ['15',  'Standard-rated purchases (excl. VAT)', fmtNum(field15)],
    ['17',  'Input VAT at 15%',                     fmtNum(field17)],
    [],
    ['20',  label,                                  fmtNum(Math.abs(field20))],
    [],
    ['PERIOD BREAKDOWN', '', ''],
    ['Period', 'Output VAT', 'Input VAT', 'Net VAT'],
  ];

  Object.keys(byPeriod).sort().forEach(p => {
    const pb = byPeriod[p];
    rows.push([p, fmtNum(pb.outputVAT), fmtNum(pb.inputVAT), fmtNum(pb.netVAT)]);
  });

  rows.push([]);
  rows.push(['TRANSACTION DETAIL — OUTPUT VAT', '', '', '']);
  rows.push(['Date', 'Description', 'Inclusive Amount (R)', 'VAT Amount (R)']);
  outputRows.forEach(t => {
    rows.push([t.date, t.description, fmtNum(Math.abs(t.amount)), fmtNum(t.vat_amount)]);
  });

  rows.push([]);
  rows.push(['TRANSACTION DETAIL — INPUT VAT', '', '', '']);
  rows.push(['Date', 'Description', 'Inclusive Amount (R)', 'VAT Amount (R)']);
  inputRows.forEach(t => {
    rows.push([t.date, t.description, fmtNum(Math.abs(t.amount)), fmtNum(t.vat_amount)]);
  });

  downloadFile(toCSV(rows), `VAT_${safeFilename(clientName)}_FY${financialYear}.csv`, 'text/csv');
}

function exportCommissionISCSV(data, clientName, financialYear) {
  const { incomeLines, expenseLines, totalIncome, totalExpenses, netIncome,
          overrideActive, overrideAmount, bankIncome,
          hoSplitActive, hoSplitData } = data;

  const rows = [
    [`${clientName} — Commission Earner Income Statement — FY${financialYear} — Generated ${todayDMY()}`],
    [`For use with SARS ITR12 return`],
  ];

  // Income override note
  if (overrideActive) {
    rows.push([]);
    rows.push(['NOTE: Income override active']);
    rows.push(['Bank statement income (from transactions)', fmtNum(bankIncome)]);
    rows.push(['Manually entered income (used in this statement)', fmtNum(overrideAmount)]);
    rows.push(['Difference', fmtNum((overrideAmount || 0) - (bankIncome || 0))]);
  }

  // Home office split note
  if (hoSplitActive && hoSplitData) {
    const { fullAmount, businessAmount, personalAmount, pct } = hoSplitData;
    rows.push([]);
    rows.push([`NOTE: Home office split — ${pct}% business use`]);
    rows.push(['Full home office expenses', fmtNum(fullAmount)]);
    rows.push([`Business portion (${pct}%) — on this statement`, fmtNum(businessAmount)]);
    rows.push([`Personal portion (${Math.round(100 - pct)}%) — excluded`, fmtNum(personalAmount)]);
  }

  rows.push([]);
  rows.push(['ITR12 Code', 'Category', 'Amount (R)']);
  rows.push(['', 'INCOME', '']);
  incomeLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.amount)]));
  rows.push(['', 'Total Income', fmtNum(totalIncome)]);
  rows.push([]);
  rows.push(['', 'EXPENSES', '']);
  expenseLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.amount)]));
  rows.push(['', 'Total Expenses', fmtNum(totalExpenses)]);
  rows.push([]);
  rows.push(['', netIncome >= 0 ? 'NET INCOME' : 'NET LOSS', fmtNum(netIncome)]);

  downloadFile(
    toCSV(rows),
    `CommissionIS_${safeFilename(clientName)}_FY${financialYear}.csv`,
    'text/csv'
  );
}

// ── Full financial pack CSV (one zip-like multi-sheet CSV) ────
// Since browsers can't create zip files without a library,
// we export a single combined CSV with clear section separators.
function exportFullPackCSV(pack, clientName, financialYear) {
  const { IS, BS, CF, TB } = pack;
  const sep = ['', '========================================', ''];

  let rows = [
    [`FULL FINANCIAL PACK — ${clientName} — FY${financialYear} — Generated ${todayDMY()}`],
    [],
  ];

  const buildSection = (title, buildFn) => {
    rows.push(['', `=== ${title} ===`, '']);
    buildFn();
    rows.push(...sep);
  };

  // Inline build functions that push to rows array
  if (IS && IS.ok) {
    buildSection('INCOME STATEMENT', () => {
      const d = IS.data;
      rows.push(['Account', 'Description', 'Current Year (R)']);
      d.incomeLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      rows.push(['', 'Total Income', fmtNum(d.revenue)]);
      d.cosLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      if (d.cosLines.length) rows.push(['', 'Total Cost of Sales', fmtNum(d.totalCOS)]);
      rows.push(['', 'Gross Profit', fmtNum(d.grossProfit)]);
      d.expLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      rows.push(['', 'Total Expenses', fmtNum(d.totalExpenses)]);
      rows.push(['', d.isLoss ? 'NET LOSS' : 'NET PROFIT', fmtNum(d.netProfit)]);
    });
  }

  if (BS && BS.ok) {
    buildSection('BALANCE SHEET', () => {
      const d = BS.data;
      rows.push(['Account', 'Description', 'Current Year (R)']);
      d.assetLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      rows.push(['', 'Total Assets', fmtNum(d.totalAssets)]);
      d.liabLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      rows.push(['', 'Total Liabilities', fmtNum(d.totalLiabilities)]);
      d.equityLines.forEach(l => rows.push([l.code, l.name, fmtNum(l.current)]));
      rows.push(['', 'Total Equity', fmtNum(d.totalEquity)]);
      rows.push(['', 'Total Liabilities & Equity', fmtNum(d.totalLiabEquity)]);
    });
  }

  if (CF && CF.ok) {
    buildSection('CASH FLOW STATEMENT', () => {
      const d = CF.data;
      rows.push(['Section', 'Description', 'Amount (R)']);
      d.opLines.forEach(l => rows.push(['Operating', l.name, fmtNum(l.amount)]));
      rows.push(['', 'Net operating', fmtNum(d.operating)]);
      d.invLines.forEach(l => rows.push(['Investing', l.name, fmtNum(l.amount)]));
      rows.push(['', 'Net investing', fmtNum(d.investing)]);
      d.finLines.forEach(l => rows.push(['Financing', l.name, fmtNum(l.amount)]));
      rows.push(['', 'Net financing', fmtNum(d.financing)]);
      rows.push(['', 'Net movement in cash', fmtNum(d.netMovement)]);
      rows.push(['', 'Closing bank balance', fmtNum(d.closingBankBalance)]);
    });
  }

  if (TB && TB.ok) {
    buildSection('TRIAL BALANCE', () => {
      const d  = TB.data;
      const lr = l  => [l.code, l.name, l.debit ? fmtNum(l.debit) : '', l.credit ? fmtNum(l.credit) : ''];
      const dr = (lbl, amt) => ['', lbl, amt >= 0 ? '' : fmtNum(Math.abs(amt)), amt >= 0 ? fmtNum(amt) : ''];
      const sb = (lbl, drA, crA) => ['', lbl, drA != null ? fmtNum(drA) : '', crA != null ? fmtNum(crA) : ''];

      rows.push(['Account Code', 'Account Name', 'Debit (R)', 'Credit (R)']);
      rows.push(['', 'SECTION 1 — INCOME STATEMENT ACCOUNTS', '', '']);
      rows.push(['', 'Income', '', '']);
      d.incomeLines.forEach(l => rows.push(lr(l)));
      rows.push(sb('Gross Income', null, d.grossIncome));
      rows.push(['', 'Cost of Sales', '', '']);
      d.cosLines.forEach(l => rows.push(lr(l)));
      rows.push(dr(d.grossProfit >= 0 ? 'Gross Profit' : 'Gross Loss', d.grossProfit));
      rows.push(['', 'Expenses', '', '']);
      d.expLines.forEach(l => rows.push(lr(l)));
      rows.push(dr(d.netProfit >= 0 ? 'Net Profit' : 'Net Loss', d.netProfit));
      rows.push([]);
      rows.push(['', 'SECTION 2 — BALANCE SHEET ACCOUNTS', '', '']);
      rows.push(['', 'Assets', '', '']);
      d.assetLines.forEach(l => rows.push(lr(l)));
      rows.push(sb('Total Assets', d.totalAssets, null));
      rows.push(['', 'Liabilities', '', '']);
      d.liabLines.forEach(l => rows.push(lr(l)));
      rows.push(sb('Total Liabilities', null, d.totalLiabilities));
      rows.push(['', 'Equity', '', '']);
      d.equityLines.forEach(l => rows.push(lr(l)));
      rows.push(sb('Total Equity', null, d.totalEquity));
      const beOk = Math.abs(d.balanceEffect) <= 0.02;
      rows.push(dr(beOk ? 'Balance Effect — balances' : 'Balance Effect — IMBALANCE', beOk ? 0 : d.balanceEffect));
      rows.push([]);
      rows.push(['', 'GRAND TOTAL', fmtNum(d.totalDebits), fmtNum(d.totalCredits)]);
    });
  }

  downloadFile(
    toCSV(rows),
    `FinancialPack_${safeFilename(clientName)}_FY${financialYear}.csv`,
    'text/csv'
  );
}

// ── Transaction ledger export (raw cashbook) ──────────────────
function exportTransactionsCSV(transactions, clientName, financialYear) {
  const rows = [
    [`${clientName} — Transaction Ledger — FY${financialYear} — Generated ${todayDMY()}`],
    [],
    ['Date', 'Description', 'Amount (R)', 'Balance (R)', 'Account Code', 'Account Name', 'VAT Type', 'VAT Amount (R)', 'Period', 'Bank'],
  ];

  transactions.forEach(t => {
    rows.push([
      t.date,
      t.description,
      fmtNum(t.amount),
      t.balance !== null ? fmtNum(t.balance) : '',
      t.account_code  || '',
      t.account_name  || '',
      t.vat_type      || 'none',
      fmtNum(t.vat_amount || 0),
      t.period,
      t.source_bank,
    ]);
  });

  downloadFile(
    toCSV(rows),
    `Ledger_${safeFilename(clientName)}_FY${financialYear}.csv`,
    'text/csv'
  );
}

function exportEnhancedVATCSV(data, clientName, financialYear) {
  const {
    incomeLines, expenseLines,
    totalIncomeInclusive, totalOutputVAT, totalIncomeExclusive,
    totalExpensesInclusive, totalInputVAT, totalExpensesExclusive,
    netVAT, isRefund, periodFilter,
  } = data;

  const periodLabel = periodFilter || 'Full year';
  const rows = [
    [`${clientName} — VAT Report — FY${financialYear} — ${periodLabel} — Generated ${todayDMY()}`],
    [],
    ['SECTION 1 — INCOME (OUTPUT VAT)', '', '', ''],
    ['Date', 'Description', 'Inclusive (R)', 'VAT (R)', 'Exclusive (R)'],
  ];

  incomeLines.forEach(l => rows.push([l.date, l.description, fmtNum(l.inclusive), fmtNum(l.vatAmount), fmtNum(l.exclusive)]));
  rows.push(['', 'TOTAL INCOME', fmtNum(totalIncomeInclusive), fmtNum(totalOutputVAT), fmtNum(totalIncomeExclusive)]);

  rows.push([]);
  rows.push(['SECTION 2 — EXPENSES (INPUT VAT)', '', '', '']);
  rows.push(['Date', 'Description', 'Inclusive (R)', 'VAT (R)', 'Exclusive (R)']);
  expenseLines.forEach(l => rows.push([l.date, l.description, fmtNum(l.inclusive), fmtNum(l.vatAmount), fmtNum(l.exclusive)]));
  rows.push(['', 'TOTAL EXPENSES', fmtNum(totalExpensesInclusive), fmtNum(totalInputVAT), fmtNum(totalExpensesExclusive)]);

  rows.push([]);
  rows.push(['VAT SUMMARY', '', '', '']);
  rows.push(['Output VAT (Section 1)', '', fmtNum(totalOutputVAT), '']);
  rows.push(['Less: Input VAT (Section 2)', '', fmtNum(totalInputVAT), '']);
  rows.push([isRefund ? 'VAT Refund Due from SARS' : 'Net VAT Payable to SARS', '', fmtNum(Math.abs(netVAT)), '']);

  downloadFile(toCSV(rows), `VAT_${safeFilename(clientName)}_FY${financialYear}_${safeFilename(periodLabel)}.csv`, 'text/csv');
}

// ── Tax Tjom handoff CSV ──────────────────────────────────────
// Column structure matches Tax Tjom's import expectations.
// Exports commission earner IS in Tax Tjom-compatible format.
function exportTaxTjomHandoff(commissionISData, clientName, financialYear) {
  const { incomeLines, expenseLines, totalIncome, totalExpenses, netIncome } = commissionISData;

  const rows = [
    ['name', 'id number', 'employee type', 'tax year', 'age group',
     '3601', '3713', '3701', '4001', '4003', '4141', '4142'],
    [
      clientName,
      '',
      'commission',
      financialYear,
      'under65',
      '0',  // 3601 salary
      '0',  // 3713 travel allowance
      fmtNum(totalIncome),  // 3701 commission
      '0',  // 4001 pension
      '0',  // 4003 RA
      '0',  // 4141 PAYE
      '0',  // 4142 PAYE ETI
    ],
    [],
    ['ITR12 Expense Detail (for manual entry in Tax Tjom)', '', '', '', '', '', '', '', '', '', '', ''],
    ['ITR12 Code', 'Category', 'Amount (R)', '', '', '', '', '', '', '', '', ''],
  ];

  expenseLines.forEach(l => {
    rows.push([l.code, l.name, fmtNum(l.amount), '', '', '', '', '', '', '', '', '']);
  });
  rows.push(['', 'Total Expenses', fmtNum(totalExpenses), '', '', '', '', '', '', '', '', '']);
  rows.push(['', 'Net Income', fmtNum(netIncome), '', '', '', '', '', '', '', '', '']);

  downloadFile(
    toCSV(rows),
    `TaxTjomHandoff_${safeFilename(clientName)}_FY${financialYear}.csv`,
    'text/csv'
  );
}

// ============================================================
// EXPORTS
// ============================================================
window.Export = {
  printStatement,
  printFullPack,
  exportISCSV,
  exportBSCSV,
  exportCFCSV,
  exportTBCSV,
  exportVATCSV,
  exportCommissionISCSV,
  exportEnhancedVATCSV,
  exportFullPackCSV,
  exportTransactionsCSV,
  exportTaxTjomHandoff,
  // Utilities exposed for testing
  toCSV,
  todayDMY,
  fmtNum,
};

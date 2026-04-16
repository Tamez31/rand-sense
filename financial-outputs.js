// ============================================================
// financial-outputs.js — Financial statement calculations
//
// Builds all five outputs from classified transaction data:
//   1. Income Statement (IS)
//   2. Balance Sheet (BS)
//   3. Cash Flow Statement (CF)
//   4. VAT Report  (VAT) — delegates to vat-module.js
//   5. Trial Balance (TB)
//
// Also handles Commission Earner ITR12 income statement.
//
// Convention:
//   amount > 0  =  money received  (credit to income / debit to asset)
//   amount < 0  =  money paid out  (debit to expense / credit to liability)
//
// All amounts are rounded to 2 decimal places throughout.
// A statement must balance before export is allowed.
// ============================================================

const r2 = n => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

// ── ZAR formatter ─────────────────────────────────────────────
function fmt(n) {
  const abs = Math.abs(n || 0);
  const s   = abs.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '(' : '') + 'R\u00a0' + s + (n < 0 ? ')' : '');
}

// ── Net balance per account code from a transaction array ─────
// Returns a Map: accountCode → { name, type, net }
// net = sum of all amounts for that code (positive or negative)
function netByAccount(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (!t.account_code) continue;
    const key = t.account_code;
    if (!map.has(key)) {
      map.set(key, { code: key, name: t.account_name || key, net: 0 });
    }
    map.get(key).net = r2(map.get(key).net + (t.amount || 0));
  }
  return map;
}

// ── Merge COA with transaction nets ──────────────────────────
// Returns array of { code, name, type, net, openingBalance }
// Includes all active COA accounts even if net is zero.
function mergeWithCOA(coa, txMap, openingMap) {
  return coa
    .filter(a => a.is_active)
    .map(a => {
      const tx = txMap.get(a.account_code);
      const ob = openingMap ? openingMap.get(a.account_code) : null;
      return {
        code:           a.account_code,
        name:           a.account_name,
        type:           a.account_type,
        net:            tx ? r2(tx.net) : 0,
        openingBalance: ob ? r2(ob.amount) : 0,
      };
    });
}

// ── Build opening balance map ─────────────────────────────────
function buildOpeningMap(openingBalances) {
  const map = new Map();
  for (const ob of (openingBalances || [])) {
    map.set(ob.account_code, ob);
  }
  return map;
}

// ============================================================
// 1. INCOME STATEMENT
// ============================================================
// transactions:    classified transactions for the year
// coa:             client's chart of accounts
// openingBalances: prior year closing balances (for comparative)
// hideZeros:       if true, omit lines where current AND prior are 0
//
// Returns { ok, error, data }
// data = { income, costOfSales, expenses, grossProfit, netProfit,
//          revenue, totalExpenses, lines, comparativeAvailable }
function buildIncomeStatement(transactions, coa, openingBalances, hideZeros) {
  try {
    const txMap  = netByAccount(transactions);
    const obMap  = buildOpeningMap(openingBalances);
    const merged = mergeWithCOA(coa, txMap, obMap);

    const incomeLines = merged
      .filter(a => a.type === 'income')
      .map(a => ({
        ...a,
        current:     r2(a.net),
        comparative: r2(a.openingBalance),
      }))
      .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const cosLines = merged
      .filter(a => a.type === 'cost_of_sales')
      .map(a => ({
        ...a,
        // Cost of sales: money paid out (negative amounts) shown as positive expense
        current:     r2(-a.net),
        comparative: r2(-a.openingBalance),
      }))
      .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const expLines = merged
      .filter(a => a.type === 'expense')
      .map(a => ({
        ...a,
        current:     r2(-a.net),
        comparative: r2(-a.openingBalance),
      }))
      .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const revenue        = r2(incomeLines.reduce((s, l) => s + l.current, 0));
    const revComparative = r2(incomeLines.reduce((s, l) => s + l.comparative, 0));

    const totalCOS       = r2(cosLines.reduce((s, l) => s + l.current, 0));
    const cosCom         = r2(cosLines.reduce((s, l) => s + l.comparative, 0));

    const grossProfit    = r2(revenue - totalCOS);
    const grossProfitCom = r2(revComparative - cosCom);

    const totalExpenses  = r2(expLines.reduce((s, l) => s + l.current, 0));
    const expCom         = r2(expLines.reduce((s, l) => s + l.comparative, 0));

    const netProfit      = r2(grossProfit - totalExpenses);
    const netProfitCom   = r2(grossProfitCom - expCom);

    const comparativeAvailable = (openingBalances || []).length > 0;

    return {
      ok: true,
      data: {
        incomeLines,
        cosLines,
        expLines,
        revenue,       revComparative,
        totalCOS,      cosCom,
        grossProfit,   grossProfitCom,
        totalExpenses, expCom,
        netProfit,     netProfitCom,
        comparativeAvailable,
        isLoss:        netProfit < 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// 2. BALANCE SHEET
// ============================================================
// The bank account balance is recalculated from transactions.
// All other balances come from opening balances + IS net profit.
//
// Accounting equation check: Assets = Liabilities + Equity
function buildBalanceSheet(transactions, coa, openingBalances, netProfit, hideZeros) {
  try {
    const txMap  = netByAccount(transactions);
    const obMap  = buildOpeningMap(openingBalances);
    const merged = mergeWithCOA(coa, txMap, obMap);

    // Bank account: net of all transactions (all account types flow through bank)
    const bankTxNet = r2(transactions.reduce((s, t) => s + (t.amount || 0), 0));

    const buildLines = (type, invertSign) =>
      merged
        .filter(a => a.type === type)
        .map(a => {
          let current;
          // Bank accounts are special — use running transaction total
          if (a.code === '1001' || a.name.toLowerCase().includes('bank account')) {
            const obBankBalance = a.openingBalance || 0;
            current = r2(obBankBalance + bankTxNet);
          } else {
            // All other balance sheet accounts: opening balance + net movement
            current = r2(a.openingBalance + (invertSign ? -a.net : a.net));
          }
          const comparative = r2(a.openingBalance);
          return { ...a, current, comparative };
        })
        .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const assetLines     = buildLines('asset',     false);
    const liabLines      = buildLines('liability', false);
    const equityLines    = buildLines('equity',    false);

    // Add current year net profit to retained earnings / equity
    // We inject it as a synthetic line so it shows on the face
    const retainedLine = {
      code:        'NET-PROFIT',
      name:        netProfit >= 0 ? 'Net profit for the year' : 'Net loss for the year',
      type:        'equity',
      current:     r2(netProfit),
      comparative: 0,
      synthetic:   true,
    };
    if (netProfit !== 0) equityLines.push(retainedLine);

    const totalAssets      = r2(assetLines.reduce((s, l) => s + l.current, 0));
    const totalLiabilities = r2(liabLines.reduce((s, l) => s + l.current, 0));
    const totalEquity      = r2(equityLines.reduce((s, l) => s + l.current, 0));
    const totalLiabEquity  = r2(totalLiabilities + totalEquity);

    const assetsCom        = r2(assetLines.reduce((s, l) => s + l.comparative, 0));
    const liabCom          = r2(liabLines.reduce((s, l) => s + l.comparative, 0));
    const equityCom        = r2(equityLines.reduce((s, l) => s + l.comparative, 0));

    // Balance check: Assets must equal Liabilities + Equity
    const diff = r2(Math.abs(totalAssets - totalLiabEquity));
    const balanced = diff <= 0.02; // allow 2c rounding tolerance

    const comparativeAvailable = (openingBalances || []).length > 0;

    return {
      ok: true,
      balanced,
      diff,
      data: {
        assetLines,
        liabLines,
        equityLines,
        totalAssets,      assetsCom,
        totalLiabilities, liabCom,
        totalEquity,      equityCom,
        totalLiabEquity,
        comparativeAvailable,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// 3. CASH FLOW STATEMENT
// ============================================================
// Uses the direct method: categorise cash movements by account type.
//   Operating:  income + cost_of_sales + expense accounts
//   Investing:  asset accounts (PP&E, investments)
//   Financing:  liability + equity accounts (loans, drawings)
//
// Net cash movement = opening bank balance change
function buildCashFlow(transactions, coa, openingBalances) {
  try {
    const txMap = netByAccount(transactions);

    // Build a lookup: account_code → account_type from COA
    const typeByCode = new Map(coa.map(a => [a.account_code, a.account_type]));

    // Classify each transaction into operating / investing / financing
    let operating  = 0;
    let investing  = 0;
    let financing  = 0;
    let unclassified = 0;

    const opLines  = [];
    const invLines = [];
    const finLines = [];

    for (const [code, { name, net }] of txMap.entries()) {
      const type = typeByCode.get(code);
      switch (type) {
        case 'income':
        case 'cost_of_sales':
        case 'expense':
          operating = r2(operating + net);
          opLines.push({ code, name, amount: r2(net) });
          break;
        case 'asset':
          // Skip the bank account itself — it is the cash being explained
          if (code === '1001' || name.toLowerCase().includes('bank account')) break;
          investing = r2(investing + net);
          invLines.push({ code, name, amount: r2(net) });
          break;
        case 'liability':
        case 'equity':
          financing = r2(financing + net);
          finLines.push({ code, name, amount: r2(net) });
          break;
        default:
          unclassified = r2(unclassified + net);
      }
    }

    // Net cash movement = total of all transactions (change in bank balance)
    const netMovement = r2(transactions.reduce((s, t) => s + (t.amount || 0), 0));

    // Opening bank balance from opening balances
    const obMap = buildOpeningMap(openingBalances);
    const bankOB = (() => {
      // Find the bank account in opening balances
      for (const [code, ob] of obMap.entries()) {
        const coaEntry = coa.find(a => a.account_code === code);
        if (coaEntry && coaEntry.account_type === 'asset' &&
            (code === '1001' || coaEntry.account_name.toLowerCase().includes('bank'))) {
          return r2(ob.amount);
        }
      }
      return 0;
    })();

    const closingBankBalance = r2(bankOB + netMovement);

    // Reconciliation: operating + investing + financing should = netMovement
    const reconciled = r2(Math.abs((operating + investing + financing) - netMovement)) <= 0.02;

    return {
      ok: true,
      data: {
        opLines,  operating,
        invLines, investing,
        finLines, financing,
        netMovement,
        bankOB,
        closingBankBalance,
        reconciled,
        unclassified,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// 4. TRIAL BALANCE
// ============================================================
// Lists every account with its net debit or credit balance.
// Sum of all debits must equal sum of all credits.
//
// Convention:
//   Assets + Expenses:          net > 0 = Debit,  net < 0 = Credit
//   Income + Liabilities + Equity: net > 0 = Credit, net < 0 = Debit
function buildTrialBalance(transactions, coa, hideZeros) {
  try {
    const txMap  = netByAccount(transactions);
    const merged = mergeWithCOA(coa, txMap, null);

    // Classify debit/credit per account type
    const DEBIT_NORMAL  = new Set(['asset', 'expense', 'cost_of_sales']);
    const CREDIT_NORMAL = new Set(['income', 'liability', 'equity']);

    const lines = merged
      .map(a => {
        const net = r2(a.net);
        let debit = 0, credit = 0;

        if (DEBIT_NORMAL.has(a.type)) {
          if (net >= 0) debit  = net;
          else          credit = Math.abs(net);
        } else if (CREDIT_NORMAL.has(a.type)) {
          if (net <= 0) debit  = Math.abs(net);
          else          credit = net;
        }

        return { ...a, net, debit: r2(debit), credit: r2(credit) };
      })
      .filter(a => !hideZeros || a.debit !== 0 || a.credit !== 0);

    const totalDebits  = r2(lines.reduce((s, l) => s + l.debit,  0));
    const totalCredits = r2(lines.reduce((s, l) => s + l.credit, 0));
    const balanced     = Math.abs(totalDebits - totalCredits) <= 0.02;
    const diff         = r2(Math.abs(totalDebits - totalCredits));

    // Sort by account code ascending
    lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    return {
      ok: true,
      balanced,
      diff,
      data: { lines, totalDebits, totalCredits },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// 5. COMMISSION EARNER — ITR12 INCOME STATEMENT
// ============================================================
// No COA. Uses hardcoded ITR12 category codes.
//
// incomeOverride (optional): { active: boolean, amount: number }
//   When active, the manually entered amount replaces the bank-derived
//   income total. The bank figure is retained in the output for reference.
//
// homeOfficeOptions (optional): { active: boolean, businessPct: string|number }
//   When active, ITR-EXP-HOM is split: only the business % appears on the
//   statement. Full amount and calculation are preserved for verification.
function buildCommissionIS(transactions, hideZeros, incomeOverride, homeOfficeOptions) {
  try {
    const txMap = netByAccount(transactions);

    const { ITR12_CATEGORIES } = window.RulesEngine;

    const mapLines = (cats) =>
      cats.map(cat => {
        const entry = txMap.get(cat.code);
        const net   = entry ? r2(entry.net) : 0;
        return { code: cat.code, name: cat.name, amount: net };
      });

    const bankIncomeLines = mapLines(ITR12_CATEGORIES.income);
    const bankIncome      = r2(bankIncomeLines.reduce((s, l) => s + l.amount, 0));

    // ── Income override ────────────────────────────────────────
    const ovActive = !!(incomeOverride && incomeOverride.active);
    const ovRaw    = ovActive ? parseFloat(String(incomeOverride.amount || '0').replace(/[^0-9.-]/g, '')) : 0;
    const ovAmount = ovActive && !isNaN(ovRaw) && ovRaw >= 0 ? r2(ovRaw) : 0;
    const useOverride = ovActive && !isNaN(ovRaw) && ovRaw >= 0;

    const displayIncomeLines = useOverride
      ? [{ code: 'MANUAL', name: 'Commission / Income (manually entered)', amount: ovAmount, isOverride: true }]
      : bankIncomeLines.filter(l => !hideZeros || l.amount !== 0);

    const totalIncome = useOverride ? ovAmount : r2(bankIncomeLines.reduce((s, l) => s + l.amount, 0));

    // ── Home office split ──────────────────────────────────────
    const hoActive  = !!(homeOfficeOptions && homeOfficeOptions.active);
    const hoPctRaw  = hoActive
      ? parseFloat(String(homeOfficeOptions.businessPct || '0').replace(/[^0-9.]/g, ''))
      : null;
    const hoPct     = hoActive && hoPctRaw !== null && !isNaN(hoPctRaw) && hoPctRaw >= 0 && hoPctRaw <= 100
      ? hoPctRaw : null;
    const useHOSplit = hoPct !== null;

    let hoSplitData = null; // populated when split fires on a non-zero HO line

    const expenseLines = mapLines(ITR12_CATEGORIES.expenses)
      .map(l => {
        let amount = r2(-l.amount); // negative tx amounts → positive display
        if (useHOSplit && l.code === 'ITR-EXP-HOM' && amount > 0) {
          const fullAmount     = amount;
          const businessAmount = r2(fullAmount * hoPct / 100);
          const personalAmount = r2(fullAmount - businessAmount);
          hoSplitData = { fullAmount, businessAmount, personalAmount, pct: hoPct };
          amount = businessAmount;
        }
        return { ...l, amount };
      })
      .filter(l => !hideZeros || l.amount !== 0);

    const totalExpenses = r2(expenseLines.reduce((s, l) => s + l.amount, 0));
    const netIncome     = r2(totalIncome - totalExpenses);

    return {
      ok: true,
      data: {
        incomeLines:      displayIncomeLines,
        bankIncomeLines,  // always preserved for reference and export notes
        bankIncome,
        expenseLines,
        totalIncome,
        totalExpenses,
        netIncome,
        isLoss:         netIncome < 0,
        overrideActive: useOverride,
        overrideAmount: useOverride ? ovAmount : null,
        hoSplitActive:  useHOSplit && hoSplitData !== null,
        hoSplitData,    // null when HO line is zero or split not active
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// FULL FINANCIAL PACK
// Runs all five outputs at once and returns them together.
// ============================================================
async function buildFullPack(clientId, financialYear, coa, hideZeros) {
  try {
    const [transactions, openingBalances] = await Promise.all([
      window.DB.Transactions.listByYear(clientId, financialYear),
      window.DB.OpeningBalances.list(clientId, financialYear),
    ]);

    const classified = transactions.filter(t => t.account_code);

    const IS  = buildIncomeStatement(classified, coa, openingBalances, hideZeros);
    const netProfit = IS.ok ? IS.data.netProfit : 0;
    const BS  = buildBalanceSheet(classified, coa, openingBalances, netProfit, hideZeros);
    const CF  = buildCashFlow(classified, coa, openingBalances);
    const TB  = buildTrialBalance(classified, coa, hideZeros);
    const VAT = window.VAT.buildVATReport(transactions, null);

    return { ok: true, IS, BS, CF, TB, VAT, transactions, classified, openingBalances };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// HTML RENDERERS
// Each renderer returns an HTML string for injection into the DOM.
// ============================================================

function renderIS(data, comparativeLabel, hideZeros) {
  const { incomeLines, cosLines, expLines,
          revenue, revComparative,
          totalCOS, cosCom,
          grossProfit, grossProfitCom,
          totalExpenses, expCom,
          netProfit, netProfitCom,
          comparativeAvailable } = data;

  const showComp = comparativeAvailable;
  const col = showComp
    ? `<div class="stmt-col-heads"><span>Description</span><span>${comparativeLabel || 'Prior year'}</span><span>Current year</span></div>`
    : `<div class="stmt-col-heads"><span>Description</span><span></span><span>Current year</span></div>`;

  const row = (label, cur, prior, cls = '') => {
    const priorCell = showComp ? `<td class="amt">${prior !== undefined ? fmt(prior) : ''}</td>` : '<td class="amt"></td>';
    return `<tr class="${cls}"><td class="label indent">${label}</td>${priorCell}<td class="amt">${fmt(cur)}</td></tr>`;
  };

  const subtotal = (label, cur, prior, cls = 'subtotal') => {
    const priorCell = showComp ? `<td class="amt">${prior !== undefined ? fmt(prior) : ''}</td>` : '<td class="amt"></td>';
    return `<tr class="${cls}"><td class="label">${label}</td>${priorCell}<td class="amt">${fmt(cur)}</td></tr>`;
  };

  const secHead = (label) =>
    `<tr class="section-head"><td colspan="3">${label}</td></tr>`;

  let html = `<div class="statement-wrap">${col}<table class="stmt-table">`;

  // Income
  html += secHead('Income');
  incomeLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total income', revenue, revComparative);

  // Cost of Sales
  if (!hideZeros || totalCOS !== 0) {
    html += secHead('Cost of Sales');
    cosLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
    html += subtotal('Total cost of sales', totalCOS, cosCom);
  }

  // Gross Profit
  html += subtotal('Gross Profit', grossProfit, grossProfitCom, 'subtotal');

  // Expenses
  html += secHead('Expenses');
  expLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total expenses', totalExpenses, expCom);

  // Net Profit/Loss
  const npCls = `total ${netProfit >= 0 ? 'profit' : 'loss'}`;
  const npLabel = netProfit >= 0 ? 'Net Profit' : 'Net Loss';
  const priorNP = showComp ? `<td class="amt">${fmt(netProfitCom)}</td>` : '<td class="amt"></td>';
  html += `<tr class="${npCls}"><td class="label">${npLabel}</td>${priorNP}<td class="amt">${fmt(netProfit)}</td></tr>`;

  html += '</table></div>';
  return html;
}

function renderBS(data, comparativeLabel) {
  const { assetLines, liabLines, equityLines,
          totalAssets, assetsCom,
          totalLiabilities, liabCom,
          totalEquity, equityCom,
          totalLiabEquity, comparativeAvailable } = data;

  const showComp = comparativeAvailable;
  const col = showComp
    ? `<div class="stmt-col-heads"><span>Description</span><span>${comparativeLabel || 'Prior year'}</span><span>Current year</span></div>`
    : `<div class="stmt-col-heads"><span>Description</span><span></span><span>Current year</span></div>`;

  const row = (label, cur, prior) => {
    const priorCell = showComp ? `<td class="amt">${prior !== undefined ? fmt(prior) : ''}</td>` : '<td class="amt"></td>';
    return `<tr><td class="label indent">${label}</td>${priorCell}<td class="amt">${fmt(cur)}</td></tr>`;
  };
  const subtotal = (label, cur, prior, cls = 'subtotal') => {
    const priorCell = showComp ? `<td class="amt">${prior !== undefined ? fmt(prior) : ''}</td>` : '<td class="amt"></td>';
    return `<tr class="${cls}"><td class="label">${label}</td>${priorCell}<td class="amt">${fmt(cur)}</td></tr>`;
  };
  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  let html = `<div class="statement-wrap">${col}<table class="stmt-table">`;

  html += secHead('Assets');
  assetLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Assets', totalAssets, assetsCom, 'total');

  html += secHead('Liabilities');
  liabLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Liabilities', totalLiabilities, liabCom);

  html += secHead('Equity');
  equityLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Equity', totalEquity, equityCom);

  html += subtotal('Total Liabilities & Equity', totalLiabEquity, r2(liabCom + equityCom), 'total');

  html += '</table></div>';
  return html;
}

function renderCF(data) {
  const { opLines, operating, invLines, investing, finLines, financing,
          netMovement, bankOB, closingBankBalance } = data;

  const row = (label, amt, indent = false) =>
    `<tr><td class="label${indent ? ' indent' : ''}">${label}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;
  const subtotal = (label, amt) =>
    `<tr class="subtotal"><td class="label">${label}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;
  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  let html = `<div class="statement-wrap">
    <div class="stmt-col-heads"><span>Description</span><span></span><span>Amount</span></div>
    <table class="stmt-table">`;

  html += secHead('Operating Activities');
  opLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from operating activities', operating);

  html += secHead('Investing Activities');
  invLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from investing activities', investing);

  html += secHead('Financing Activities');
  finLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from financing activities', financing);

  html += `<tr class="total"><td class="label">Net movement in cash</td><td class="amt"></td><td class="amt">${fmt(netMovement)}</td></tr>`;
  html += row('Opening bank balance', bankOB);
  html += `<tr class="total"><td class="label">Closing bank balance</td><td class="amt"></td><td class="amt">${fmt(closingBankBalance)}</td></tr>`;

  html += '</table></div>';
  return html;
}

function renderTB(data) {
  const { lines, totalDebits, totalCredits, balanced, diff } = { ...data, balanced: true };

  let html = `<div class="statement-wrap">
    <div class="stmt-col-heads"><span>Account</span><span style="text-align:right">Debit</span><span style="text-align:right">Credit</span></div>
    <table class="stmt-table">
    <colgroup><col style="width:55%"><col style="width:22%"><col style="width:23%"></colgroup>`;

  lines.forEach(l => {
    html += `<tr>
      <td class="label">${l.code} — ${l.name}</td>
      <td class="amt">${l.debit  ? fmt(l.debit)  : '—'}</td>
      <td class="amt">${l.credit ? fmt(l.credit) : '—'}</td>
    </tr>`;
  });

  const balClass = Math.abs(totalDebits - totalCredits) <= 0.02 ? 'total profit' : 'total loss';
  html += `<tr class="${balClass}">
    <td class="label">TOTALS</td>
    <td class="amt">${fmt(totalDebits)}</td>
    <td class="amt">${fmt(totalCredits)}</td>
  </tr>`;

  if (Math.abs(totalDebits - totalCredits) > 0.02) {
    html += `<tr><td colspan="3" style="color:var(--red);padding:8px 10px;font-size:0.8rem;">
      ⚠ Trial balance is out by ${fmt(Math.abs(totalDebits - totalCredits))} — check unclassified transactions.
    </td></tr>`;
  }

  html += '</table></div>';
  return html;
}

function renderCommissionIS(data, hideZeros) {
  const { incomeLines, expenseLines, totalIncome, totalExpenses, netIncome, isLoss,
          overrideActive, overrideAmount, bankIncome,
          hoSplitActive, hoSplitData } = data;

  const row = (label, amt) =>
    `<tr><td class="label indent">${label}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;
  const subtotal = (label, amt, cls = 'subtotal') =>
    `<tr class="${cls}"><td class="label">${label}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;
  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  const notePanel = (iconChar, color, bgVar, borderVar, title, innerRows) => {
    const innerHTML = innerRows.map(([label, val, valColor]) =>
      `<tr>
        <td style="padding:2px 0;color:var(--muted);">${label}</td>
        <td style="text-align:right;font-family:var(--font-mono);${valColor ? `color:${valColor};` : ''}font-weight:${valColor ? '700' : '400'};">${val}</td>
      </tr>`
    ).join('');
    return `<tr><td colspan="3" style="padding:10px 10px 4px;background:var(${bgVar});border-top:1px solid var(${borderVar});">
      <div style="font-size:0.75rem;font-weight:700;color:var(${color});margin-bottom:6px;">${iconChar} ${title}</div>
      <table style="width:100%;font-size:0.78rem;border-collapse:collapse;">${innerHTML}</table>
    </td></tr>`;
  };

  let html = `<div class="statement-wrap">
    <div class="stmt-col-heads"><span>Category (ITR12)</span><span></span><span>Amount</span></div>
    <table class="stmt-table">`;

  html += secHead('Income');
  incomeLines.forEach(l => { if (!hideZeros || l.amount !== 0) html += row(l.name, l.amount); });
  html += subtotal('Total Income', totalIncome);

  // Income override verification panel
  if (overrideActive) {
    html += notePanel('&#9888;', '--amber', '--amber-light', '--amber-border',
      'Income override active', [
        ['Bank statement income (from transactions):', fmt(bankIncome), null],
        ['Manually entered income:', fmt(overrideAmount), null],
        ['Difference:', fmt(r2(overrideAmount - bankIncome)),
          overrideAmount >= bankIncome ? 'var(--green)' : 'var(--red)'],
      ]);
  }

  html += secHead('Expenses');
  expenseLines.forEach(l => {
    if (!hideZeros || l.amount !== 0) {
      html += row(l.name, l.amount);
      // Home office split verification panel — shown right after the HO line
      if (l.code === 'ITR-EXP-HOM' && hoSplitActive && hoSplitData) {
        const { fullAmount, businessAmount, personalAmount, pct } = hoSplitData;
        html += notePanel('&#127968;', '--text-muted', '--surface-2', '--border',
          `Home office split — ${pct}% business use`, [
            [`Full home office expenses:`, fmt(fullAmount), null],
            [`Business portion (${pct}%):`, fmt(businessAmount), null],
            [`Personal portion (${r2(100 - pct)}%):`, fmt(personalAmount), 'var(--text-muted)'],
            [`Amount on this statement:`, fmt(businessAmount), null],
          ]);
      }
    }
  });
  html += subtotal('Total Expenses', totalExpenses);

  const npCls   = `total ${isLoss ? 'loss' : 'profit'}`;
  const npLabel = isLoss ? 'Net Loss' : 'Net Income';
  html += `<tr class="${npCls}"><td class="label">${npLabel}</td><td class="amt"></td><td class="amt">${fmt(netIncome)}</td></tr>`;

  html += '</table></div>';
  return html;
}

function renderVATReport(vat201) {
  const { field1, field4A, field15, field17, field20, grossSales, grossPurchases,
          clientName, financialYear, period, isRefund, label, byPeriod } = vat201;

  const row  = (code, desc, amt, cls = '') =>
    `<tr class="${cls}"><td class="label">${code ? `<span style="font-family:var(--font-mono);font-size:0.8rem;background:var(--surface-2);padding:1px 6px;border-radius:4px;margin-right:6px;">${code}</span>` : ''}${desc}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;
  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  let html = `<div class="statement-wrap">
    <div class="stmt-col-heads"><span>Description</span><span></span><span>Amount</span></div>
    <table class="stmt-table">`;

  html += secHead('Output VAT (Sales)');
  html += row('1',   'Standard-rated supplies (excl. VAT)', field1);
  html += row('4A',  'Output VAT at 15%', field4A, 'subtotal');

  html += secHead('Input VAT (Purchases)');
  html += row('15',  'Standard-rated purchases (excl. VAT)', field15);
  html += row('17',  'Input VAT at 15%', field17, 'subtotal');

  const netCls = `total ${isRefund ? 'profit' : 'loss'}`;
  html += `<tr class="${netCls}"><td class="label">20 — ${label}</td><td class="amt"></td><td class="amt">${fmt(Math.abs(field20))}</td></tr>`;

  // Period breakdown
  const periods = Object.keys(byPeriod).sort();
  if (periods.length > 1) {
    html += secHead('Period Breakdown');
    periods.forEach(p => {
      const pb = byPeriod[p];
      html += row('', p, pb.netVAT, pb.netVAT < 0 ? '' : '');
    });
  }

  html += '</table></div>';
  return html;
}

// ============================================================
// ENHANCED VAT REPORT RENDERER
// Renders a full line-by-line VAT report from buildEnhancedVATReport output.
// ============================================================
function renderEnhancedVATReport(data) {
  const {
    incomeLines, expenseLines,
    totalIncomeInclusive, totalOutputVAT, totalIncomeExclusive,
    totalExpensesInclusive, totalInputVAT, totalExpensesExclusive,
    netVAT, isRefund,
  } = data;

  const secHead = l => `<tr class="section-head"><td colspan="4">${l}</td></tr>`;
  const colHead = `
    <div class="stmt-col-heads" style="grid-template-columns:1fr repeat(3,120px);">
      <span>Description</span>
      <span style="text-align:right;">Inclusive (R)</span>
      <span style="text-align:right;">VAT (R)</span>
      <span style="text-align:right;">Exclusive (R)</span>
    </div>`;

  const lineRow = l => `<tr>
    <td class="label indent" style="font-size:0.82rem;">${fmtDate(l.date)} &mdash; ${escHtml(l.description)}</td>
    <td class="amt">${fmt(l.inclusive)}</td>
    <td class="amt">${fmt(l.vatAmount)}</td>
    <td class="amt">${fmt(l.exclusive)}</td>
  </tr>`;

  const subtotalRow = (label, inc, vat, exc, cls = 'subtotal') => `
    <tr class="${cls}">
      <td class="label">${label}</td>
      <td class="amt">${fmt(inc)}</td>
      <td class="amt">${fmt(vat)}</td>
      <td class="amt">${fmt(exc)}</td>
    </tr>`;

  let html = `<div class="statement-wrap">
    <table class="stmt-table">
    <colgroup><col style="width:46%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup>
    <thead><tr style="background:var(--surface-2);font-size:0.78rem;font-weight:700;color:var(--text-muted);">
      <th class="label" style="padding:6px 10px;">Description</th>
      <th class="amt" style="padding:6px 10px;">Inclusive</th>
      <th class="amt" style="padding:6px 10px;">VAT</th>
      <th class="amt" style="padding:6px 10px;">Exclusive</th>
    </tr></thead>`;

  // Section 1 — Income / Output VAT
  html += secHead('Section 1 — Income (Output VAT)');
  if (incomeLines.length) {
    incomeLines.forEach(l => { html += lineRow(l); });
  } else {
    html += `<tr><td colspan="4" class="label" style="color:var(--muted);padding:8px 10px;">No output VAT transactions for this period.</td></tr>`;
  }
  html += subtotalRow('Total Income', totalIncomeInclusive, totalOutputVAT, totalIncomeExclusive);

  // Section 2 — Expenses / Input VAT
  html += secHead('Section 2 — Expenses (Input VAT)');
  if (expenseLines.length) {
    expenseLines.forEach(l => { html += lineRow(l); });
  } else {
    html += `<tr><td colspan="4" class="label" style="color:var(--muted);padding:8px 10px;">No input VAT transactions for this period.</td></tr>`;
  }
  html += subtotalRow('Total Expenses', totalExpensesInclusive, totalInputVAT, totalExpensesExclusive);

  // Summary
  html += secHead('VAT Summary');
  html += `<tr><td class="label indent">Output VAT (Section 1)</td><td class="amt"></td><td class="amt">${fmt(totalOutputVAT)}</td><td class="amt"></td></tr>`;
  html += `<tr><td class="label indent">Less: Input VAT (Section 2)</td><td class="amt"></td><td class="amt">(${fmt(totalInputVAT)})</td><td class="amt"></td></tr>`;

  const netCls = `total ${isRefund ? 'profit' : 'loss'}`;
  const netLabel = isRefund ? 'VAT Refund Due from SARS' : 'Net VAT Payable to SARS';
  html += `<tr class="${netCls}">
    <td class="label">${netLabel}</td>
    <td class="amt"></td>
    <td class="amt">${fmt(Math.abs(netVAT))}</td>
    <td class="amt"></td>
  </tr>`;

  html += '</table></div>';
  return html;
}

// Helper used inside renderEnhancedVATReport
function fmtDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).split('-');
  return `${d}/${m}/${y}`;
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// EXPORTS
// ============================================================
window.FinancialOutputs = {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildTrialBalance,
  buildCommissionIS,
  buildFullPack,
  renderIS,
  renderBS,
  renderCF,
  renderTB,
  renderCommissionIS,
  renderVATReport,
  renderEnhancedVATReport,
  // Utilities
  fmt,
  r2,
  netByAccount,
};

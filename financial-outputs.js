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

// ── Year-end label ────────────────────────────────────────────
// Converts a full month name + 4-digit year into a "YE MMM YYYY" label.
// e.g. yearEndLabel('February', '2025') → 'YE Feb 2025'
const _MONTH_ABBR = {
  january:'Jan', february:'Feb', march:'Mar',    april:'Apr',
  may:'May',     june:'Jun',     july:'Jul',      august:'Aug',
  september:'Sep', october:'Oct', november:'Nov', december:'Dec',
};
function yearEndLabel(monthName, year) {
  const abbr = _MONTH_ABBR[(monthName || '').toLowerCase()] || (monthName || '').slice(0, 3);
  return `YE ${abbr} ${year}`;
}

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
function buildIncomeStatement(transactions, coa, priorYearTransactions, hideZeros) {
  try {
    const txMap    = netByAccount(transactions);
    const priorMap = netByAccount(priorYearTransactions || []);
    const merged   = mergeWithCOA(coa, txMap, null);

    const incomeLines = merged
      .filter(a => a.type === 'income')
      .map(a => {
        const prior = priorMap.get(a.code);
        return {
          ...a,
          current:     r2(a.net),
          comparative: prior ? r2(prior.net) : 0,
        };
      })
      .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const cosLines = merged
      .filter(a => a.type === 'cost_of_sales')
      .map(a => {
        const prior = priorMap.get(a.code);
        return {
          ...a,
          // Cost of sales: money paid out (negative amounts) shown as positive expense
          current:     r2(-a.net),
          comparative: prior ? r2(-prior.net) : 0,
        };
      })
      .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const expLines = merged
      .filter(a => a.type === 'expense')
      .map(a => {
        const prior = priorMap.get(a.code);
        return {
          ...a,
          current:     r2(-a.net),
          comparative: prior ? r2(-prior.net) : 0,
        };
      })
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

    // Comparative is available when prior year has at least one classified transaction
    const comparativeAvailable = (priorYearTransactions || []).some(t => t.account_code);

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

    // Include opening balance accounts that are not in the COA.
    // Type is inferred from the SA account-code prefix convention:
    //   1xxx = asset, 2xxx = liability, 3xxx = equity
    const coaCodes = new Set(coa.map(a => a.account_code));
    const _prefixType = { '1':'asset','2':'liability','3':'equity','4':'income','5':'cost_of_sales','6':'expense' };
    for (const ob of (openingBalances || [])) {
      if (coaCodes.has(ob.account_code)) continue;
      const inferredType = _prefixType[String(ob.account_code)[0]] || 'asset';
      if (!['asset','liability','equity'].includes(inferredType)) continue;
      merged.push({
        code: ob.account_code, name: ob.account_name,
        type: inferredType, net: 0, openingBalance: r2(ob.amount),
      });
    }

    // Bank account: net of all transactions (all account types flow through bank)
    const bankTxNet = r2(transactions.reduce((s, t) => s + (t.amount || 0), 0));

    // Identify the retained earnings account by code or name
    const _isRE = a =>
      a.code === '3002' || (a.name || '').toLowerCase().includes('retained earnings');

    // Prior retained earnings: from opening_balances for the RE account (credit-sign = negative stored)
    const reObAmount = (() => {
      for (const [code, ob] of obMap.entries()) {
        const name = (coa.find(a => a.account_code === code) || ob).account_name || ob.account_name || '';
        const type = (_prefixType[String(code)[0]] || 'asset');
        if (type === 'equity' && _isRE({ code, name })) return r2(ob.amount);
      }
      return 0;
    })();

    // Retained earnings stored in credit-sign (negative = credit).
    // netProfit is IS-convention (positive = profit). To keep credit-sign: subtract netProfit.
    // Negating this for display gives a positive retained-earnings figure.
    const computedRetainedEarnings = r2(reObAmount - netProfit);

    // displaySign: +1 for assets (debit-normal, stored positive)
    //              -1 for liabilities/equity (credit-normal, stored negative → negate for display)
    const buildLines = (type, displaySign) =>
      merged
        .filter(a => a.type === type)
        .map(a => {
          let current, comparative;
          if (a.code === '1001' || (a.name || '').toLowerCase().includes('bank account')) {
            // Bank: opening debit balance + current year net
            current     = r2((a.openingBalance || 0) + bankTxNet);
            comparative = r2(a.openingBalance || 0);
          } else if (_isRE(a)) {
            // Retained earnings: credit-sign stored → negate for positive display
            current     = r2(-computedRetainedEarnings);
            comparative = r2(-a.openingBalance);
          } else if (displaySign < 0) {
            // Liabilities & equity (credit-normal, stored negative):
            // -(opening − net) converts credit-sign + movement inversion → positive display.
            current     = r2(-(a.openingBalance - a.net));
            comparative = r2(-a.openingBalance);
          } else {
            // Assets (non-bank, debit-normal):
            current     = r2(a.openingBalance + a.net);
            comparative = r2(a.openingBalance);
          }
          return { ...a, current, comparative };
        })
        .filter(a => !hideZeros || a.current !== 0 || a.comparative !== 0);

    const assetLines  = buildLines('asset',     +1);
    const liabLines   = buildLines('liability', -1);
    const equityLines = buildLines('equity',    -1);

    // If no retained earnings account exists in the COA or opening_balances,
    // inject a synthetic line so net profit always appears on the BS face.
    const hasRE = merged.some(a => a.type === 'equity' && _isRE(a));
    if (!hasRE) {
      const reDisplay = r2(-computedRetainedEarnings);
      if (reDisplay !== 0 || !hideZeros) {
        equityLines.push({
          code: 'RE-COMPUTED', name: 'Retained Earnings', type: 'equity',
          net: 0, openingBalance: 0,
          current:     reDisplay,
          comparative: r2(-reObAmount),
          synthetic:   true,
        });
      }
    }

    const totalAssets      = r2(assetLines.reduce((s, l) => s + l.current, 0));
    const totalLiabilities = r2(liabLines.reduce((s, l) => s + l.current, 0));
    const totalEquity      = r2(equityLines.reduce((s, l) => s + l.current, 0));
    const totalLiabEquity  = r2(totalLiabilities + totalEquity);

    const assetsCom        = r2(assetLines.reduce((s, l) => s + l.comparative, 0));
    const liabCom          = r2(liabLines.reduce((s, l) => s + l.comparative, 0));
    const equityCom        = r2(equityLines.reduce((s, l) => s + l.comparative, 0));

    // Current year balance check: Assets must equal Liabilities + Equity
    const diff    = r2(Math.abs(totalAssets - totalLiabEquity));
    const balanced = diff <= 0.02; // allow 2c rounding tolerance

    // Prior year balance check (independent — the comparative column must also balance)
    const totalLiabEquityCom = r2(liabCom + equityCom);
    const diffCom            = r2(Math.abs(assetsCom - totalLiabEquityCom));
    const balancedCom        = diffCom <= 0.02;

    // The prior year column always shows — if no OB imported, dashes are displayed
    const priorYearHasData   = (openingBalances || []).length > 0;
    const comparativeAvailable = true; // always render two columns

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
        totalLiabEquity,  totalLiabEquityCom,
        balancedCom,      diffCom,
        comparativeAvailable,
        priorYearHasData,
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
// priorYearTransactions (optional): classified prior year transactions for comparative
function buildCashFlow(transactions, coa, openingBalances, priorYearTransactions) {
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

    // ── Prior year comparative ─────────────────────────────────
    const priorYearAvailable = (priorYearTransactions || []).some(t => t.account_code);
    let priorOperating = 0, priorInvesting = 0, priorFinancing = 0;

    if (priorYearAvailable) {
      const priorTxMap = netByAccount(priorYearTransactions);
      for (const [code, { name, net }] of priorTxMap.entries()) {
        const type = typeByCode.get(code);
        switch (type) {
          case 'income': case 'cost_of_sales': case 'expense':
            priorOperating = r2(priorOperating + net); break;
          case 'asset':
            if (code === '1001' || (name || '').toLowerCase().includes('bank account')) break;
            priorInvesting = r2(priorInvesting + net); break;
          case 'liability': case 'equity':
            priorFinancing = r2(priorFinancing + net); break;
        }
      }
    }

    const priorNetMovement = priorYearAvailable
      ? r2((priorYearTransactions || []).reduce((s, t) => s + (t.amount || 0), 0))
      : 0;

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
        priorOperating, priorInvesting, priorFinancing, priorNetMovement,
        priorYearAvailable,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// 4. TRIAL BALANCE
// ============================================================
// Implements proper double-entry bookkeeping.
//
// Every transaction produces two ledger entries:
//   Money IN  (amount > 0):  DR Bank  /  CR classified account
//   Money OUT (amount < 0):  DR classified account  /  CR Bank
//
// This guarantees total debits = total credits (TB always balances).
//
// Normal balances:
//   Debit  — asset, expense, cost_of_sales
//   Credit — income, liability, equity
// priorYearTransactions (optional): classified prior year transactions for comparative columns
function buildTrialBalance(transactions, coa, hideZeros, openingBalances, netProfit, priorYearTransactions) {
  try {
    // COA lookup: code → { account_name, account_type }
    const coaByCode = new Map(coa.map(a => [a.account_code, a]));

    // Identify the bank account (first active asset whose code is 1001
    // or whose name contains "bank").
    const bankCOA  = coa.find(a =>
      a.is_active &&
      a.account_type === 'asset' &&
      (a.account_code === '1001' || a.account_name.toLowerCase().includes('bank'))
    );
    const bankCode = bankCOA?.account_code || '1001';
    const bankName = bankCOA?.account_name || 'Bank Account';

    // Double-entry ledger: code → { code, name, type, debit, credit }
    const ledger = new Map();

    const post = (code, name, type, dr, cr) => {
      if (!ledger.has(code)) {
        ledger.set(code, { code, name, type: type || 'asset', debit: 0, credit: 0 });
      }
      const e    = ledger.get(code);
      e.debit    = r2(e.debit  + dr);
      e.credit   = r2(e.credit + cr);
    };

    for (const t of transactions) {
      if (!t.account_code) continue;          // unclassified — skip
      const abs = Math.abs(t.amount || 0);
      if (abs === 0) continue;

      const coaEntry = coaByCode.get(t.account_code);
      const accName  = coaEntry?.account_name || t.account_name || t.account_code;
      const accType  = coaEntry?.account_type || 'expense';

      if ((t.amount || 0) > 0) {
        // Money IN: DR Bank, CR classified account (income / asset / equity credit)
        post(bankCode,       bankName, 'asset',  abs, 0  );
        post(t.account_code, accName,  accType,  0,   abs);
      } else {
        // Money OUT: DR classified account (expense / asset debit), CR Bank
        post(t.account_code, accName,  accType,  abs, 0  );
        post(bankCode,       bankName, 'asset',  0,   abs);
      }
    }

    // Compute net balance per account and assign to debit or credit side.
    // net > 0 → debit balance (normal for assets, expenses)
    // net < 0 → credit balance (normal for income, liabilities, equity)
    const lines = [];
    for (const e of ledger.values()) {
      const net = r2(e.debit - e.credit);
      lines.push({
        code:   e.code,
        name:   e.name,
        type:   e.type,
        debit:  net > 0 ? net         : 0,
        credit: net < 0 ? Math.abs(net) : 0,
      });
    }

    // Include zero-balance COA accounts when hideZeros is off
    if (!hideZeros) {
      for (const a of coa.filter(a => a.is_active)) {
        if (!ledger.has(a.account_code)) {
          lines.push({ code: a.account_code, name: a.account_name, type: a.account_type, debit: 0, credit: 0 });
        }
      }
    }

    const sort = arr => arr.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    const filtered = hideZeros
      ? lines.filter(l => l.debit !== 0 || l.credit !== 0)
      : lines;

    // ── IS sub-groups ─────────────────────────────────────────
    const incomeLines = sort(filtered.filter(l => l.type === 'income'));
    const cosLines    = sort(filtered.filter(l => l.type === 'cost_of_sales'));
    const expLines    = sort(filtered.filter(l => l.type === 'expense'));

    // IS derived values (net amounts for each sub-group)
    // Income is credit-normal → credit - debit gives the credit balance
    // CoS/Expense are debit-normal → debit - credit gives the debit balance
    const grossIncome   = r2(incomeLines.reduce((s, l) => s + l.credit - l.debit, 0));
    const totalCOS      = r2(cosLines.reduce((s, l)    => s + l.debit  - l.credit, 0));
    const grossProfit   = r2(grossIncome - totalCOS);
    const totalExpenses = r2(expLines.reduce((s, l)    => s + l.debit  - l.credit, 0));
    const netProfit     = r2(grossProfit - totalExpenses);

    // ── BS sub-groups ─────────────────────────────────────────
    const assetLines  = sort(filtered.filter(l => l.type === 'asset'));
    const liabLines   = sort(filtered.filter(l => l.type === 'liability'));
    const equityLines = sort(filtered.filter(l => l.type === 'equity'));

    // ── Inject computed retained earnings into equity section ──
    // Only when openingBalances and netProfit are supplied (company TB).
    // The synthetic line is excluded from grand DR/CR totals so the
    // transaction-based balance is not disturbed.
    if (openingBalances !== undefined && netProfit !== undefined) {
      const reAccount = coa.find(a =>
        a.is_active && a.account_type === 'equity' &&
        (a.account_code === '3002' || a.account_name.toLowerCase().includes('retained earnings'))
      );
      if (reAccount) {
        const obMapRE = buildOpeningMap(openingBalances || []);
        const reOB    = r2(obMapRE.get(reAccount.account_code)?.amount || 0);
        // reOB is credit-sign (negative stored). netProfit is IS-positive.
        // TB credit balance = positive RE displayed in credit column:
        //   compRE = netProfit − reOB  (e.g. 30000 − (−50000) = 80000 credit)
        const compRE  = r2((netProfit || 0) - reOB);
        const reLine  = {
          code:      reAccount.account_code,
          name:      reAccount.account_name,
          type:      'equity',
          debit:     compRE < 0 ? Math.abs(compRE) : 0,
          credit:    compRE > 0 ? compRE : 0,
          synthetic: true,
        };
        const existingIdx = equityLines.findIndex(l => l.code === reAccount.account_code);
        if (existingIdx >= 0) {
          equityLines[existingIdx] = reLine;
        } else {
          equityLines.push(reLine);
          sort(equityLines);
        }
      }
    }
    // ──────────────────────────────────────────────────────────

    // BS derived values
    const totalAssets      = r2(assetLines.reduce((s, l)  => s + l.debit  - l.credit, 0));
    const totalLiabilities = r2(liabLines.reduce((s, l)   => s + l.credit - l.debit,  0));
    const totalEquity      = r2(equityLines.reduce((s, l) => s + l.credit - l.debit,  0));
    // Balance Effect = Assets − (Liabilities + Equity). Zero when BS balances.
    const balanceEffect    = r2(totalAssets - totalLiabilities - totalEquity);

    // ── Prior year double-entry ledger ────────────────────────
    const priorYearAvailable = (priorYearTransactions || []).some(t => t.account_code);
    const priorLedger = new Map();

    if (priorYearAvailable) {
      const postPrior = (code, name, type, dr, cr) => {
        if (!priorLedger.has(code)) priorLedger.set(code, { debit: 0, credit: 0 });
        const e = priorLedger.get(code);
        e.debit  = r2(e.debit  + dr);
        e.credit = r2(e.credit + cr);
      };
      for (const t of (priorYearTransactions || [])) {
        if (!t.account_code) continue;
        const abs = Math.abs(t.amount || 0);
        if (abs === 0) continue;
        const coaEntry = coaByCode.get(t.account_code);
        const accName  = coaEntry?.account_name || t.account_name || t.account_code;
        const accType  = coaEntry?.account_type || 'expense';
        if ((t.amount || 0) > 0) {
          postPrior(bankCode, bankName, 'asset', abs, 0);
          postPrior(t.account_code, accName, accType, 0, abs);
        } else {
          postPrior(t.account_code, accName, accType, abs, 0);
          postPrior(bankCode, bankName, 'asset', 0, abs);
        }
      }
    }

    // Attach prior year DR/CR to every line in every section group
    const _addPrior = arr => arr.forEach(l => {
      if (!priorYearAvailable) { l.priorDebit = 0; l.priorCredit = 0; return; }
      const pe = priorLedger.get(l.code);
      if (!pe) { l.priorDebit = 0; l.priorCredit = 0; return; }
      const pnet = r2(pe.debit - pe.credit);
      l.priorDebit  = pnet > 0 ? pnet         : 0;
      l.priorCredit = pnet < 0 ? Math.abs(pnet) : 0;
    });
    [incomeLines, cosLines, expLines, assetLines, liabLines, equityLines].forEach(_addPrior);

    // Prior year section subtotals
    const priorGrossIncome      = r2(incomeLines.reduce((s, l)  => s + l.priorCredit - l.priorDebit,  0));
    const priorTotalCOS         = r2(cosLines.reduce((s, l)     => s + l.priorDebit  - l.priorCredit, 0));
    const priorGrossProfit      = r2(priorGrossIncome - priorTotalCOS);
    const priorTotalExpenses    = r2(expLines.reduce((s, l)     => s + l.priorDebit  - l.priorCredit, 0));
    const priorNetProfit        = r2(priorGrossProfit - priorTotalExpenses);
    const priorTotalAssets      = r2(assetLines.reduce((s, l)   => s + l.priorDebit  - l.priorCredit, 0));
    const priorTotalLiabilities = r2(liabLines.reduce((s, l)    => s + l.priorCredit - l.priorDebit,  0));
    const priorTotalEquity      = r2(equityLines.reduce((s, l)  => s + l.priorCredit - l.priorDebit,  0));

    // ── Grand totals ──────────────────────────────────────────
    // Synthetic retained earnings is excluded so DR=CR stays intact.
    const txLines      = [...incomeLines, ...cosLines, ...expLines,
                          ...assetLines,  ...liabLines,
                          ...equityLines.filter(l => !l.synthetic)];
    const totalDebits  = r2(txLines.reduce((s, l) => s + l.debit,  0));
    const totalCredits = r2(txLines.reduce((s, l) => s + l.credit, 0));
    const balanced     = Math.abs(totalDebits - totalCredits) <= 0.02;
    const diff         = r2(Math.abs(totalDebits - totalCredits));

    const priorTotalDebits  = r2(txLines.reduce((s, l) => s + l.priorDebit,  0));
    const priorTotalCredits = r2(txLines.reduce((s, l) => s + l.priorCredit, 0));

    // Full line list for CSV/print (includes synthetic RE for display)
    const allLines = [...incomeLines, ...cosLines, ...expLines,
                      ...assetLines,  ...liabLines, ...equityLines];

    return {
      ok: true,
      balanced,
      diff,
      data: {
        // IS sub-groups
        incomeLines, cosLines, expLines,
        grossIncome, totalCOS, grossProfit, totalExpenses, netProfit,
        // IS prior year subtotals
        priorGrossIncome, priorTotalCOS, priorGrossProfit, priorTotalExpenses, priorNetProfit,
        // BS sub-groups
        assetLines, liabLines, equityLines,
        totalAssets, totalLiabilities, totalEquity, balanceEffect,
        // BS prior year subtotals
        priorTotalAssets, priorTotalLiabilities, priorTotalEquity,
        // Grand totals
        totalDebits, totalCredits,
        priorTotalDebits, priorTotalCredits,
        priorYearAvailable,
        // Flat list for CSV/print iteration
        lines: allLines,
      },
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
    const priorYear = String(parseInt(financialYear, 10) - 1);
    const [transactions, openingBalances, priorTransactionsRaw] = await Promise.all([
      window.DB.Transactions.listByYear(clientId, financialYear),
      window.DB.OpeningBalances.list(clientId, financialYear),
      window.DB.Transactions.listByYear(clientId, priorYear).catch(() => []),
    ]);

    const classified      = transactions.filter(t => t.account_code);
    const priorClassified = (priorTransactionsRaw || []).filter(t => t.account_code);

    const IS  = buildIncomeStatement(classified, coa, priorClassified, hideZeros);
    const netProfit = IS.ok ? IS.data.netProfit : 0;
    const BS  = buildBalanceSheet(classified, coa, openingBalances, netProfit, hideZeros);
    const CF  = buildCashFlow(classified, coa, openingBalances, priorClassified);
    const TB  = buildTrialBalance(classified, coa, hideZeros, openingBalances, IS.ok ? IS.data.netProfit : 0, priorClassified);
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

function renderIS(data, currentLabel, priorLabel, hideZeros, opts) {
  const { incomeLines, cosLines, expLines,
          revenue, revComparative,
          totalCOS, cosCom,
          grossProfit, grossProfitCom,
          totalExpenses, expCom,
          netProfit, netProfitCom,
          comparativeAvailable } = data;

  const curLbl  = currentLabel || 'Current year';
  const priorLbl = priorLabel  || 'Prior year';
  const showComp = comparativeAvailable;
  const col = showComp
    ? `<div class="stmt-col-heads"><span>Description</span><span>${priorLbl}</span><span>${curLbl}</span></div>`
    : `<div class="stmt-col-heads"><span>Description</span><span></span><span>${curLbl}</span></div>`;

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

  const header = (opts && opts.title) ? _brandHeader(opts.title, opts.clientName, currentLabel, priorLabel) : '';
  let html = `<div class="statement-wrap">${header}${col}<table class="stmt-table">`;

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

function renderBS(data, currentLabel, priorLabel, opts) {
  const { assetLines, liabLines, equityLines,
          totalAssets, assetsCom,
          totalLiabilities, liabCom,
          totalEquity, equityCom,
          totalLiabEquity, totalLiabEquityCom,
          balancedCom, diffCom,
          priorYearHasData } = data;

  const curLbl   = currentLabel || 'Current year';
  const priorLbl = priorLabel   || 'Prior year';

  // Always show two columns — prior year shows dashes when no OB imported
  const col = `<div class="stmt-col-heads"><span>Description</span><span>${priorLbl}</span><span>${curLbl}</span></div>`;

  // When no OB data, prior year cells show a dash instead of R 0.00
  const priorFmt = v => priorYearHasData ? fmt(v) : '—';

  const row = (label, cur, prior) =>
    `<tr><td class="label indent">${label}</td><td class="amt">${priorFmt(prior)}</td><td class="amt">${fmt(cur)}</td></tr>`;

  const subtotal = (label, cur, prior, cls = 'subtotal') =>
    `<tr class="${cls}"><td class="label">${label}</td><td class="amt">${priorFmt(prior)}</td><td class="amt">${fmt(cur)}</td></tr>`;

  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  const header = (opts && opts.title) ? _brandHeader(opts.title, opts.clientName, currentLabel, priorLabel) : '';
  let html = `<div class="statement-wrap">${header}${col}<table class="stmt-table">`;

  html += secHead('Assets');
  assetLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Assets', totalAssets, assetsCom, 'total');

  html += secHead('Liabilities');
  liabLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Liabilities', totalLiabilities, liabCom);

  html += secHead('Equity');
  equityLines.forEach(l => { html += row(l.name, l.current, l.comparative); });
  html += subtotal('Total Equity', totalEquity, equityCom);

  html += subtotal('Total Liabilities & Equity', totalLiabEquity, totalLiabEquityCom, 'total');

  html += '</table></div>';
  return html;
}

function renderCF(data, currentLabel, priorLabel, opts) {
  const { opLines, operating, invLines, investing, finLines, financing,
          netMovement, bankOB, closingBankBalance,
          priorOperating, priorInvesting, priorFinancing, priorNetMovement,
          priorYearAvailable } = data;

  const curLbl   = currentLabel || 'Current year';
  const priorLbl = priorLabel   || 'Prior year';
  const showPrior = !!priorYearAvailable;

  const colHead = showPrior
    ? `<div class="stmt-col-heads"><span>Description</span><span>${priorLbl}</span><span>${curLbl}</span></div>`
    : `<div class="stmt-col-heads"><span>Description</span><span></span><span>${curLbl}</span></div>`;

  // Detail lines (current year only — prior year section totals are shown as subtotals)
  const row = (label, amt, indent = false) =>
    `<tr><td class="label${indent ? ' indent' : ''}">${label}</td><td class="amt"></td><td class="amt">${fmt(amt)}</td></tr>`;

  const subtotal = (label, curAmt, priorAmt) => {
    const priorCell = showPrior ? `<td class="amt">${fmt(priorAmt)}</td>` : `<td class="amt"></td>`;
    return `<tr class="subtotal"><td class="label">${label}</td>${priorCell}<td class="amt">${fmt(curAmt)}</td></tr>`;
  };

  const totalRow = (label, curAmt, priorAmt) => {
    const priorCell = showPrior
      ? `<td class="amt">${priorAmt !== null && priorAmt !== undefined ? fmt(priorAmt) : '—'}</td>`
      : `<td class="amt"></td>`;
    return `<tr class="total"><td class="label">${label}</td>${priorCell}<td class="amt">${fmt(curAmt)}</td></tr>`;
  };

  const secHead = l => `<tr class="section-head"><td colspan="3">${l}</td></tr>`;

  const header = (opts && opts.title) ? _brandHeader(opts.title, opts.clientName, currentLabel, priorLabel) : '';
  let html = `<div class="statement-wrap">${header}${colHead}<table class="stmt-table">`;

  html += secHead('Operating Activities');
  opLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from operating activities', operating, priorOperating || 0);

  html += secHead('Investing Activities');
  invLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from investing activities', investing, priorInvesting || 0);

  html += secHead('Financing Activities');
  finLines.forEach(l => { html += row(l.name, l.amount, true); });
  html += subtotal('Net cash from financing activities', financing, priorFinancing || 0);

  html += totalRow('Net movement in cash', netMovement, priorNetMovement || 0);
  // Opening/closing bank: show current year only (prior year opening OB not stored)
  html += row('Opening bank balance', bankOB);
  html += totalRow('Closing bank balance', closingBankBalance, null);

  html += '</table></div>';
  return html;
}

function renderTB(data, currentLabel, priorLabel, opts) {
  const {
    incomeLines, cosLines, expLines,
    grossIncome, totalCOS, grossProfit, totalExpenses, netProfit,
    priorGrossIncome, priorTotalCOS, priorGrossProfit, priorTotalExpenses, priorNetProfit,
    assetLines, liabLines, equityLines,
    totalAssets, totalLiabilities, totalEquity, balanceEffect,
    priorTotalAssets, priorTotalLiabilities, priorTotalEquity,
    totalDebits, totalCredits,
    priorTotalDebits, priorTotalCredits,
    priorYearAvailable,
  } = data;

  const curLbl   = currentLabel || 'Current year';
  const priorLbl = priorLabel   || 'Prior year';
  const showPrior = !!priorYearAvailable;
  const cols      = showPrior ? 5 : 3;

  const colgroup = showPrior
    ? `<colgroup><col style="width:40%"><col style="width:15%"><col style="width:15%"><col style="width:15%"><col style="width:15%"></colgroup>`
    : `<colgroup><col style="width:55%"><col style="width:22%"><col style="width:23%"></colgroup>`;

  const thead = showPrior
    ? `<thead><tr class="stmt-thead">
        <th class="label">Account</th>
        <th class="amt">${priorLbl} DR</th>
        <th class="amt">${priorLbl} CR</th>
        <th class="amt">${curLbl} DR</th>
        <th class="amt">${curLbl} CR</th>
      </tr></thead>`
    : `<thead><tr class="stmt-thead">
        <th class="label">Account</th>
        <th class="amt">${curLbl} DR</th>
        <th class="amt">${curLbl} CR</th>
      </tr></thead>`;

  // Individual account line
  const lineRow = l => showPrior
    ? `<tr>
        <td class="label indent">${l.code} — ${escHtml(l.name)}</td>
        <td class="amt">${l.priorDebit  ? fmt(l.priorDebit)  : '—'}</td>
        <td class="amt">${l.priorCredit ? fmt(l.priorCredit) : '—'}</td>
        <td class="amt">${l.debit  ? fmt(l.debit)  : '—'}</td>
        <td class="amt">${l.credit ? fmt(l.credit) : '—'}</td>
      </tr>`
    : `<tr>
        <td class="label indent">${l.code} — ${escHtml(l.name)}</td>
        <td class="amt">${l.debit  ? fmt(l.debit)  : '—'}</td>
        <td class="amt">${l.credit ? fmt(l.credit) : '—'}</td>
      </tr>`;

  const emptyRow = msg =>
    `<tr><td colspan="${cols}" class="label" style="color:var(--muted);padding:6px 10px;font-size:0.82rem;">${msg}</td></tr>`;

  const secHead = label => `<tr class="section-head"><td colspan="${cols}">${label}</td></tr>`;

  const grpHead = label =>
    `<tr class="grp-head"><td colspan="${cols}">${label}</td></tr>`;

  // Subtotal row — drAmt/crAmt are the current-year values; priorDr/priorCr are optional prior year
  const subtotalRow = (label, drAmt, crAmt, priorDr, priorCr, cls = 'subtotal') => {
    if (showPrior) {
      return `<tr class="${cls}">
        <td class="label">${label}</td>
        <td class="amt">${priorDr !== null && priorDr !== undefined ? fmt(priorDr) : ''}</td>
        <td class="amt">${priorCr !== null && priorCr !== undefined ? fmt(priorCr) : ''}</td>
        <td class="amt">${drAmt !== null ? fmt(drAmt) : ''}</td>
        <td class="amt">${crAmt !== null ? fmt(crAmt) : ''}</td>
      </tr>`;
    }
    return `<tr class="${cls}">
      <td class="label">${label}</td>
      <td class="amt">${drAmt !== null ? fmt(drAmt) : ''}</td>
      <td class="amt">${crAmt !== null ? fmt(crAmt) : ''}</td>
    </tr>`;
  };

  // Derived row: current amount lands in credit if ≥ 0, debit if < 0; same logic for prior
  const derivedRow = (label, amount, priorAmount, cls = 'subtotal') => {
    const currDr   = amount      < 0 ? Math.abs(amount)      : null;
    const currCr   = amount      >= 0 ? amount      : null;
    const priorDr  = showPrior && priorAmount < 0  ? Math.abs(priorAmount) : (showPrior ? null : undefined);
    const priorCr  = showPrior && priorAmount >= 0 ? priorAmount           : (showPrior ? null : undefined);
    return subtotalRow(label, currDr, currCr, priorDr, priorCr, cls);
  };

  const header = (opts && opts.title) ? _brandHeader(opts.title, opts.clientName, currentLabel, priorLabel) : '';
  let html = `<div class="statement-wrap">${header}<table class="stmt-table">${colgroup}${thead}`;

  // ══════════════════════════════════════════════════════════════
  // SECTION 1 — Income Statement Accounts
  // ══════════════════════════════════════════════════════════════
  html += secHead('Section 1 — Income Statement Accounts');

  html += grpHead('Income');
  incomeLines.length
    ? incomeLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No income transactions classified.');
  html += subtotalRow('Gross Income', null, grossIncome, null, priorGrossIncome);

  html += grpHead('Cost of Sales');
  cosLines.length
    ? cosLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No cost of sales transactions classified.');
  html += derivedRow(grossProfit >= 0 ? 'Gross Profit' : 'Gross Loss', grossProfit, priorGrossProfit || 0);

  html += grpHead('Expenses');
  expLines.length
    ? expLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No expense transactions classified.');
  html += derivedRow(
    netProfit >= 0 ? 'Net Profit' : 'Net Loss',
    netProfit, priorNetProfit || 0,
    'total ' + (netProfit >= 0 ? 'profit' : 'loss'),
  );

  // ══════════════════════════════════════════════════════════════
  // SECTION 2 — Balance Sheet Accounts
  // ══════════════════════════════════════════════════════════════
  html += secHead('Section 2 — Balance Sheet Accounts');

  html += grpHead('Assets (including Bank)');
  assetLines.length
    ? assetLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No asset transactions classified.');
  html += subtotalRow('Total Assets', totalAssets, null, priorTotalAssets, null);

  html += grpHead('Liabilities');
  liabLines.length
    ? liabLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No liability transactions classified.');
  html += subtotalRow('Total Liabilities', null, totalLiabilities, null, priorTotalLiabilities);

  html += grpHead('Equity');
  equityLines.length
    ? equityLines.forEach(l => { html += lineRow(l); })
    : html += emptyRow('No equity transactions classified.');
  html += subtotalRow('Total Equity', null, totalEquity, null, priorTotalEquity);

  const beOk  = Math.abs(balanceEffect) <= 0.02;
  const beCls = beOk ? 'subtotal' : 'total loss';
  const beLabel = beOk
    ? 'Balance Effect — Balance Sheet balances ✓'
    : `Balance Effect — out by ${fmt(Math.abs(balanceEffect))} (check equity / opening balances)`;
  html += derivedRow(beLabel, beOk ? 0 : balanceEffect, 0, beCls);

  // ══════════════════════════════════════════════════════════════
  // Grand Total
  // ══════════════════════════════════════════════════════════════
  const gtOk  = Math.abs(totalDebits - totalCredits) <= 0.02;

  if (showPrior) {
    html += `<tr class="grand-total">
      <td class="label">Grand Total</td>
      <td class="amt">${fmt(priorTotalDebits)}</td>
      <td class="amt">${fmt(priorTotalCredits)}</td>
      <td class="amt">${fmt(totalDebits)}</td>
      <td class="amt">${fmt(totalCredits)}</td>
    </tr>`;
  } else {
    html += `<tr class="grand-total">
      <td class="label">Grand Total</td>
      <td class="amt">${fmt(totalDebits)}</td>
      <td class="amt">${fmt(totalCredits)}</td>
    </tr>`;
  }

  if (!gtOk) {
    html += `<tr><td colspan="${cols}" style="color:var(--red);padding:8px 10px;font-size:0.8rem;">
      &#9888; Trial balance is out by ${fmt(Math.abs(totalDebits - totalCredits))} — check for unclassified transactions.
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
function renderEnhancedVATReport(data, currentLabel, opts) {
  const {
    incomeLines, expenseLines,
    totalIncomeInclusive, totalOutputVAT, totalIncomeExclusive,
    totalExpensesInclusive, totalInputVAT, totalExpensesExclusive,
    netVAT, isRefund,
  } = data;

  const periodLbl = currentLabel || 'Current year';
  const secHead = l => `<tr class="section-head"><td colspan="4">${l}</td></tr>`;
  const colHead = `
    <div class="stmt-col-heads" style="grid-template-columns:1fr repeat(3,120px);">
      <span>${periodLbl} — Transactions</span>
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

  const vatHeader = (opts && opts.title) ? _brandHeader(opts.title, opts.clientName, currentLabel, null) : '';
  let html = `<div class="statement-wrap">${vatHeader}
    <table class="stmt-table">
    <colgroup><col style="width:46%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup>
    <thead><tr class="stmt-thead">
      <th class="label">Description</th>
      <th class="amt">Inclusive</th>
      <th class="amt">VAT</th>
      <th class="amt">Exclusive</th>
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

// Branded report header bar (logo + slogan + title + client/period line)
function _brandHeader(title, clientName, currentLabel, priorLabel) {
  const period = [currentLabel, priorLabel].filter(Boolean).join(' / ');
  return `
    <div class="stmt-brand-bar">
      <div class="stmt-brand-left">
        ${(function(){
          try {
            const logo = localStorage.getItem('rs_practice_logo');
            if (logo) return `<img src="${logo}" alt="Practice logo" style="max-height:48px;max-width:160px;object-fit:contain;display:block;"/>`;
          } catch(e) {}
          return `<div class="stmt-brand-logo"><span class="stmt-brand-rand">Rand</span><span class="stmt-brand-sense">Sense</span></div>
                  <div class="stmt-brand-slogan">Making Cents of it all</div>`;
        })()}
      </div>
      <div class="stmt-brand-practice">${(function(){ try { return getPracticeAccountant() || 'Matthew Le Roux'; } catch(e) { return 'Matthew Le Roux'; } })()}</div>
    </div>
    <div class="stmt-report-meta">
      <div class="stmt-report-title">${escHtml(title || '')}</div>
      ${clientName ? `<div class="stmt-report-client">${escHtml(clientName)}${period ? ' &nbsp;&middot;&nbsp; ' + escHtml(period) : ''}</div>` : ''}
    </div>`;
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
  yearEndLabel,
};

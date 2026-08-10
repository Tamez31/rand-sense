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

// Commission earner ITR12 income statement rounds to the nearest whole rand
// (no cents) rather than 2 decimal places used elsewhere.
function fmtR1(n) {
  const rounded = Math.round(n || 0);
  const abs = Math.abs(rounded);
  const s   = abs.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (rounded < 0 ? '(' : '') + 'R\u00a0' + s + (rounded < 0 ? ')' : '');
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

// VAT-exclusive amount for a single transaction. Output/input VAT collected
// or paid must never inflate revenue or expense on the Income Statement — it
// belongs on the Balance Sheet (VAT Payable / VAT Receivable). Transactions
// with vat_type 'none' (or no vat_amount) pass through unchanged.
function exclVAT(t) {
  const vat = Number(t.vat_amount || 0);
  if (!vat || (t.vat_type !== 'output' && t.vat_type !== 'input')) return t.amount || 0;
  const amt = t.amount || 0;
  return r2(amt - Math.sign(amt) * vat);
}

// Same as netByAccount, but nets the VAT-exclusive amount per transaction.
// Used everywhere the Income Statement's own figures are derived, so a
// VAT-registered client's revenue/expense lines are always tax-exclusive.
function netByAccountExclVAT(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (!t.account_code) continue;
    const key = t.account_code;
    if (!map.has(key)) {
      map.set(key, { code: key, name: t.account_name || key, net: 0 });
    }
    map.get(key).net = r2(map.get(key).net + exclVAT(t));
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
function buildIncomeStatement(transactions, coa, priorYearTransactions, hideZeros, staticComparatives) {
  try {
    // Journal entries are stored debit-positive (+DR, -CR). IS expects bank-perspective
    // (negative = expense, positive = income), so flip the sign for journal rows only.
    const flipJnl   = txns => txns.map(t => t.source_bank === 'Journal' ? {...t, amount: -(t.amount||0)} : t);
    const txMap     = netByAccountExclVAT(flipJnl(transactions));
    const hasPriorTxs = (priorYearTransactions || []).some(t => t.account_code);
    // Build priorMap: prefer live prior-year transactions; fall back to static comparatives
    // stored in opening_balances (financial_year = prior year, IS account types only).
    // financial_year='2025' rows for income/cost_of_sales/expense = FY2025 full-year P&L totals
    // for static comparative display — NOT opening balances in the traditional sense.
    let priorMap;
    if (hasPriorTxs) {
      priorMap = netByAccountExclVAT(flipJnl(priorYearTransactions));
    } else if ((staticComparatives || []).length > 0) {
      const _coaByCode = new Map(coa.map(a => [a.account_code, a]));
      priorMap = new Map();
      for (const ob of staticComparatives) {
        const type = _coaByCode.get(ob.account_code)?.account_type;
        if (!['income','cost_of_sales','expense'].includes(type)) continue;
        priorMap.set(ob.account_code, { net: r2(ob.amount) });
      }
    } else {
      priorMap = new Map();
    }
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

    const comparativeAvailable = hasPriorTxs || priorMap.size > 0;

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

    // Bank account net: regular transactions use bank-perspective sign directly.
    // Journal entries are balanced (sum = 0) so their total doesn't affect the bank,
    // EXCEPT for journal lines explicitly posted to the bank account — those must be
    // added separately (stored debit-positive: +DR bank = cash in, -CR bank = cash out).
    const _coaByCodeBS = new Map(coa.map(a => [a.account_code, a]));
    const _isBankCodeBS = code => code === '1001' ||
      (_coaByCodeBS.get(code)?.account_name || '').toLowerCase().includes('bank');
    const bankTxNet = r2(
      transactions.filter(t => t.source_bank !== 'Journal').reduce((s,t) => s + (t.amount||0), 0) +
      transactions.filter(t => t.source_bank === 'Journal' && _isBankCodeBS(t.account_code))
                  .reduce((s,t) => s + (t.amount||0), 0)
    );

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

    let assetLines  = buildLines('asset',     +1);
    const liabLines   = buildLines('liability', -1);
    const equityLines = buildLines('equity',    -1);

    // Director's loan accounts: when current balance is negative (credit),
    // move the line from assets to liabilities on the balance sheet.
    const loanFlips = [];
    assetLines = assetLines.filter(a => {
      if (/^17\d\d$/.test(a.code) && (a.name || '').toLowerCase().includes('loan') && a.current < 0) {
        loanFlips.push({ ...a, type: 'liability', current: Math.abs(a.current), comparative: Math.abs(a.comparative) });
        return false;
      }
      return true;
    });
    liabLines.push(...loanFlips);

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
function buildCashFlow(transactions, coa, openingBalances, priorYearTransactions, staticComparatives) {
  try {
    const flipJnl = txns => txns.map(t => t.source_bank === 'Journal' ? {...t, amount: -(t.amount||0)} : t);
    const txMap = netByAccount(flipJnl(transactions));

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

    // Net cash movement: regular transactions only + journal lines posted to bank account.
    const _coaByCodeCF = new Map(coa.map(a => [a.account_code, a]));
    const _isBankCodeCF = code => code === '1001' ||
      (_coaByCodeCF.get(code)?.account_name || '').toLowerCase().includes('bank');
    const netMovement = r2(
      transactions.filter(t => t.source_bank !== 'Journal').reduce((s,t) => s + (t.amount||0), 0) +
      transactions.filter(t => t.source_bank === 'Journal' && _isBankCodeCF(t.account_code))
                  .reduce((s,t) => s + (t.amount||0), 0)
    );

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
    const hasPriorTxsCF     = (priorYearTransactions || []).some(t => t.account_code);
    const hasStaticCF       = (staticComparatives || []).length > 0;
    const priorYearAvailable = hasPriorTxsCF || hasStaticCF;
    let priorOperating = 0, priorInvesting = 0, priorFinancing = 0;

    if (hasPriorTxsCF) {
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
    } else if (hasStaticCF) {
      // Static IS comparatives: sum all IS account amounts for prior-year operating.
      // Stored bank-perspective (income positive, expenses negative); sum = net profit.
      for (const ob of staticComparatives) {
        const type = typeByCode.get(ob.account_code);
        if (['income','cost_of_sales','expense'].includes(type)) {
          priorOperating = r2(priorOperating + (ob.amount || 0));
        }
      }
    }

    const priorNetMovement = priorYearAvailable
      ? r2(
          (priorYearTransactions||[]).filter(t => t.source_bank !== 'Journal').reduce((s,t) => s + (t.amount||0), 0) +
          (priorYearTransactions||[]).filter(t => t.source_bank === 'Journal' && _isBankCodeCF(t.account_code)).reduce((s,t) => s + (t.amount||0), 0)
        )
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
function buildTrialBalance(transactions, coa, hideZeros, openingBalances, netProfit, priorYearTransactions, staticComparatives) {
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

    // Locate the client's VAT clearing accounts (if configured). Output VAT
    // collected on income and input VAT paid on expenses is split out of the
    // classified P&L line and posted here instead, so the Income Statement
    // stays VAT-exclusive while the double entry still balances against the
    // full (VAT-inclusive) cash movement through the bank account.
    const vatPayableCOA    = coa.find(a => a.is_active && a.account_type === 'liability' && /vat payable/i.test(a.account_name || ''));
    const vatReceivableCOA = coa.find(a => a.is_active && a.account_type === 'asset'     && /vat receivable/i.test(a.account_name || ''));

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

      if (t.source_bank === 'Journal') {
        // Journal entries: post directly to the named account — no implicit bank leg.
        // Stored convention: amount > 0 = debit to account, amount < 0 = credit to account.
        // A journal line CAN carry vat_type/vat_amount (e.g. a VAT-inclusive capital
        // asset purchase) — when it does, split the VAT portion out to the VAT
        // clearing account, same as a bank-sourced transaction, so the line's
        // `amount` can hold the true VAT-inclusive value for VAT-report purposes
        // while the classified account still only receives the exclusive cost.
        const jVat      = Number(t.vat_amount || 0);
        const jVatable  = jVat > 0 && (t.vat_type === 'output' || t.vat_type === 'input');
        const jExclAbs  = jVatable ? r2(abs - jVat) : abs;
        if ((t.amount || 0) > 0) {
          post(t.account_code, accName, accType, jExclAbs, 0);
          if (jVatable) {
            if (t.vat_type === 'input' && vatReceivableCOA) post(vatReceivableCOA.account_code, vatReceivableCOA.account_name, 'asset', jVat, 0);
            else                                            post(t.account_code, accName, accType, jVat, 0);
          }
        } else {
          post(t.account_code, accName, accType, 0, jExclAbs);
          if (jVatable) {
            if (t.vat_type === 'output' && vatPayableCOA) post(vatPayableCOA.account_code, vatPayableCOA.account_name, 'liability', 0, jVat);
            else                                           post(t.account_code, accName, accType, 0, jVat);
          }
        }
        continue;
      }

      const vat        = Number(t.vat_amount || 0);
      const isVatable   = vat > 0 && (t.vat_type === 'output' || t.vat_type === 'input') &&
                          ['income', 'cost_of_sales', 'expense'].includes(accType);
      const exclAbs     = isVatable ? r2(abs - vat) : abs;

      if ((t.amount || 0) > 0) {
        // Money IN: DR Bank (full inclusive), CR classified account (exclusive)
        // + CR VAT Payable for the output VAT portion, if configured.
        post(bankCode,       bankName, 'asset', abs, 0);
        post(t.account_code, accName,  accType, 0,   exclAbs);
        if (isVatable) {
          if (vatPayableCOA) post(vatPayableCOA.account_code, vatPayableCOA.account_name, 'liability', 0, vat);
          else               post(t.account_code, accName, accType, 0, vat); // no VAT account configured — fall back
        }
      } else {
        // Money OUT: DR classified account (exclusive) + DR VAT Receivable for
        // the input VAT portion, if configured. CR Bank (full inclusive).
        post(t.account_code, accName,  accType, exclAbs, 0);
        post(bankCode,       bankName, 'asset', 0,        abs);
        if (isVatable) {
          if (vatReceivableCOA) post(vatReceivableCOA.account_code, vatReceivableCOA.account_name, 'asset', vat, 0);
          else                  post(t.account_code, accName, accType, vat, 0); // no VAT account configured — fall back
        }
      }
    }

    // Inject opening balances for balance-sheet accounts into the ledger.
    // This ensures accounts with no transactions yet (e.g. loan receivables,
    // equity at period start) still appear in the TB with their correct
    // opening-balance figures. IS accounts (income/COS/expense) are excluded
    // because their OB feeds the comparative IS, not the current-period TB.
    // RE is included here so its opening balance carries through; the synthetic
    // RE injection below is suppressed when OBs are present to avoid
    // double-counting net profit.
    for (const ob of (openingBalances || [])) {
      if (!ob.account_code) continue;
      const coaEntry = coaByCode.get(ob.account_code);
      const accType  = coaEntry?.account_type || 'asset';
      if (!['asset', 'liability', 'equity'].includes(accType)) continue;
      const accName = coaEntry?.account_name || ob.account_name || ob.account_code;
      const amt = r2(ob.amount || 0);
      if (amt > 0)      post(ob.account_code, accName, accType, amt, 0);
      else if (amt < 0) post(ob.account_code, accName, accType, 0, Math.abs(amt));
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

    // NOTE: hideZeros must NEVER filter lines this early. Prior-year (comparative)
    // values are only attached to each line later via _addPrior — filtering on
    // current-year debit/credit here would silently drop any account whose
    // CURRENT balance is zero but whose PRIOR balance is real (e.g. a liability
    // fully offset by this year's journals but with a genuine FY2025 closing
    // balance), corrupting both columns' totals. All group arrays below are
    // built from the FULL unfiltered set; hideZeros is applied only to the
    // final display arrays, after every total has already been computed.
    const filtered = lines;

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
    // Always fold current-year net profit into Retained Earnings, whether or
    // not opening balances exist. When OBs exist, the ledger above only ever
    // posted the OB (prior years') RE balance — it never includes the
    // current year's net profit, so this line is what makes the BS balance
    // against the Income Statement for the current year.
    if (netProfit !== undefined) {
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

    // Director's loan accounts: when net balance is credit (credit > debit),
    // move from assets to liabilities on the balance sheet.
    const loanFlipsTB = [];
    for (let i = assetLines.length - 1; i >= 0; i--) {
      const l = assetLines[i];
      if (/^17\d\d$/.test(l.code) && (l.name || '').toLowerCase().includes('loan') && l.credit > l.debit) {
        loanFlipsTB.push({ ...l, type: 'liability' });
        assetLines.splice(i, 1);
      }
    }
    liabLines.push(...loanFlipsTB);

    // BS derived values
    const totalAssets      = r2(assetLines.reduce((s, l)  => s + l.debit  - l.credit, 0));
    const totalLiabilities = r2(liabLines.reduce((s, l)   => s + l.credit - l.debit,  0));
    const totalEquity      = r2(equityLines.reduce((s, l) => s + l.credit - l.debit,  0));
    // Balance Effect = Assets − (Liabilities + Equity). Zero when BS balances.
    const balanceEffect    = r2(totalAssets - totalLiabilities - totalEquity);

    // ── Prior year double-entry ledger ────────────────────────
    const hasPriorTxsTB     = (priorYearTransactions || []).some(t => t.account_code);
    const hasStaticTB       = (staticComparatives || []).length > 0;
    const priorYearAvailable = hasPriorTxsTB || hasStaticTB;
    const priorLedger = new Map();

    const _postPriorTB = (code, name, type, dr, cr) => {
      if (!priorLedger.has(code)) priorLedger.set(code, { debit: 0, credit: 0 });
      const e = priorLedger.get(code);
      e.debit  = r2(e.debit  + dr);
      e.credit = r2(e.credit + cr);
    };

    if (hasPriorTxsTB) {
      for (const t of (priorYearTransactions || [])) {
        if (!t.account_code) continue;
        const abs = Math.abs(t.amount || 0);
        if (abs === 0) continue;
        const coaEntry = coaByCode.get(t.account_code);
        const accName  = coaEntry?.account_name || t.account_name || t.account_code;
        const accType  = coaEntry?.account_type || 'expense';
        if ((t.amount || 0) > 0) {
          _postPriorTB(bankCode, bankName, 'asset', abs, 0);
          _postPriorTB(t.account_code, accName, accType, 0, abs);
        } else {
          _postPriorTB(t.account_code, accName, accType, abs, 0);
          _postPriorTB(bankCode, bankName, 'asset', 0, abs);
        }
      }
    } else if (hasStaticTB) {
      // Static IS comparatives: post IS accounts directly (no bank leg).
      // Stored bank-perspective: income positive → CR, expense/COS negative → DR.
      for (const ob of staticComparatives) {
        if (!ob.account_code) continue;
        const abs = Math.abs(ob.amount || 0);
        if (abs === 0) continue;
        const coaEntry = coaByCode.get(ob.account_code);
        const accName  = coaEntry?.account_name || ob.account_name || ob.account_code;
        const accType  = coaEntry?.account_type || 'expense';
        if (!['income','cost_of_sales','expense'].includes(accType)) continue;
        if ((ob.amount || 0) > 0) _postPriorTB(ob.account_code, accName, accType, 0, abs); // income → CR
        else                       _postPriorTB(ob.account_code, accName, accType, abs, 0); // expense/COS → DR
      }
    }

    // Balance Sheet prior-year comparative: the FY2026 opening balance IS the
    // FY2025 closing balance, so post asset/liability/equity opening balances
    // into the prior ledger too (mirrors the current-year injection above).
    // Without this, BS lines have no entry in priorLedger and _addPrior zeroes them.
    if (priorYearAvailable) {
      for (const ob of (openingBalances || [])) {
        if (!ob.account_code) continue;
        const coaEntry = coaByCode.get(ob.account_code);
        const accType  = coaEntry?.account_type || 'asset';
        if (!['asset', 'liability', 'equity'].includes(accType)) continue;
        const accName = coaEntry?.account_name || ob.account_name || ob.account_code;
        const amt = r2(ob.amount || 0);
        if (amt > 0)      _postPriorTB(ob.account_code, accName, accType, amt, 0);
        else if (amt < 0) _postPriorTB(ob.account_code, accName, accType, 0, Math.abs(amt));
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
    // Accounting-equation check for the comparative column (FY2025 closing balances
    // should always balance, since they come from the signed AFS).
    const priorBalanceEffect    = r2(priorTotalAssets - priorTotalLiabilities - priorTotalEquity);

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

    // ── hideZeros display filter ───────────────────────────────
    // Applied ONLY now, after every total above has already been computed
    // from the full unfiltered set. A line is hidden only when it has no
    // balance in EITHER column — a real prior-year balance must never be
    // suppressed just because the current-year balance happens to be zero.
    const _hasBalance    = l => l.debit !== 0 || l.credit !== 0 || l.priorDebit !== 0 || l.priorCredit !== 0;
    const _displayFilter = arr => hideZeros ? arr.filter(_hasBalance) : arr;
    const dispIncomeLines = _displayFilter(incomeLines);
    const dispCosLines    = _displayFilter(cosLines);
    const dispExpLines    = _displayFilter(expLines);
    const dispAssetLines  = _displayFilter(assetLines);
    const dispLiabLines   = _displayFilter(liabLines);
    const dispEquityLines = _displayFilter(equityLines);

    // Full line list for CSV/print (includes synthetic RE for display)
    const allLines = [...dispIncomeLines, ...dispCosLines, ...dispExpLines,
                      ...dispAssetLines,  ...dispLiabLines, ...dispEquityLines];

    return {
      ok: true,
      balanced,
      diff,
      data: {
        // IS sub-groups
        incomeLines: dispIncomeLines, cosLines: dispCosLines, expLines: dispExpLines,
        grossIncome, totalCOS, grossProfit, totalExpenses, netProfit,
        // IS prior year subtotals
        priorGrossIncome, priorTotalCOS, priorGrossProfit, priorTotalExpenses, priorNetProfit,
        // BS sub-groups
        assetLines: dispAssetLines, liabLines: dispLiabLines, equityLines: dispEquityLines,
        totalAssets, totalLiabilities, totalEquity, balanceEffect,
        // BS prior year subtotals
        priorTotalAssets, priorTotalLiabilities, priorTotalEquity, priorBalanceEffect,
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
//
// travelOptions (optional): { active: boolean, businessPct: string|number }
//   Same pattern as homeOfficeOptions, applied to the combined Travel
//   (local + overseas) total.
//
// cellPhoneOptions (optional): { active: boolean, businessPct: string|number }
//   Same pattern as homeOfficeOptions, applied to the Cell phone line.
function buildCommissionIS(transactions, hideZeros, incomeOverride, homeOfficeOptions, travelOptions, cellPhoneOptions) {
  try {
    const txMap = netByAccount(transactions);

    const { ITR12_CATEGORIES } = window.RulesEngine;

    const mapLines = (cats) =>
      cats.map(cat => {
        const entry = txMap.get(cat.code);
        const net   = entry ? r2(entry.net) : 0;
        return { ...cat, amount: net }; // spread preserves extra fields like group
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

    let hoSplitData = null; // populated when split fires on a non-zero combined HO amount

    // ── Home office aggregation ─────────────────────────────────
    // Bond Interest / Water / Electricity are individually classifiable
    // (group: 'home_office') for transaction-level audit detail, but SARS's
    // ITR12 wants a single "Home office" figure — so they're summed into ONE
    // combined amount here, with the business-use % applied ONCE to that
    // combined total (not three independent percentages), then rendered as
    // a single line in the same position the old single ITR-EXP-HOM code
    // used to occupy.
    const rawExpenseLines = mapLines(ITR12_CATEGORIES.expenses)
      .map(l => ({ ...l, amount: r2(-l.amount) })); // negative tx amounts → positive display

    const hoMembers    = rawExpenseLines.filter(l => l.group === 'home_office');
    const hoFullAmount = r2(hoMembers.reduce((s, l) => s + l.amount, 0));
    let   hoDisplayAmount = hoFullAmount;

    if (useHOSplit && hoFullAmount > 0) {
      const businessAmount = r2(hoFullAmount * hoPct / 100);
      const personalAmount = r2(hoFullAmount - businessAmount);
      hoSplitData = {
        fullAmount: hoFullAmount, businessAmount, personalAmount, pct: hoPct,
        breakdown: hoMembers.map(l => ({ name: l.name, amount: l.amount })),
      };
      hoDisplayAmount = businessAmount;
    }

    // ── Travel split (same combine-then-split pattern as home office) ──
    const travelActive = !!(travelOptions && travelOptions.active);
    const travelPctRaw = travelActive
      ? parseFloat(String(travelOptions.businessPct || '0').replace(/[^0-9.]/g, ''))
      : null;
    const travelPct    = travelActive && travelPctRaw !== null && !isNaN(travelPctRaw) && travelPctRaw >= 0 && travelPctRaw <= 100
      ? travelPctRaw : null;
    const useTravelSplit = travelPct !== null;

    let travelSplitData = null;

    const travelMembers    = rawExpenseLines.filter(l => l.group === 'travel');
    const travelFullAmount = r2(travelMembers.reduce((s, l) => s + l.amount, 0));
    let   travelDisplayAmount = travelFullAmount;

    if (useTravelSplit && travelFullAmount > 0) {
      const businessAmount = r2(travelFullAmount * travelPct / 100);
      const personalAmount = r2(travelFullAmount - businessAmount);
      travelSplitData = {
        fullAmount: travelFullAmount, businessAmount, personalAmount, pct: travelPct,
        breakdown: travelMembers.map(l => ({ name: l.name, amount: l.amount })),
      };
      travelDisplayAmount = businessAmount;
    }

    // ── Cell phone split ────────────────────────────────────────
    const cellActive = !!(cellPhoneOptions && cellPhoneOptions.active);
    const cellPctRaw = cellActive
      ? parseFloat(String(cellPhoneOptions.businessPct || '0').replace(/[^0-9.]/g, ''))
      : null;
    const cellPct    = cellActive && cellPctRaw !== null && !isNaN(cellPctRaw) && cellPctRaw >= 0 && cellPctRaw <= 100
      ? cellPctRaw : null;
    const useCellSplit = cellPct !== null;

    let cellSplitData = null;
    const cellLine        = rawExpenseLines.find(l => l.code === 'ITR-EXP-CEL');
    const cellFullAmount  = cellLine ? cellLine.amount : 0;
    let   cellDisplayAmount = cellFullAmount;

    if (useCellSplit && cellFullAmount > 0) {
      const businessAmount = r2(cellFullAmount * cellPct / 100);
      const personalAmount = r2(cellFullAmount - businessAmount);
      cellSplitData = { fullAmount: cellFullAmount, businessAmount, personalAmount, pct: cellPct };
      cellDisplayAmount = businessAmount;
    }

    let hoInserted = false;
    let travelInserted = false;
    const expenseLines = rawExpenseLines
      .map(l => {
        if (l.group === 'home_office') {
          if (hoInserted) return null; // drop other HO members — combined into the first slot
          hoInserted = true;
          return { code: 'ITR-EXP-HOM', name: 'Home office', amount: hoDisplayAmount };
        }
        if (l.group === 'travel') {
          if (travelInserted) return null; // drop other travel members — combined into the first slot
          travelInserted = true;
          return { code: 'ITR-EXP-TRV', name: 'Travel', amount: travelDisplayAmount };
        }
        if (l.code === 'ITR-EXP-CEL') {
          return { ...l, amount: cellDisplayAmount };
        }
        return l;
      })
      .filter(l => l !== null)
      .filter(l => !hideZeros || l.amount !== 0);

    const totalExpenses = r2(expenseLines.reduce((s, l) => s + l.amount, 0));
    const netIncome     = r2(totalIncome - totalExpenses);

    // ── Personal / non-deductible (e.g. Drawings) ──────────────
    // Deliberately kept OUT of totalIncome/totalExpenses/netIncome above —
    // these are personal transactions pulled through the business account,
    // not business income or expenses. Shown only as a memo total below
    // the income statement for record-keeping.
    const personalLines = mapLines(ITR12_CATEGORIES.personal || [])
      .map(l => ({ ...l, amount: r2(-l.amount) })) // negative tx amounts → positive display, same convention as expenseLines
      .filter(l => !hideZeros || l.amount !== 0);
    const totalPersonal = r2(personalLines.reduce((s, l) => s + l.amount, 0));

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
        travelSplitActive: useTravelSplit && travelSplitData !== null,
        travelSplitData,   // null when Travel line is zero or split not active
        cellSplitActive:   useCellSplit && cellSplitData !== null,
        cellSplitData,     // null when Cell phone line is zero or split not active
        personalLines,  // memo-only, excluded from netIncome
        totalPersonal,
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

// ── Shared AFS-style helpers ────────────────────────────────────
// Used by renderIS, renderTB, and renderBSFromTB so all three reports
// share identical number formatting, period labels, and account naming.
const _afsRound = n => Math.round(n || 0);
const _afsFmtN  = n => {   // positive display only (structural sign via labels)
  const v = _afsRound(Math.abs(n || 0));
  return v === 0 ? '—' : v.toLocaleString('en-ZA');
};
const _afsFmtB  = n => {   // brackets for losses/negatives
  const v = _afsRound(n || 0);
  if (v === 0) return '—';
  const s = Math.abs(v).toLocaleString('en-ZA');
  return v < 0 ? '(' + s + ')' : s;
};

const _afsParseLbl = lbl => { const p = (lbl||'').split(' '); return { mon: p[1]||'', yr: p[2]||'' }; };
const _AFS_MONTH_FULL = { Jan:'January',Feb:'February',Mar:'March',Apr:'April',May:'May',Jun:'June',
                Jul:'July',Aug:'August',Sep:'September',Oct:'October',Nov:'November',Dec:'December' };
const _AFS_MONTH_NUM  = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
function _afsPeriod(currentLabel, priorLabel) {
  const cur  = _afsParseLbl(currentLabel);
  const mnum = _AFS_MONTH_NUM[cur.mon] || 12;
  const lastDay = cur.yr ? new Date(parseInt(cur.yr), mnum, 0).getDate() : 28;
  const periodStr = cur.yr
    ? `for the year ended ${lastDay} ${_AFS_MONTH_FULL[cur.mon]||cur.mon} ${cur.yr}`
    : '';
  const colCur = cur.yr || (currentLabel || 'Current');
  const colPri = _afsParseLbl(priorLabel).yr || (priorLabel || 'Prior');
  return { periodStr, colCur, colPri };
}

// AFS presentation name overrides — maps account codes to names matching the signed AFS.
const _AFS_NAME = {
  '4001':'Services rendered', '5003':'Funeral expenses',
  '6012':'Computer expenses',
  '6013':'Postage and stationery', '6014':'Rental: office',
  '6016':'Salaries', '6021':'Interest paid',
  '6022':'Members remuneration', '6023':'Fuel',
  '6024':'Rental: motor vehicles',
};
// Only apply the AFS presentation name when the COA still carries the
// default Gabler Group account name for that code — custom accounts
// (e.g. Director's Remuneration on a different client) keep their own name.
const _AFS_DEFAULT_COA = {
  '4001':'Sales / Revenue', '5003':'Funeral Expenses',
  '6012':'Office Expenses', '6013':'Printing & Stationery', '6014':'Rent',
  '6016':'Salaries & Wages', '6021':'Other Expenses',
  '6022':'Members Remuneration', '6023':'Fuel', '6024':'Rental: motor vehicles',
};
const _afsAcctName = l => {
  const override = _AFS_NAME[l.code];
  if (!override) return l.name;
  const defaultName = _AFS_DEFAULT_COA[l.code];
  if (defaultName && l.name && l.name.toLowerCase() !== defaultName.toLowerCase()) return l.name;
  return override;
};
const _AFS_NOTE_ACCT = { '6001':'5', '6021':'8' };

// Build marker — bumped manually whenever financial-outputs.js changes, so a
// stale-cache/stale-build issue can be confirmed or ruled out at a glance by
// comparing what's printed on-screen against what's expected after a sync.
const _AFS_BUILD_TAG = 'BUILD 2026-07-01T01:35Z-hideZeros-fix';

function _afsHeader(clientName, reportTitle, periodStr, opts) {
  const hideBuildTag = !!(opts && opts.hideBuildTag);
  return `<div class="afs-header">
    <div class="afs-entity">${escHtml(clientName || 'Company')}</div>
    <div class="afs-report-title">${escHtml(reportTitle)}</div>
    ${periodStr ? `<div class="afs-period">${escHtml(periodStr)}</div>` : ''}
    <div class="afs-currency-note">Figures in Rand${hideBuildTag ? '' : ` &nbsp;&middot;&nbsp; <span style="opacity:0.55;font-size:0.68rem;">${_AFS_BUILD_TAG}</span>`}</div>
  </div>`;
}

function _afsThead(showComp, colPri, colCur, reverse) {
  const priCell = `<th style="width:25%">${showComp ? escHtml(colPri) : ''}</th>`;
  const curCell = `<th style="width:25%">${escHtml(colCur)}</th>`;
  return `<thead><tr>
    <th class="afs-th-left" style="width:44%">Description</th>
    <th class="afs-th-center" style="width:6%">Note(s)</th>
    ${reverse ? curCell + priCell : priCell + curCell}
  </tr></thead>`;
}

// Renders the Income Statement body rows (Revenue → Net profit) only — no table/header wrapper.
// Shared by renderIS (standalone statement) and renderTB Section 1.
// reverse: AFS pack convention shows current year first, prior year second
// (every other caller keeps the default prior-then-current order).
function _afsISRows(data, showComp, reverse) {
  const { incomeLines, cosLines, expLines,
          totalCOS, cosCom,
          grossProfit, grossProfitCom,
          totalExpenses, expCom,
          netProfit, netProfitCom } = data;

  const amtCells = (cur, pri) => showComp
    ? (reverse ? `<td class="afs-amt">${_afsFmtN(cur)}</td><td class="afs-amt">${_afsFmtN(pri)}</td>`
               : `<td class="afs-amt">${_afsFmtN(pri)}</td><td class="afs-amt">${_afsFmtN(cur)}</td>`)
    : `<td class="afs-amt"></td><td class="afs-amt">${_afsFmtN(cur)}</td>`;
  const amtCellsB = (cur, pri) => showComp
    ? (reverse ? `<td class="afs-amt">${_afsFmtB(cur)}</td><td class="afs-amt">${_afsFmtB(pri)}</td>`
               : `<td class="afs-amt">${_afsFmtB(pri)}</td><td class="afs-amt">${_afsFmtB(cur)}</td>`)
    : `<td class="afs-amt"></td><td class="afs-amt">${_afsFmtB(cur)}</td>`;

  let html = '';

  // ── Revenue section ───────────────────────────────────────────
  html += `<tr class="afs-section-head"><td colspan="4">Revenue</td></tr>`;
  incomeLines.forEach(l => {
    html += `<tr><td class="afs-desc afs-indent">${escHtml(_afsAcctName(l))}</td>
      <td class="afs-nc">6</td>${amtCells(l.current, l.comparative)}</tr>`;
  });
  if (totalCOS !== 0 || (showComp && cosCom !== 0)) {
    // Less: Cost of sales — broken out by component account (e.g. Funeral
    // expenses, Subcontractors), matching the AFS note format. Each line uses
    // the same current/comparative figures already computed for cosLines
    // elsewhere on this report — no separate calculation.
    html += `<tr><td class="afs-desc afs-indent">Less: Cost of sales</td>
      <td class="afs-nc">7</td><td class="afs-amt"></td><td class="afs-amt"></td></tr>`;
    cosLines.forEach(l => {
      html += `<tr><td class="afs-desc afs-indent" style="padding-left:42px;">${escHtml(_afsAcctName(l))}</td>
        <td class="afs-nc"></td>${amtCells(l.current, l.comparative)}</tr>`;
    });
  }
  html += `<tr class="afs-subtotal">
    <td class="afs-desc">Total income</td><td class="afs-nc"></td>
    ${amtCellsB(grossProfit, grossProfitCom)}
  </tr>`;

  // ── Expenses section ──────────────────────────────────────────
  html += `<tr class="afs-spacer"><td colspan="4"></td></tr>`;
  html += `<tr class="afs-section-head"><td colspan="4">Expenses</td></tr>`;

  [...expLines]
    .sort((a, b) => _afsAcctName(a).localeCompare(_afsAcctName(b)))
    .forEach(l => {
      const note = _AFS_NOTE_ACCT[l.code] || '';
      html += `<tr><td class="afs-desc afs-indent">${escHtml(_afsAcctName(l))}</td>
        <td class="afs-nc">${note}</td>${amtCells(l.current, l.comparative)}</tr>`;
    });

  html += `<tr class="afs-subtotal">
    <td class="afs-desc">Total expenses</td><td class="afs-nc"></td>
    ${amtCells(totalExpenses, expCom)}
  </tr>`;

  // ── Net profit / (loss) ───────────────────────────────────────
  html += `<tr class="afs-total">
    <td class="afs-desc">Net profit/(loss) for the year</td><td class="afs-nc"></td>
    ${amtCellsB(netProfit, netProfitCom)}
  </tr>`;

  return html;
}

// Renders the Statement of Financial Position body rows only — no table/header wrapper.
// assetLines/liabLines/equityLines: [{ code, name, current, comparative }]
// totals: { totalAssets, assetsCom, totalLiabilities, liabCom, totalEquity, equityCom }
// Shared by renderTB Section 2 and renderBSFromTB, so the two reports never diverge.
// netProfit: current-year net profit/(loss), already computed live from the IS
// accounts (buildTrialBalance's `netProfit`). Used ONLY to recompute the displayed
// Retained Earnings figure below — never written back to any ledger, journal, or
// transaction. Account 3002's stored balance is read here and never modified.
function _afsBSRows(assetLines, liabLines, equityLines, totals, showComp, netProfit) {
  const { totalAssets, assetsCom, totalLiabilities, liabCom, totalEquity, equityCom } = totals;

  const amtCells = (cur, pri) => showComp
    ? `<td class="afs-amt">${_afsFmtN(pri)}</td><td class="afs-amt">${_afsFmtN(cur)}</td>`
    : `<td class="afs-amt"></td><td class="afs-amt">${_afsFmtN(cur)}</td>`;
  const amtCellsB = (cur, pri) => showComp
    ? `<td class="afs-amt">${_afsFmtB(pri)}</td><td class="afs-amt">${_afsFmtB(cur)}</td>`
    : `<td class="afs-amt"></td><td class="afs-amt">${_afsFmtB(cur)}</td>`;
  // Subtotal/total rows must never render a genuine R0 as "—" (the line-item
  // convention for "no activity") — a calculated zero total is a real result,
  // not missing data, so it always shows the digit "0".
  const _zeroSafe = (formatted, raw) => (Math.abs(_afsRound(raw)) === 0 ? '0' : formatted);
  const amtCellsTotal = (cur, pri) => showComp
    ? `<td class="afs-amt">${_zeroSafe(_afsFmtN(pri), pri)}</td><td class="afs-amt">${_zeroSafe(_afsFmtN(cur), cur)}</td>`
    : `<td class="afs-amt"></td><td class="afs-amt">${_zeroSafe(_afsFmtN(cur), cur)}</td>`;
  const amtCellsTotalB = (cur, pri) => showComp
    ? `<td class="afs-amt">${_zeroSafe(_afsFmtB(pri), pri)}</td><td class="afs-amt">${_zeroSafe(_afsFmtB(cur), cur)}</td>`
    : `<td class="afs-amt"></td><td class="afs-amt">${_zeroSafe(_afsFmtB(cur), cur)}</td>`;

  // Non-current vs current classification (asset side only — see renderTB header comment).
  const _isNonCurrent = l =>
    /loan|investment|property|equipment|vehicle|depreciation|accumulated/i.test(l.name) ||
    (/receivable/i.test(l.name) && !/trade.?receiv|debtor/i.test(l.name)) ||
    (parseInt(l.code) >= 1400 && parseInt(l.code) <= 1999);

  const ncAssets = assetLines.filter(_isNonCurrent);
  const caAssets = assetLines.filter(l => !_isNonCurrent(l));
  const sumCur = arr => r2(arr.reduce((s, l) => s + (l.current || 0), 0));
  const sumPri = arr => r2(arr.reduce((s, l) => s + (l.comparative || 0), 0));
  const ncTotal = sumCur(ncAssets), ncTotalCom = sumPri(ncAssets);
  const caTotal = sumCur(caAssets), caTotalCom = sumPri(caAssets);

  let html = '';

  // ── Assets ─────────────────────────────────────────────────────
  html += `<tr class="afs-section-head"><td colspan="4">Assets</td></tr>`;
  if (ncAssets.length) {
    html += `<tr><td class="afs-desc afs-indent" style="font-style:italic;">Non-current assets</td><td class="afs-nc"></td><td class="afs-amt"></td><td class="afs-amt"></td></tr>`;
    ncAssets.forEach(l => {
      html += `<tr><td class="afs-desc afs-indent" style="padding-left:42px;">${escHtml(_afsAcctName(l))}</td>
        <td class="afs-nc"></td>${amtCells(l.current, l.comparative)}</tr>`;
    });
  }
  if (caAssets.length) {
    html += `<tr><td class="afs-desc afs-indent" style="font-style:italic;">Current assets</td><td class="afs-nc"></td><td class="afs-amt"></td><td class="afs-amt"></td></tr>`;
    caAssets.forEach(l => {
      html += `<tr><td class="afs-desc afs-indent" style="padding-left:42px;">${escHtml(_afsAcctName(l))}</td>
        <td class="afs-nc"></td>${amtCells(l.current, l.comparative)}</tr>`;
    });
  }
  html += `<tr class="afs-total">
    <td class="afs-desc">Total Assets</td><td class="afs-nc"></td>
    ${amtCellsTotalB(totalAssets, assetsCom)}
  </tr>`;

  // ── Liabilities ────────────────────────────────────────────────
  html += `<tr class="afs-spacer"><td colspan="4"></td></tr>`;
  html += `<tr class="afs-section-head"><td colspan="4">Liabilities</td></tr>`;
  if (liabLines.length) {
    html += `<tr><td class="afs-desc afs-indent" style="font-style:italic;">Current liabilities</td><td class="afs-nc"></td><td class="afs-amt"></td><td class="afs-amt"></td></tr>`;
    liabLines.forEach(l => {
      html += `<tr><td class="afs-desc afs-indent" style="padding-left:42px;">${escHtml(_afsAcctName(l))}</td>
        <td class="afs-nc"></td>${amtCells(l.current, l.comparative)}</tr>`;
    });
  }
  html += `<tr class="afs-subtotal">
    <td class="afs-desc">Total Liabilities</td><td class="afs-nc"></td>
    ${amtCellsTotal(totalLiabilities, liabCom)}
  </tr>`;

  // ── Equity ─────────────────────────────────────────────────────
  // Retained Earnings display override (CURRENT column only, calculation only):
  //   Displayed RE = Opening RE (account 3002's actual stored ledger balance,
  //   i.e. l.current as posted from opening_balances) + current-year Net Profit/(Loss),
  //   computed live from the Income Statement. The comparative (prior-year) column
  //   is left untouched — it already reflects the AFS-signed closing position with
  //   no reliable "opening RE" on file to recompute it from.
  // This never writes to 3002, never posts a journal/transaction — display-only.
  const _isRE = l => l.code === '3002' || /retained earnings/i.test(l.name);
  html += `<tr class="afs-spacer"><td colspan="4"></td></tr>`;
  html += `<tr class="afs-section-head"><td colspan="4">Capital and reserves</td></tr>`;
  let totalEquityAdj = totalEquity;
  equityLines.forEach(l => {
    let displayCurrent = l.current;
    if (_isRE(l) && !l.synthetic && typeof netProfit === 'number') {
      const recalculated = r2(l.current + netProfit);
      totalEquityAdj = r2(totalEquityAdj - l.current + recalculated);
      displayCurrent = recalculated;
    }
    html += `<tr><td class="afs-desc afs-indent">${escHtml(_afsAcctName(l))}</td>
      <td class="afs-nc"></td>${amtCells(displayCurrent, l.comparative)}</tr>`;
  });
  html += `<tr class="afs-subtotal">
    <td class="afs-desc">Total Equity</td><td class="afs-nc"></td>
    ${amtCellsTotal(totalEquityAdj, equityCom)}
  </tr>`;

  // ── Total Liabilities and Equity ──────────────────────────────
  const totalLE    = r2(totalLiabilities + totalEquityAdj);
  const totalLECom = r2(liabCom + equityCom);
  html += `<tr class="afs-total">
    <td class="afs-desc">Total Liabilities and Equity</td><td class="afs-nc"></td>
    ${amtCellsTotalB(totalLE, totalLECom)}
  </tr>`;

  // ── Balance Check ────────────────────────────────────────────
  // Live recalculation: Total Assets − Total Liabilities and Equity, per
  // column. Exactly R0.00 → green "Balanced"; anything else → red figure.
  const checkCur = r2(totalAssets - totalLE);
  const checkPri = r2(assetsCom  - totalLECom);
  const checkCell = v => {
    const ok = Math.abs(v) < 0.005;
    return `<td class="afs-amt ${ok ? 'afs-check-ok' : 'afs-check-bad'}">${ok ? 'Balanced' : _afsFmtB(v)}</td>`;
  };
  html += `<tr class="afs-check-row">
    <td class="afs-desc">Balance Check</td><td class="afs-nc"></td>
    ${showComp ? checkCell(checkPri) : '<td class="afs-amt"></td>'}${checkCell(checkCur)}
  </tr>`;

  return html;
}

// Single balancing-check banner, rendered separately from the report table.
// Computed from Assets vs (Liabilities + Equity) for each year independently —
// this is the only place DR/CR-style balancing logic surfaces visually.
function _afsBalanceCheckBanner(curDiff, priDiff, colCur, colPri, showComp) {
  // Cents-precision reconciliation check — deliberately NOT rounded to whole
  // rand like the rest of the AFS-style report, since this is the one place
  // DR/CR balancing logic surfaces and small cent differences matter here.
  const line = (label, diff) => {
    const ok = Math.abs(diff) <= 0.02;
    const amt = Math.abs(r2(diff)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `<span class="afs-bc-item ${ok ? 'ok' : 'bad'}">${escHtml(label)}: ${ok ? 'Balanced' : 'Out of balance by R' + amt}</span>`;
  };
  const items = showComp
    ? `${line(colPri, priDiff)}<span class="afs-bc-sep">&middot;</span>${line(colCur, curDiff)}`
    : line(colCur, curDiff);
  return `<div class="afs-balance-check"><span class="afs-bc-label">Trial Balance Check</span>${items}</div>`;
}

function renderIS(data, currentLabel, priorLabel, hideZeros, opts) {
  const { comparativeAvailable } = data;
  const showComp = !!comparativeAvailable;
  const reverse = !!(opts && opts.reverseColumns);

  const { periodStr, colCur, colPri } = _afsPeriod(currentLabel, priorLabel);

  const clientName = (opts && opts.clientName) || '';
  const brandBar = (opts && opts.title) ? _brandHeader('', clientName, currentLabel, priorLabel) : '';
  const afsHeader = _afsHeader(clientName, 'Detailed Statement of Comprehensive Income', periodStr, opts);
  const thead = _afsThead(showComp, colPri, colCur, reverse);

  const noOuterWrap = !!(opts && opts.noOuterWrap);
  let html = `${noOuterWrap ? '' : '<div class="statement-wrap">'}<div class="afs-wrap">${brandBar}${afsHeader}
    <table class="afs-table">${thead}<tbody>`;
  html += _afsISRows(data, showComp, reverse);
  html += `</tbody></table></div>${noOuterWrap ? '' : '</div>'}`;
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
    totalCOS, grossProfit, totalExpenses, netProfit,
    priorTotalCOS, priorGrossProfit, priorTotalExpenses, priorNetProfit,
    assetLines, liabLines, equityLines,
    totalAssets, totalLiabilities, totalEquity, balanceEffect, priorBalanceEffect,
    priorTotalAssets, priorTotalLiabilities, priorTotalEquity,
    priorYearAvailable,
  } = data;

  const showComp = !!priorYearAvailable;
  const { periodStr, colCur, colPri } = _afsPeriod(currentLabel, priorLabel);

  const clientName = (opts && opts.clientName) || '';
  const brandBar   = (opts && opts.title) ? _brandHeader('', clientName, currentLabel, priorLabel) : '';
  const afsHeader  = _afsHeader(clientName, 'Trial Balance', periodStr);
  const thead      = _afsThead(showComp, colPri, colCur);
  const banner     = _afsBalanceCheckBanner(balanceEffect, priorBalanceEffect, colCur, colPri, showComp);

  let html = `<div class="statement-wrap"><div class="afs-wrap">${brandBar}${afsHeader}${banner}
    <table class="afs-table">${thead}<tbody>`;

  // ── Section 1 — Income Statement ──────────────────────────────
  // Convert TB's DR/CR ledger lines into the {current, comparative} shape
  // _afsISRows expects (income credit-normal, COS/expense debit-normal).
  html += `<tr class="afs-major-head"><td colspan="4">Section 1 — Income Statement</td></tr>`;
  const isViewModel = {
    incomeLines: incomeLines.map(l => ({ ...l, current: r2(l.credit - l.debit), comparative: r2(l.priorCredit - l.priorDebit) })),
    cosLines:    cosLines.map(l    => ({ ...l, current: r2(l.debit - l.credit), comparative: r2(l.priorDebit - l.priorCredit) })),
    expLines:    expLines.map(l    => ({ ...l, current: r2(l.debit - l.credit), comparative: r2(l.priorDebit - l.priorCredit) })),
    totalCOS, cosCom: priorTotalCOS,
    grossProfit, grossProfitCom: priorGrossProfit,
    totalExpenses, expCom: priorTotalExpenses,
    netProfit, netProfitCom: priorNetProfit,
  };
  html += _afsISRows(isViewModel, showComp);

  // ── Section 2 — Statement of Financial Position ───────────────
  const hasBS = (assetLines.length + liabLines.length + equityLines.length) > 0;
  if (hasBS) {
    const toAFS = (arr, sign) => arr.map(l => ({
      ...l,
      current:     r2(sign > 0 ? l.debit - l.credit : l.credit - l.debit),
      comparative: r2(sign > 0 ? l.priorDebit - l.priorCredit : l.priorCredit - l.priorDebit),
    }));
    html += `<tr class="afs-spacer"><td colspan="4"></td></tr>`;
    html += `<tr class="afs-major-head"><td colspan="4">Section 2 — Statement of Financial Position</td></tr>`;
    html += _afsBSRows(
      toAFS(assetLines,  +1),
      toAFS(liabLines,   -1),
      toAFS(equityLines, -1),
      { totalAssets, assetsCom: priorTotalAssets, totalLiabilities, liabCom: priorTotalLiabilities, totalEquity, equityCom: priorTotalEquity },
      showComp,
      netProfit,
    );
  }

  html += '</tbody></table></div></div>';
  return html;
}

// Renders the Statement of Financial Position as a standalone report, using
// the SAME source data and the SAME _afsBSRows body as TB Section 2 — so the
// Balance Sheet report and the Trial Balance never diverge. Pass it the
// `data` object returned by buildTrialBalance (not buildBalanceSheet).
function renderBSFromTB(tbData, currentLabel, priorLabel, opts) {
  const {
    assetLines, liabLines, equityLines,
    totalAssets, totalLiabilities, totalEquity, balanceEffect, priorBalanceEffect,
    priorTotalAssets, priorTotalLiabilities, priorTotalEquity,
    priorYearAvailable, netProfit,
  } = tbData;

  const showComp = !!priorYearAvailable;
  const { periodStr, colCur, colPri } = _afsPeriod(currentLabel, priorLabel);

  const clientName = (opts && opts.clientName) || '';
  const brandBar   = (opts && opts.title) ? _brandHeader('', clientName, currentLabel, priorLabel) : '';
  const afsHeader  = _afsHeader(clientName, 'Statement of Financial Position', periodStr);
  const thead      = _afsThead(showComp, colPri, colCur);
  const banner     = _afsBalanceCheckBanner(balanceEffect, priorBalanceEffect, colCur, colPri, showComp);

  const toAFS = (arr, sign) => arr.map(l => ({
    ...l,
    current:     r2(sign > 0 ? l.debit - l.credit : l.credit - l.debit),
    comparative: r2(sign > 0 ? l.priorDebit - l.priorCredit : l.priorCredit - l.priorDebit),
  }));

  let html = `<div class="statement-wrap"><div class="afs-wrap">${brandBar}${afsHeader}${banner}
    <table class="afs-table">${thead}<tbody>`;
  html += _afsBSRows(
    toAFS(assetLines,  +1),
    toAFS(liabLines,   -1),
    toAFS(equityLines, -1),
    { totalAssets, assetsCom: priorTotalAssets, totalLiabilities, liabCom: priorTotalLiabilities, totalEquity, equityCom: priorTotalEquity },
    showComp,
    netProfit,
  );
  html += '</tbody></table></div></div>';
  return html;
}

// opts.hideCalcDetail: when true, suppress the split-verification breakdown
// panels (income override, home office/travel/cell phone % split workings)
// and show only the category totals. Used for the PDF export so a finalized
// return can be downloaded as a clean totals-only statement; the on-screen
// view always shows the full calculation detail.
function renderCommissionIS(data, hideZeros, opts) {
  const hideCalcDetail = !!(opts && opts.hideCalcDetail);
  const { incomeLines, expenseLines, totalIncome, totalExpenses, netIncome, isLoss,
          overrideActive, overrideAmount, bankIncome,
          hoSplitActive, hoSplitData, travelSplitActive, travelSplitData,
          cellSplitActive, cellSplitData, personalLines, totalPersonal } = data;

  // Commission earner ITR12 statement rounds to the nearest whole rand —
  // shadow the module-level 2-decimal fmt() for the rest of this function only.
  const fmt = fmtR1;

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
  if (overrideActive && !hideCalcDetail) {
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
      if (l.code === 'ITR-EXP-HOM' && hoSplitActive && hoSplitData && !hideCalcDetail) {
        const { fullAmount, businessAmount, personalAmount, pct, breakdown } = hoSplitData;
        const breakdownRows = (breakdown || []).map(b => [`  ${b.name}:`, fmt(b.amount), null]);
        html += notePanel('&#127968;', '--text-muted', '--surface-2', '--border',
          `Home office split — ${pct}% business use`, [
            ...breakdownRows,
            [`Full home office expenses:`, fmt(fullAmount), null],
            [`Business portion (${pct}%):`, fmt(businessAmount), null],
            [`Personal portion (${r2(100 - pct)}%):`, fmt(personalAmount), 'var(--text-muted)'],
            [`Amount on this statement:`, fmt(businessAmount), null],
          ]);
      }
      // Travel split verification panel — shown right after the Travel line
      if (l.code === 'ITR-EXP-TRV' && travelSplitActive && travelSplitData && !hideCalcDetail) {
        const { fullAmount, businessAmount, personalAmount, pct, breakdown } = travelSplitData;
        const breakdownRows = (breakdown || []).map(b => [`  ${b.name}:`, fmt(b.amount), null]);
        html += notePanel('&#128664;', '--text-muted', '--surface-2', '--border',
          `Travel split — ${pct}% business use`, [
            ...breakdownRows,
            [`Full travel expenses:`, fmt(fullAmount), null],
            [`Business portion (${pct}%):`, fmt(businessAmount), null],
            [`Personal portion (${r2(100 - pct)}%):`, fmt(personalAmount), 'var(--text-muted)'],
            [`Amount on this statement:`, fmt(businessAmount), null],
          ]);
      }
      // Cell phone split verification panel — shown right after the Cell phone line
      if (l.code === 'ITR-EXP-CEL' && cellSplitActive && cellSplitData && !hideCalcDetail) {
        const { fullAmount, businessAmount, personalAmount, pct } = cellSplitData;
        html += notePanel('&#128241;', '--text-muted', '--surface-2', '--border',
          `Cell phone split — ${pct}% business use`, [
            [`Full cell phone expenses:`, fmt(fullAmount), null],
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

  html += '</table>';

  // Memo section — personal/non-deductible items (e.g. Drawings). Excluded
  // from Total Income/Total Expenses/Net Income above; shown here purely
  // for record-keeping, visually separated from the income statement itself.
  // Omitted entirely from the totals-only PDF export (hideCalcDetail).
  if (personalLines && personalLines.length && (!hideZeros || totalPersonal !== 0) && !hideCalcDetail) {
    html += `<table class="stmt-table" style="margin-top:14px;">
      <tr class="section-head"><td colspan="3">Memo — Personal (not part of Income Statement)</td></tr>`;
    personalLines.forEach(l => { if (!hideZeros || l.amount !== 0) html += row(l.name, l.amount); });
    html += subtotal('Total Personal / Drawings', totalPersonal, 'subtotal');
    html += '</table>';
  }

  html += '</div>';
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
    <td class="amt">${fmt(netVAT)}</td>
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
// ANNUAL FINANCIAL STATEMENTS (AFS) PACK
// ============================================================
// Statutory-style multi-page pack: cover, index, compilation letter,
// primary statements, accounting policies, notes, detailed IS.
//
// Everything numeric on every page is derived live from buildIncomeStatement /
// buildTrialBalance / buildCashFlow — the SAME engines that drive the
// on-screen reports — so it is structurally impossible for a number here to
// disagree with the Balance Sheet / Income Statement elsewhere in the app.
// Only the following are genuine static inputs, sourced from client Settings
// (never computed, never inferred from transactions):
//   - director name(s) for the approval/compilation-letter signature block
//   - accounting policy paragraph text
// Everything else (firm letterhead, SAICA number, engagement-letter legal
// wording) is a fixed practice constant — identical on every client's pack,
// by design, since it's RandSense's own boilerplate, not client data.
// ============================================================


const _AFS_FIRM = {
  practiceName: 'RandSense',
  slogan: 'Making Cents of It All',
  nicky: { name: 'NICKY LE ROUX', title: 'REGISTERED ACCOUNTING TECHNICIAN (SA)\nREGISTERED TAX PRACTITIONER', cell: '082 717 1049' },
  matthew: { name: 'MATTHEW LE ROUX', title: 'CERTIFIED SENIOR BOOKKEEPER, ICB(SA)', cell: '076 140 8717', email: 'matthewlr25@gmail.com' },
  signatory: 'NH Le Roux',
  signatureText: 'Nicholas Le Roux',
  signatoryRole: 'Signed on behalf of RandSense',
  saicaNo: '30745377',
};

// Temporary fallback until the afs_director_names column is populated via
// Settings (requires the one-time schema migration in schema.sql to have
// been run first) — keyed by client name so it's a no-op the moment the
// real Settings field has a value.
const _AFS_DIRECTOR_FALLBACK = {
  'AJ Forklifts (Pty) Ltd': 'Ashley Johnson',
  'Gabler Group (Pty) Ltd': 'HA Gabler',
};

function _afsMoneyRow(label, code, cur, pri, showComp, opts) {
  opts = opts || {};
  const bold = opts.bold ? 'font-weight:700;' : '';
  // Current year shows first (leftmost), prior year second — AFS pack convention.
  return `<tr>
    <td style="padding:4px 8px;${bold}">${escHtml(label)}</td>
    <td style="padding:4px 8px;text-align:center;color:#555;font-size:0.76rem;">${escHtml(code||'')}</td>
    <td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);${bold}">${cur==null?'':fmtR1(cur)}</td>
    ${showComp ? `<td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);${bold}">${pri==null?'':fmtR1(pri)}</td>` : ''}
  </tr>`;
}

// Assemble every numeric section of the pack from live data. Returns
// { ok, error, data } — data is consumed by renderAFSPack().
function buildAFSPack(opts) {
  try {
    const {
      client, currentYear, coa,
      transactions, priorYearTransactions, openingBalances, staticComparatives,
      priorOpeningBalances,
      directorNames, accountingPolicies,
    } = opts;

    const priorYear    = String(parseInt(currentYear, 10) - 1);
    const currentLabel = yearEndLabel(client.financial_year_end, currentYear);
    const priorLabel   = yearEndLabel(client.financial_year_end, priorYear);
    const { periodStr, colCur, colPri } = _afsPeriod(currentLabel, priorLabel);

    const priorTxsClean = (priorYearTransactions || []).filter(t => t.account_code);

    // Pass the prior year through so isR.data's comparative fields
    // (revComparative / cosCom / expCom / netProfitCom) are actually populated
    // — every note and the SCE below depend on these being real, not zero.
    const isR = buildIncomeStatement(transactions, coa, priorTxsClean, false, staticComparatives);
    if (!isR.ok) return { ok: false, error: 'Income Statement: ' + isR.error };
    const netProfit = isR.data.netProfit;
    const priorNetProfit = isR.data.netProfitCom;

    const tbR = buildTrialBalance(transactions, coa, false, openingBalances, netProfit, priorTxsClean, staticComparatives);
    if (!tbR.ok) return { ok: false, error: 'Trial Balance: ' + tbR.error };

    const cfR = buildCashFlow(transactions, coa, openingBalances, priorTxsClean, staticComparatives);

    // ── Statement of Changes in Equity ──────────────────────────
    // openingRE = this year's opening Retained Earnings (= prior year's
    // closing balance, by definition). Working BACKWARDS from that plus the
    // prior year's own net profit gives the balance b/f at the start of the
    // prior year — exactly two movement rows, matching the two years of
    // comparative data this app actually carries (no synthetic 3rd year).
    const reAcct = coa.find(a => a.is_active && a.account_type === 'equity' &&
      (a.account_code === '3002' || /retained/i.test(a.account_name || '')));
    const obMapCur = buildOpeningMap(openingBalances || []);
    const openingRE = reAcct ? r2(-(obMapCur.get(reAcct.account_code)?.amount || 0)) : 0; // stored credit-sign
    const priorYearAvailable = tbR.data.priorYearAvailable;
    // Fewer, cleaner rows: opening balance, each year's movement, closing
    // balance — skip the redundant intermediate "closing balance of the
    // prior year" row, since it's identical to the current year's opening.
    const sceRows = priorYearAvailable ? [
      { label: `Balance at ${_afsOpeningDate(priorLabel)}`, amount: r2(openingRE - priorNetProfit) },
      { label: `Net profit/(loss) for FY${priorLabel.replace(/\D/g,'')}`, amount: priorNetProfit },
      { label: `Net profit/(loss) for FY${currentLabel.replace(/\D/g,'')}`, amount: netProfit },
      { label: `Balance at ${_afsClosingDateFromLabel(currentLabel, client.financial_year_end)}`, amount: r2(openingRE + netProfit) },
    ] : [
      { label: `Balance at ${_afsOpeningDate(currentLabel)}`, amount: openingRE },
      { label: `Net profit/(loss) for the year`, amount: netProfit },
      { label: `Balance at ${_afsClosingDateFromLabel(currentLabel, client.financial_year_end)}`, amount: r2(openingRE + netProfit) },
    ];

    // ── Notes ────────────────────────────────────────────────────
    const notes = _buildAFSNotesList({ coa, tbR, isR, netProfit });

    return {
      ok: true,
      data: {
        client, currentYear, priorYear, currentLabel, priorLabel, colCur, colPri, periodStr,
        showComp: priorYearAvailable,
        isData: isR.data, tbData: tbR.data, cfData: cfR.ok ? cfR.data : null,
        netProfit, priorNetProfit, openingRE, sceRows, notes,
        directorNames: directorNames || _AFS_DIRECTOR_FALLBACK[client.name] || '',
        accountingPolicies: accountingPolicies || '',
        approvalDate: _afsTodayDMY(),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _afsTodayDMY() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
// currentLabel e.g. "YE Feb 2026" → last day of that month/year, DD Month YYYY
function _afsClosingDateFromLabel(label, feMonth) {
  const m = _afsParseLbl(label);
  if (!m.yr) return label;
  const mnum = _AFS_MONTH_NUM[m.mon] || 12;
  const lastDay = new Date(parseInt(m.yr), mnum, 0).getDate();
  return `${lastDay} ${_AFS_MONTH_FULL[m.mon] || m.mon} ${m.yr}`;
}
// The FIRST day of the financial year that ENDS in the given label's year.
function _afsOpeningDate(label) {
  const m = _afsParseLbl(label);
  if (!m.yr) return label;
  const startYear = parseInt(m.yr, 10) - 1;
  const mnum = _AFS_MONTH_NUM[m.mon] || 12;
  const startMonth = (mnum % 12) + 1; // day after the FYE month
  const startMonthName = Object.keys(_AFS_MONTH_NUM).find(k => _AFS_MONTH_NUM[k] === startMonth) || m.mon;
  return `1 ${_AFS_MONTH_FULL[startMonthName] || startMonthName} ${startYear}`;
}

// Ordered, presence-driven note list. A note only appears when the
// underlying account group actually carries a balance/movement — nothing is
// hardcoded per client, so a note that doesn't apply simply doesn't render.
function _buildAFSNotesList({ coa, tbR, isR, netProfit }) {
  const { assetLines, liabLines } = tbR.data;
  const { incomeLines, cosLines, expLines, revenue, totalCOS, totalExpenses, revComparative, cosCom, expCom, netProfitCom } = isR.data;
  const notes = [];
  // Numbering starts at 2 — Note 1 is "Basis of preparation" on the
  // Accounting Policies page (matches the reference AFS convention).
  let n = 2;

  const hasBal = l => (l.debit||0) || (l.credit||0) || (l.priorDebit||0) || (l.priorCredit||0);

  // Every note below also carries sfpSection + codes: which face-of-Balance-
  // Sheet section it collapses into, and exactly which account codes it
  // claims — renderAFSPack's grouped SFP uses this to show ONE total per
  // note on the statement face, with the full account breakdown only in
  // the note itself (any account no note claims still shows individually,
  // e.g. VAT accounts, so nothing silently disappears from the SFP).

  // 1. Property, Plant and Equipment — any 15xx asset (excl. 1600 control a/c)
  const ppeLines = assetLines.filter(l => /^15\d\d$/.test(l.code) && l.code !== '1600' && hasBal(l));
  if (ppeLines.length) {
    notes.push({
      number: n++, title: 'Property, Plant and Equipment', sfpSection: 'nonCurrentAssets',
      codes: ppeLines.map(l => l.code),
      rows: ppeLines.map(l => ({ label: l.name, current: r2(l.debit - l.credit), prior: r2(l.priorDebit - l.priorCredit) })),
      total: true,
    });
  }

  // 2. Investments and loans — non-current asset accounts (17xx by convention,
  // or explicitly named loan/investment) excluding bank/VAT/PPE. Takes
  // priority over the receivables note below — an account like "Loan
  // Receivable: HA Gabler" is a loan, not a trade debtor, even though its
  // name also contains the word "Receivable".
  const loanAssetLines = assetLines.filter(l =>
    hasBal(l) && !/^15\d\d$/.test(l.code) &&
    (/^17\d\d$/.test(l.code) || /loan|investment/i.test(coa.find(a=>a.account_code===l.code)?.account_name || l.name)) &&
    !/vat|bank/i.test(l.name || ''));
  if (loanAssetLines.length) {
    notes.push({
      number: n++, title: 'Investments and loans', sfpSection: 'nonCurrentAssets',
      codes: loanAssetLines.map(l => l.code),
      rows: loanAssetLines.map(l => ({ label: l.name, current: r2(l.debit - l.credit), prior: r2(l.priorDebit - l.priorCredit) })),
      total: true,
    });
  }

  // 3. Trade and other receivables — debtor-type asset accounts, excluding
  // anything already claimed above as a loan.
  const loanCodes = new Set(loanAssetLines.map(l => l.code));
  const receivableLines = assetLines.filter(l =>
    hasBal(l) && !loanCodes.has(l.code) &&
    (l.code === '1100' || /debtor|receivable/i.test(l.name || '')) && !/vat/i.test(l.name || ''));
  if (receivableLines.length) {
    notes.push({
      number: n++, title: 'Trade and other receivables', sfpSection: 'currentAssets',
      codes: receivableLines.map(l => l.code),
      rows: receivableLines.map(l => ({ label: l.name, current: r2(l.debit - l.credit), prior: r2(l.priorDebit - l.priorCredit) })),
      total: receivableLines.length > 1,
    });
  }

  // 4. Cash and cash equivalents
  const cashLines = assetLines.filter(l => hasBal(l) && (l.code === '1001' || /bank/i.test(l.name || '')));
  if (cashLines.length) {
    notes.push({
      number: n++, title: 'Cash and cash equivalents', sfpSection: 'currentAssets',
      codes: cashLines.map(l => l.code),
      rows: cashLines.map(l => ({ label: l.name, current: r2(l.debit - l.credit), prior: r2(l.priorDebit - l.priorCredit) })),
      total: cashLines.length > 1,
    });
  }

  // 5. Long-term loans — loan/finance liability accounts (vehicle finance,
  // instalment sale agreements etc.) excluding VAT.
  const longTermLoanLines = liabLines.filter(l => hasBal(l) && /loan|finance|instal/i.test(l.name || '') && !/vat/i.test(l.name || ''));
  if (longTermLoanLines.length) {
    notes.push({
      number: n++, title: 'Long-term loans', sfpSection: 'nonCurrentLiabilities',
      codes: longTermLoanLines.map(l => l.code),
      rows: longTermLoanLines.map(l => ({ label: l.name, current: r2(l.credit - l.debit), prior: r2(l.priorCredit - l.priorDebit) })),
      total: longTermLoanLines.length > 1,
    });
  }

  // 6. Trade and other payables — remaining liabilities, excluding VAT/loans
  const payableLines = liabLines.filter(l => hasBal(l) && !/vat|loan|finance|overdraft|instal/i.test(l.name || ''));
  if (payableLines.length) {
    notes.push({
      number: n++, title: 'Trade and other payables', sfpSection: 'currentLiabilities',
      codes: payableLines.map(l => l.code),
      rows: payableLines.map(l => ({ label: l.name, current: r2(l.credit - l.debit), prior: r2(l.priorCredit - l.priorDebit) })),
      total: payableLines.length > 1,
    });
  }

  const nonZeroIS = l => (l.current || 0) || (l.comparative || 0);

  // 5. Revenue / services rendered — income account breakdown
  const revLines = incomeLines.filter(nonZeroIS);
  if (revLines.length) {
    notes.push({
      number: n++, title: 'Revenue',
      rows: revLines.map(l => ({ label: l.name, current: l.current, prior: l.comparative })),
      total: revLines.length > 1,
    });
  }

  // 6. Cost of sales — only if the client actually has any
  const cosLinesNZ = cosLines.filter(nonZeroIS);
  if (cosLinesNZ.length) {
    notes.push({
      number: n++, title: 'Cost of sales',
      rows: cosLinesNZ.map(l => ({ label: l.name, current: l.current, prior: l.comparative })),
      total: true,
    });
  }

  // 7. Interest paid — only if a dedicated "interest" line exists
  // expLines come from buildIncomeStatement (current/comparative), NOT the TB
  // debit/credit shape hasBal() checks — a distinct presence test is needed here.
  const interestLines = expLines.filter(l => ((l.current||0) || (l.comparative||0)) && /interest/i.test(l.name || ''));
  if (interestLines.length) {
    notes.push({
      number: n++, title: 'Interest paid',
      rows: interestLines.map(l => ({ label: l.name, current: l.current, prior: l.comparative })),
      total: interestLines.length > 1,
    });
  }

  // 8. Cash generated in operations — reconciliation to net profit
  notes.push({
    number: n++, title: 'Cash generated in operations',
    rows: [
      { label: 'Revenue', current: revenue, prior: revComparative },
      { label: 'Less: cost of sales', current: r2(-totalCOS), prior: r2(-cosCom) },
      { label: 'Less: operating expenses', current: r2(-totalExpenses), prior: r2(-expCom) },
    ].concat(interestLines.length ? [{ label: 'Add back: interest paid', current: r2(interestLines.reduce((s,l)=>s+(l.current||0),0)), prior: r2(interestLines.reduce((s,l)=>s+(l.comparative||0),0)) }] : []),
    total: true,
    totalOverride: { current: netProfit, prior: netProfitCom },
  });

  return notes;
}

// Grouped Statement of Financial Position — one total line per note,
// individual account lines only for anything no note claims.
function _afsRenderGroupedSFP(d) {
  const c = d.client;
  const { assetLines, liabLines, equityLines, totalAssets, totalLiabilities, totalEquity } = d.tbData;
  const claimedCodes = new Set(d.notes.flatMap(n => n.codes || []));
  const dr = l => r2(l.debit - l.credit);
  const cr = l => r2(l.credit - l.debit);

  // Current year shows first (leftmost), prior year second.
  const row = (label, noteNum, cur, pri) => `<tr>
    <td class="afs-desc" style="padding:4px 8px;">${escHtml(label)}</td>
    <td class="afs-nc" style="padding:4px 8px;text-align:center;color:#555;font-size:0.76rem;">${noteNum||''}</td>
    <td class="afs-amt" style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(cur)}</td>
    ${d.showComp ? `<td class="afs-amt" style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(pri)}</td>` : ''}
  </tr>`;
  const subtotalRow = (label, cur, pri) => `<tr style="border-top:1px solid #999;font-weight:700;">
    <td style="padding:4px 8px;">${escHtml(label)}</td><td></td>
    <td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(cur)}</td>
    ${d.showComp ? `<td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(pri)}</td>` : ''}
  </tr>`;
  const headRow = label => `<tr><td colspan="${d.showComp?4:3}" style="padding:8px 8px 2px;font-weight:700;">${escHtml(label)}</td></tr>`;

  // Individual (unclaimed-by-any-note) lines for a given account array + section filter.
  const individualAssetRows = (predicate) => assetLines
    .filter(l => !claimedCodes.has(l.code) && predicate(l) && (dr(l) || l.priorDebit || l.priorCredit))
    .map(l => row(l.name, '', dr(l), r2(l.priorDebit - l.priorCredit)));
  const individualLiabRows = liabLines
    .filter(l => !claimedCodes.has(l.code) && (cr(l) || l.priorDebit || l.priorCredit))
    .map(l => row(l.name, '', cr(l), r2(l.priorCredit - l.priorDebit)));

  const ncNotes = d.notes.filter(n => n.sfpSection === 'nonCurrentAssets');
  let curAssetNotes = d.notes.filter(n => n.sfpSection === 'currentAssets');
  const curLiabNotes = d.notes.filter(n => n.sfpSection === 'currentLiabilities');
  const ncLiabNotes = d.notes.filter(n => n.sfpSection === 'nonCurrentLiabilities');

  const noteTotal = note => {
    const cur = note.totalOverride ? note.totalOverride.current : r2(note.rows.reduce((s,r)=>s+(r.current||0),0));
    const pri = note.totalOverride ? note.totalOverride.prior   : r2(note.rows.reduce((s,r)=>s+(r.prior||0),0));
    return { cur, pri };
  };

  // A bank account in overdraft at year-end is a liability, not a negative
  // asset — pull the Cash and cash equivalents note out of current assets
  // and show it (sign flipped) under current liabilities instead when its
  // current-year total is negative.
  let overdraftRow = '';
  const cashNoteIdx = curAssetNotes.findIndex(n => n.title === 'Cash and cash equivalents');
  if (cashNoteIdx >= 0) {
    const t = noteTotal(curAssetNotes[cashNoteIdx]);
    if (t.cur < 0) {
      const n = curAssetNotes[cashNoteIdx];
      overdraftRow = row('Bank overdraft', n.number, r2(-t.cur), r2(-t.pri));
      curAssetNotes = curAssetNotes.filter((_, i) => i !== cashNoteIdx);
    }
  }

  // Any asset no note claims (e.g. VAT Receivable, Inventory, Prepaid
  // Expenses) still needs to show SOMEWHERE — classify by name into current
  // vs non-current rather than dropping it, so nothing silently vanishes.
  const _isCurrentByName = l => /vat|debtor|receivable|bank|prepaid|inventory/i.test(l.name || '');
  const nonCurrentAssetRows = ncNotes.map(n => { const t = noteTotal(n); return row(n.title, n.number, t.cur, t.pri); }).join('')
    + individualAssetRows(l => !_isCurrentByName(l)).join('');

  const currentAssetRows = curAssetNotes.map(n => { const t = noteTotal(n); return row(n.title, n.number, t.cur, t.pri); }).join('')
    + individualAssetRows(l => _isCurrentByName(l)).join('');

  const nonCurrentLiabRows = ncLiabNotes.map(n => { const t = noteTotal(n); return row(n.title, n.number, t.cur, t.pri); }).join('');

  const currentLiabRows = overdraftRow
    + curLiabNotes.map(n => { const t = noteTotal(n); return row(n.title, n.number, t.cur, t.pri); }).join('')
    + individualLiabRows.join('');

  const equityRows = equityLines
    .filter(l => cr(l) || l.priorDebit || l.priorCredit)
    .map(l => row(l.name, '', cr(l), r2(l.priorCredit - l.priorDebit))).join('');

  const priorTotalLiabEquity = r2((d.tbData.priorTotalLiabilities||0) + (d.tbData.priorTotalEquity||0));

  return `<div class="afs-wrap">
    ${_afsHeader(c.name, 'Statement of Financial Position', d.periodStr, { hideBuildTag: true })}
    <table class="afs-table">
      <thead><tr>
        <th class="afs-th-left" style="width:44%">Description</th>
        <th class="afs-th-center" style="width:6%">Note(s)</th>
        <th style="width:25%">${escHtml(d.colCur)}</th>
        ${d.showComp ? `<th style="width:25%">${escHtml(d.colPri)}</th>` : ''}
      </tr></thead>
      <tbody>
        ${headRow('Assets')}
        ${headRow('Non-current assets')}
        ${nonCurrentAssetRows}
        ${headRow('Current assets')}
        ${currentAssetRows}
        ${subtotalRow('Total assets', totalAssets, d.tbData.priorTotalAssets)}
        ${headRow('Funds and Liabilities')}
        ${headRow('Capital and reserves')}
        ${equityRows}
        ${subtotalRow('', totalEquity, d.tbData.priorTotalEquity)}
        ${ncLiabNotes.length ? headRow('Non-current liabilities') + nonCurrentLiabRows : ''}
        ${headRow('Current liabilities')}
        ${currentLiabRows}
        ${subtotalRow('Total funds and liabilities', r2(totalLiabilities+totalEquity), priorTotalLiabEquity)}
      </tbody>
    </table>
  </div>`;
}

// ── Render: the full printable pack ─────────────────────────────
function renderAFSPack(d) {
  const c = d.client;
  const page = (title, body, opts) => `
    <div class="statement-wrap afs-page" style="${opts && opts.noBreak ? '' : 'page-break-before:always;'}padding:24px 32px;">
      <div class="afs-wrap">
        ${_afsHeader(c.name, title, d.periodStr, { hideBuildTag: true })}
        ${body}
      </div>
    </div>`;

  // Note renderer — current year first (leftmost), prior year second.
  const renderNote = note => {
    const rows = note.rows.map(r => `<tr>
      <td style="padding:3px 8px;">${escHtml(r.label)}</td>
      <td style="padding:3px 8px;text-align:right;font-family:var(--font-mono);">${r.current==null?'–':fmtR1(r.current)}</td>
      ${d.showComp ? `<td style="padding:3px 8px;text-align:right;font-family:var(--font-mono);">${r.prior==null?'–':fmtR1(r.prior)}</td>` : ''}
    </tr>`).join('');
    const totCur = note.totalOverride ? note.totalOverride.current : r2(note.rows.reduce((s,r)=>s+(r.current||0),0));
    const totPri = note.totalOverride ? note.totalOverride.prior   : r2(note.rows.reduce((s,r)=>s+(r.prior||0),0));
    const totalRow = note.total ? `<tr style="border-top:1px solid #999;font-weight:700;">
      <td style="padding:3px 8px;"></td>
      <td style="padding:3px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(totCur)}</td>
      ${d.showComp ? `<td style="padding:3px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(totPri)}</td>` : ''}
    </tr>` : '';
    // table-layout:fixed with the SAME column widths on every note's table —
    // each note is its own separate <table>, so without fixed widths the
    // browser auto-sizes columns per-note based on that note's own longest
    // label, and the year figures drift left/right note to note even though
    // each table is internally consistent. colgroup keeps every note's
    // number columns landing at the exact same horizontal position.
    const colgroup = d.showComp
      ? `<colgroup><col style="width:56%"><col style="width:22%"><col style="width:22%"></colgroup>`
      : `<colgroup><col style="width:56%"><col style="width:44%"></colgroup>`;
    return `
      <div style="margin-bottom:18px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-weight:700;margin-bottom:4px;">${note.number}. ${escHtml(note.title)}</div>
        <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:0.85rem;">
          ${colgroup}
          <thead><tr style="color:#555;font-size:0.78rem;">
            <td style="padding:2px 8px;">Figures in Rand</td>
            <td style="padding:2px 8px;text-align:right;">${escHtml(d.colCur)}</td>
            ${d.showComp ? `<td style="padding:2px 8px;text-align:right;">${escHtml(d.colPri)}</td>` : ''}
          </tr></thead>
          <tbody>${rows}${totalRow}</tbody>
        </table>
      </div>`;
  };

  // ── Cover ────────────────────────────────────────────────────
  const cover = `
    <div class="statement-wrap afs-page" style="padding:24px 32px;">
      <div class="afs-wrap" style="text-align:center;padding-top:120px;">
        <div style="font-weight:700;color:#145A32;font-size:1.1rem;">RandSense</div>
        <div style="font-size:0.7rem;letter-spacing:0.05em;color:#666;border-bottom:1px solid #ccc;padding-bottom:14px;margin-bottom:60px;">MAKING CENTS OF IT ALL</div>
        <div style="font-size:1.6rem;font-weight:700;color:#145A32;margin-bottom:14px;">${escHtml(c.name)}</div>
        <div style="font-size:1.05rem;">Annual Financial Statements</div>
        <div style="font-size:1.05rem;">for the Year-end ${escHtml(d.currentYear)}</div>
      </div>
    </div>`;

  // ── Index & approval ─────────────────────────────────────────
  const idx = [
    ['Compilation letter', '2-3'], ['Statement of financial position', '4'],
    ['Statement of comprehensive income', '5'], ['Statement of changes in equity', '6'],
    ['Statement of cash flows', '7'], ['Accounting policies', '8'],
    ['Notes to the financial statements', '9'], ['Detailed statement of comprehensive income', '10'],
  ];
  const indexPage = page('Index', `
    <div style="font-size:0.85rem;">
      <p>The reports and statements set out below comprise the annual financial statements presented to members:</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead><tr style="font-weight:700;"><td style="padding:4px 0;">Index</td><td style="padding:4px 0;text-align:right;">Page</td></tr></thead>
        <tbody>${idx.map(([l,p]) => `<tr><td style="padding:3px 0;">${escHtml(l)}</td><td style="padding:3px 0;text-align:right;">${escHtml(p)}</td></tr>`).join('')}</tbody>
      </table>
      <div style="font-weight:700;color:#145A32;border-bottom:2px solid #145A32;padding-bottom:4px;margin-bottom:10px;">Approval and statement of responsibility</div>
      <p>The executive committee members are responsible for the maintenance of adequate accounting records and integrity of the financial statements and related information.</p>
      <p>The executive committee is responsible for the organisation's system of internal financial control. These are designed to provide reasonable, but not absolute, assurance as to the reliability of the financial statements, and to adequately safeguard, verify and maintain accountability of assets, and to prevent and detect misstatement and loss. Nothing has come to the attention of the executive committee to indicate that any material breakdown in the functioning of these controls, procedures and system has occurred during the year under review.</p>
      <p>The financial statements have been prepared on the going concern basis, since the executive committee has every reason to believe that the organisation has adequate resources in place to continue in operation for the foreseeable future.</p>
      <p>The financial statements which appear on pages 5 to 11 were approved by the executive committee on the ${escHtml(d.approvalDate)}.</p>
      <div style="margin-top:36px;max-width:260px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-weight:700;">${escHtml(d.directorNames || '_____________________')}</div>
        <div style="font-style:italic;">(Director)</div>
        <div style="margin-top:10px;">Date: ___________________</div>
      </div>
    </div>`);

  // ── Compilation letter ───────────────────────────────────────
  // .afs-letter p page-break rule keeps a paragraph from being cut mid-
  // sentence across a physical page boundary — a whole paragraph moves to
  // the next page instead if it doesn't fit.
  const letterStyle = `<style>.afs-letter p{page-break-inside:avoid;break-inside:avoid;}</style>`;
  const letterPage1 = page('Compilation Letter', `
    ${letterStyle}
    <div class="afs-letter" style="font-size:0.8rem;line-height:1.35;">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="font-weight:700;color:#145A32;">RandSense</div>
        <div style="font-style:italic;color:#666;">Making Cents of It All</div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
        <div>
          <div style="font-weight:700;">${_AFS_FIRM.nicky.name}</div>
          <div style="white-space:pre-line;">${_AFS_FIRM.nicky.title}</div>
          <div>CELL: NICKY (${_AFS_FIRM.nicky.cell})</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;">${_AFS_FIRM.matthew.name}</div>
          <div>${_AFS_FIRM.matthew.title}</div>
          <div>CELL: MATTHEW (${_AFS_FIRM.matthew.cell})</div>
          <div>Email: ${_AFS_FIRM.matthew.email}</div>
        </div>
      </div>
      <p><strong>Dear ${escHtml(c.name)}:</strong></p>
      <p>This letter will confirm our understanding of the terms and objectives of our engagement and the nature and limitations of the services we will provide.</p>
      <p>We will compile, from information you provide, the balance sheet as of ${escHtml(_afsClosingDateFromLabel(d.currentLabel, c.financial_year_end))}, and the related statements of income, retained earnings, and cash flows of ${escHtml(c.name)} for the year then ended in accordance with International Financial Reporting Standards. We will not audit or review such financial statements. Our services will be limited to presenting in financial statement form information that management represents to us.</p>
      <p>Our report on the financial statements of ${escHtml(c.name)} for ${escHtml(_afsClosingDateFromLabel(d.currentLabel, c.financial_year_end))} is currently expected to read as follows:</p>
      <p>We have compiled the accompanying balance sheet of ${escHtml(c.name)} as of ${escHtml(_afsClosingDateFromLabel(d.currentLabel, c.financial_year_end))} and the related statements of income, retained earnings, and cash flows for the year then ended, in accordance with International Financial Reporting Standards. A compilation is limited to presenting in the form of financial statements information that is the representation of management. We have not audited or reviewed the accompanying financial statements and, accordingly, do not express an opinion or any other form of assurance on them.</p>
      <p>If management elects to omit substantially all disclosures from the financial statements, we will include an additional paragraph that reads as follows:</p>
      <p>Management has elected to omit substantially all of the disclosures required by generally accepted accounting principles and the statement of cash flows. If the omitted disclosures and the statement of cash flows were included in the financial statements, they might influence the users conclusions about the company's financial position, results of operations and cash flows. Accordingly these financial statements are not designed for those who are not informed about such matters.</p>
      <p>If for any reason we are unable to complete the compilation of your financial statements, we will not issue a compilation report on such statements as a result of this engagement.</p>
      <p>A compilation differs significantly from a review or an audit of financial statements. A compilation does not include performing any analytical procedures, inquiry or other procedures performed in a review. In addition, in a compilation one does not seek to obtain an understanding of an entity's internal control or assess fraud risk; test accounting records or examine source documents or other, more detailed procedures ordinarily performed in an audit. As a consequence, we will not express an opinion or provide any assurance regarding the financial statements being compiled.</p>
      <p>Our engagement cannot be relied on to disclose errors, irregularities, or illegal acts, including fraud or embezzlements that may exist. However, we will inform the appropriate level of management of any material errors that come to our attention and any irregularities or illegal acts that come to our attention, unless they are clearly inconsequential.</p>
    </div>`);

  const letterPage2 = page('Compilation Letter (continued)', `
    ${letterStyle}
    <div class="afs-letter" style="font-size:0.8rem;line-height:1.35;">
      <p>You are responsible for adopting sound accounting policies, for maintaining an adequate and efficient accounting system for safeguarding assets, for authorizing transactions and retaining supporting documentation for those transactions and for devising an internal control system that will help assure the proper preparation of financial statements.</p>
      <p>You are also responsible for the design and implementation of programs and controls to prevent and detect fraud and informing us about all known or suspected fraud affecting the Company. In addition, you remain responsible for identifying and ensuring that the Company complies with applicable laws and regulations.</p>
      <p>Our fee for these services will be based on the amount of time required at the standard billing rate plus out of pocket expenses. However, if we encounter unexpected circumstances that require more staff time than anticipated, we will discuss the matter with you. All invoices are due and payable upon presentation.</p>
      <p>If this letter correctly expresses your understanding, please sign the enclosed copy where indicated.</p>
      <p>We appreciate the opportunity to serve you and trust that our association will be a long and pleasant one.</p>
      <div style="margin-top:40px;font-weight:700;page-break-inside:avoid;break-inside:avoid;">Accepted and Agreed by: ${escHtml(c.name)}</div>
      <div style="margin-top:36px;border-top:1px solid #999;padding-top:4px;max-width:280px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-weight:700;">${escHtml(d.directorNames || '_____________________')} (Director)</div>
        <div>Date: ___________________</div>
      </div>
      <div style="margin-top:36px;max-width:280px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-family:'Segoe Script','Brush Script MT','Lucida Handwriting',cursive;font-size:1.7rem;color:#1a1a2e;line-height:1;padding-bottom:2px;">${_AFS_FIRM.signatureText}</div>
        <div style="border-top:1px solid #999;padding-top:4px;">
          <div style="font-weight:700;">${_AFS_FIRM.signatory}</div>
          <div style="font-style:italic;">${_AFS_FIRM.signatoryRole}</div>
          <div>SAICA REGISTRATION NO. ${_AFS_FIRM.saicaNo}</div>
          <div style="margin-top:6px;">Date: ${escHtml(d.approvalDate)}</div>
        </div>
      </div>
    </div>`);

  // ── Statement of Financial Position ───────────────────────────
  // Statutory presentation: each note collapses to ONE total line on the
  // face of the SFP (the account-by-account breakdown lives only in the
  // note) — any account no note claims (e.g. VAT accounts, an unmatched
  // loan liability) still shows individually, so nothing silently drops
  // off the statement. Totals themselves come straight from tbData, so
  // Total Assets / Total Liabilities / Total Equity can never disagree
  // with the on-screen Balance Sheet or the Trial Balance check.
  const sfp = `<div class="statement-wrap afs-page" style="page-break-before:always;padding:24px 32px;">${_afsRenderGroupedSFP(d)}</div>`;

  // ── Statement of Comprehensive Income (summary, 3 lines) ──────
  // "Revenue" here is net of cost of sales (matches grossProfit — i.e. the
  // statutory-pack convention seen on the reference AFS, where cost of sales
  // is folded into revenue and "Operating expenses" is everything else).
  const { totalCOS, totalExpenses, netProfit, grossProfit, grossProfitCom, expCom, netProfitCom } = d.isData;
  const sciRows = [
    _afsMoneyRow('Revenue', '', grossProfit, grossProfitCom, d.showComp),
    _afsMoneyRow('Operating expenses', '', r2(-totalExpenses), r2(-expCom), d.showComp),
  ].join('') + `<tr style="border-top:2px solid #145A32;font-weight:700;">
      <td style="padding:4px 8px;">${netProfit>=0?'Surplus':'Deficit'} for the year</td><td></td>
      <td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(netProfit)}</td>
      ${d.showComp?`<td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(netProfitCom)}</td>`:''}
    </tr>`;
  const sci = page('Statement of Comprehensive Income', `
    <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
      <thead><tr style="font-weight:700;color:#555;font-size:0.78rem;">
        <td style="padding:2px 8px;">Figures in Rand</td><td></td>
        <td style="padding:2px 8px;text-align:right;">${escHtml(d.colCur)}</td>
        ${d.showComp?`<td style="padding:2px 8px;text-align:right;">${escHtml(d.colPri)}</td>`:''}
      </tr></thead>
      <tbody>${sciRows}</tbody>
    </table>`);

  // ── Statement of Changes in Equity ────────────────────────────
  const sceRows = d.sceRows.map((r,i) => `<tr style="${/^Balance/.test(r.label) ? 'font-weight:700;border-top:1px solid #999;border-bottom:1px solid #999;' : ''}">
    <td style="padding:4px 8px;">${escHtml(r.label)}</td>
    <td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(r.amount)}</td>
    <td style="padding:4px 8px;text-align:right;font-family:var(--font-mono);">${fmtR1(r.amount)}</td>
  </tr>`).join('');
  const sce = page('Statement of Changes in Equity', `
    <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
      <thead><tr style="font-weight:700;color:#555;font-size:0.78rem;">
        <td style="padding:2px 8px;">Figures in Rand</td>
        <td style="padding:2px 8px;text-align:right;">Retained earnings</td>
        <td style="padding:2px 8px;text-align:right;">Total funds</td>
      </tr></thead>
      <tbody>${sceRows}</tbody>
    </table>`);

  // ── Statement of Cash Flows ────────────────────────────────────
  let scfBody = `<div style="font-size:0.85rem;color:#555;">Cash flow data unavailable for this period.</div>`;
  if (d.cfData) {
    const cf = d.cfData;
    const line = (label, cur, pri, bold) => _afsMoneyRow(label, '', cur, pri, d.showComp, { bold });
    // Prior year's own opening cash = this year's opening minus the prior
    // year's net movement — the only way to derive it, since only one
    // year's opening balance is ever stored.
    const priorBankOB = d.showComp ? r2(cf.bankOB - (cf.priorNetMovement || 0)) : null;
    scfBody = `<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
      <thead><tr style="font-weight:700;color:#555;font-size:0.78rem;">
        <td style="padding:2px 8px;">Figures in Rand</td>
        <td style="padding:2px 8px;"></td>
        <td style="padding:2px 8px;text-align:right;">${escHtml(d.colCur)}</td>
        ${d.showComp ? `<td style="padding:2px 8px;text-align:right;">${escHtml(d.colPri)}</td>` : ''}
      </tr></thead>
      <tbody>
      <tr><td colspan="4" style="padding:6px 8px;font-weight:700;">Cash flows from operating activities</td></tr>
      ${line('Net cash from operations', cf.operating, cf.priorOperating)}
      <tr><td colspan="4" style="padding:6px 8px;font-weight:700;">Cash flow from investing activities</td></tr>
      ${line('Net cash used in investing', cf.investing, cf.priorInvesting)}
      <tr><td colspan="4" style="padding:6px 8px;font-weight:700;">Cash flow from financing activities</td></tr>
      ${line('Net cash from financing', cf.financing, cf.priorFinancing)}
      ${line('Net increase/(decrease) in cash and cash equivalents', cf.netMovement, cf.priorNetMovement, true)}
      ${line('Cash and cash equivalents at beginning of year', cf.bankOB, priorBankOB)}
      ${line('Cash and cash equivalents at end of year', cf.closingBankBalance, cf.bankOB, true)}
    </tbody></table>`;
  }
  const scf = page('Statement of Cash Flows', scfBody);

  // ── Accounting Policies ────────────────────────────────────────
  const policies = page('Accounting Policies', `
    <div style="font-size:0.85rem;">
      <div style="font-weight:700;color:#145A32;border-bottom:2px solid #145A32;padding-bottom:4px;margin-bottom:10px;">1. Basis of preparation</div>
      <p>The financial statements are prepared on the historical cost basis and incorporate the following accounting policies which are consistent with that of the previous years.</p>
      ${d.accountingPolicies ? `<div style="white-space:pre-line;">${escHtml(d.accountingPolicies)}</div>` : ''}
    </div>`);

  // ── Notes ────────────────────────────────────────────────────
  // Split notes across as many pages as needed by an approximate per-page
  // row budget, so a page that overflows still gets its own proper header
  // ("... (continued)") instead of relying on the browser's automatic,
  // header-less mid-flow page break.
  const NOTES_PER_PAGE_BUDGET = 11; // ~1 unit per note + 1 per row
  const noteChunks = [];
  let chunk = [], weight = 0;
  for (const note of d.notes) {
    const w = 1 + note.rows.length + (note.total ? 1 : 0);
    if (chunk.length && weight + w > NOTES_PER_PAGE_BUDGET) {
      noteChunks.push(chunk);
      chunk = []; weight = 0;
    }
    chunk.push(note); weight += w;
  }
  if (chunk.length) noteChunks.push(chunk);
  const notesPages = (noteChunks.length ? noteChunks : [[]]).map((notesOnPage, i) =>
    page(i === 0 ? 'Notes to the Financial Statements' : 'Notes to the Financial Statements (continued)',
      notesOnPage.map(renderNote).join(''))
  ).join('');

  // ── Detailed Statement of Comprehensive Income (reuse renderIS) ──
  // renderIS also produces a complete self-contained page — same treatment.
  // renderIS's hideZeros param is a no-op (the underlying rows were already
  // built once, up in buildAFSPack, without zero-filtering) — filter here
  // instead: drop a line only when BOTH years are zero, keep it if either
  // year has a real figure. Column order (current year first) is handled
  // by renderIS's own reverseColumns opt — label ARGUMENT order stays
  // correct (currentLabel first) so "for the year ended ..." still reads
  // the right year.
  const _nz = l => (l.current || 0) !== 0 || (l.comparative || 0) !== 0;
  const isDataForDetail = {
    ...d.isData,
    incomeLines: d.isData.incomeLines.filter(_nz),
    cosLines:    d.isData.cosLines.filter(_nz),
    expLines:    d.isData.expLines.filter(_nz),
  };
  const detailedIS = `<div class="statement-wrap afs-page" style="page-break-before:always;padding:24px 32px;">${renderIS(isDataForDetail, d.currentLabel, d.priorLabel, false, { hideBuildTag: true, reverseColumns: true, noOuterWrap: true, clientName: c.name })}</div>`;

  return [cover, indexPage, letterPage1, letterPage2, sfp, sci, sce, scf, policies, notesPages, detailedIS].join('');
}

// ============================================================
// MANAGEMENT REPORT (Commission Earners / Individuals)
// ============================================================
// Sole-proprietor equivalent of the AFS pack. Uses the same
// print pipeline (window.print) and shares branding constants
// with the AFS, but is a completely separate report type.
//
// Contents: Cover → Index & Approval → Compilation Letter →
// Income Statement → Statement of Financial Position → Notes → Declaration.
// ============================================================

function buildManagementReport(opts) {
  try {
    const {
      client, currentYear, transactions,
      hideZeros, incomeOverride, homeOfficeOptions, travelOptions, cellPhoneOptions,
      periodEndDate, closingBankOverride,
    } = opts;

    // Filter transactions to period-end date when specified
    const filteredTx = periodEndDate
      ? transactions.filter(t => t.date <= periodEndDate)
      : transactions;

    const isR = buildCommissionIS(filteredTx, hideZeros, incomeOverride, homeOfficeOptions, travelOptions, cellPhoneOptions);
    if (!isR.ok) return { ok: false, error: 'Income Statement: ' + isR.error };

    const d = isR.data;

    const sortedTx = [...filteredTx].sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
    const firstTx = sortedTx[0];
    const openingBankBalance = firstTx
      ? r2((parseFloat(firstTx.balance) || 0) - (parseFloat(firstTx.amount) || 0))
      : 0;

    const totalFlow = r2(filteredTx.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
    const bankBalance = (closingBankOverride !== undefined) ? r2(closingBankOverride) : r2(openingBankBalance + totalFlow);

    const netProfit = d.netIncome;
    const drawings = d.totalPersonal;

    const unclassifiedTx = filteredTx.filter(t => !t.account_code);
    const unclassifiedTotal = r2(unclassifiedTx.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));

    const openingCapital = r2(bankBalance - netProfit + drawings - unclassifiedTotal);
    const closingCapital = r2(openingCapital + netProfit - drawings + unclassifiedTotal);

    const totalAssets = bankBalance;
    const totalLiabilities = 0;
    const totalCapitalAndLiab = r2(closingCapital + totalLiabilities);

    const balanceDiff = r2(totalAssets - totalCapitalAndLiab);
    const balances = Math.abs(balanceDiff) < 0.01;

    const currentLabel = yearEndLabel(client.financial_year_end, currentYear);
    const today = _afsTodayDMY();

    let periodStr, closingDate;
    if (periodEndDate) {
      const ped = new Date(periodEndDate + 'T00:00:00');
      const _MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      closingDate = `${ped.getDate()} ${_MONTHS[ped.getMonth()]} ${ped.getFullYear()}`;
      periodStr = `for the period ended ${closingDate}`;
    } else {
      closingDate = _afsClosingDateFromLabel(currentLabel, client.financial_year_end);
      const { periodStr: ps } = _afsPeriod(currentLabel, '');
      periodStr = ps;
    }

    // Cash flow data — classify by ITR12 prefix
    const cfOperatingIn = r2(filteredTx.filter(t => t.account_code && t.account_code.startsWith('ITR-INC')).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
    const cfOperatingOut = r2(filteredTx.filter(t => t.account_code && t.account_code.startsWith('ITR-EXP')).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
    const cfOperatingNet = r2(cfOperatingIn + cfOperatingOut);
    const cfFinancing = r2(filteredTx.filter(t => t.account_code && t.account_code.startsWith('ITR-PERS')).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
    const cfUnclassified = unclassifiedTotal;
    const cfNetMovement = r2(cfOperatingNet + cfFinancing + cfUnclassified);
    const cfOpeningBank = r2(bankBalance - cfNetMovement);

    return {
      ok: true,
      data: {
        client, currentYear, currentLabel, periodStr, closingDate, today,
        isData: d, hideZeros,
        bankBalance, openingBankBalance, openingCapital, netProfit, drawings,
        unclassifiedTotal, unclassifiedCount: unclassifiedTx.length,
        closingCapital, totalAssets, totalLiabilities, totalCapitalAndLiab,
        balances, balanceDiff,
        cfOperatingIn, cfOperatingOut, cfOperatingNet, cfFinancing, cfUnclassified, cfNetMovement, cfOpeningBank,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function renderManagementReport(d) {
  const c = d.client;
  const fmt = fmtR1;

  const page = (title, body, opts) => `
    <div class="statement-wrap afs-page" style="${opts && opts.noBreak ? '' : 'page-break-before:always;'}padding:24px 32px;">
      <div class="afs-wrap">
        ${_afsHeader(c.name, title, d.periodStr, { hideBuildTag: true })}
        ${body}
      </div>
    </div>`;

  // Cover
  const cover = `
    <div class="statement-wrap afs-page" style="padding:24px 32px;">
      <div class="afs-wrap" style="text-align:center;padding-top:120px;">
        <div style="font-weight:700;color:#145A32;font-size:1.1rem;">RandSense</div>
        <div style="font-size:0.7rem;letter-spacing:0.05em;color:#666;border-bottom:1px solid #ccc;padding-bottom:14px;margin-bottom:60px;">MAKING CENTS OF IT ALL</div>
        <div style="font-size:1.6rem;font-weight:700;color:#145A32;margin-bottom:14px;">${escHtml(c.name)}</div>
        <div style="font-size:1.05rem;">Management Report</div>
        <div style="font-size:1.05rem;">${escHtml(d.periodStr)}</div>
      </div>
    </div>`;

  // Index & Approval
  const idx = [
    ['Compilation letter', '2-3'],
    ['Statement of Financial Position', '4'],
    ['Cash Flow Statement', '5'],
    ['Income Statement', '6'],
  ];
  const indexPage = page('Index', `
    <div style="font-size:0.85rem;">
      <p>The reports and statements set out below comprise the management report presented to the proprietor:</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead><tr style="font-weight:700;"><td style="padding:4px 0;">Index</td><td style="padding:4px 0;text-align:right;">Page</td></tr></thead>
        <tbody>${idx.map(([l, p]) => `<tr><td style="padding:3px 0;">${escHtml(l)}</td><td style="padding:3px 0;text-align:right;">${escHtml(p)}</td></tr>`).join('')}</tbody>
      </table>
      <div style="font-weight:700;color:#145A32;border-bottom:2px solid #145A32;padding-bottom:4px;margin-bottom:10px;">Approval and Statement of Responsibility</div>
      <p>The sole proprietor is responsible for the maintenance of adequate accounting records and the integrity of the financial information contained herein.</p>
      <p>The sole proprietor is responsible for the organisation's system of internal financial control. These controls are designed to provide reasonable, but not absolute, assurance as to the reliability of the financial information, and to adequately safeguard, verify and maintain accountability of assets, and to prevent and detect misstatement and loss.</p>
      <p>The management report has been prepared on the going concern basis, as the sole proprietor has every reason to believe that the business has adequate resources in place to continue in operation for the foreseeable future.</p>
      <p>The management report which appears on pages 4 to 6 was approved by the sole proprietor.</p>
      <div style="margin-top:36px;max-width:260px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-weight:700;">${escHtml(c.name)}</div>

        <div style="margin-top:10px;">Date: ${escHtml(d.today)}</div>
      </div>
    </div>`);

  // Compilation Letter
  const letterStyle = `<style>.mr-letter p{page-break-inside:avoid;break-inside:avoid;}</style>`;
  const letterPage1 = page('Compilation Letter', `
    ${letterStyle}
    <div class="mr-letter" style="font-size:0.8rem;line-height:1.35;">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="font-weight:700;color:#145A32;">RandSense</div>
        <div style="font-style:italic;color:#666;">Making Cents of It All</div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
        <div>
          <div style="font-weight:700;">${_AFS_FIRM.nicky.name}</div>
          <div style="white-space:pre-line;">${_AFS_FIRM.nicky.title}</div>
          <div>CELL: NICKY (${_AFS_FIRM.nicky.cell})</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;">${_AFS_FIRM.matthew.name}</div>
          <div>${_AFS_FIRM.matthew.title}</div>
          <div>CELL: MATTHEW (${_AFS_FIRM.matthew.cell})</div>
          <div>Email: ${_AFS_FIRM.matthew.email}</div>
        </div>
      </div>
      <p><strong>Dear ${escHtml(c.name)}:</strong></p>
      <p>This letter will confirm our understanding of the terms and objectives of our engagement and the nature and limitations of the services we will provide.</p>
      <p>We will compile, from information you provide, the income statement, statement of financial position and cash flow statement as of ${escHtml(d.closingDate)}, for the period then ended. We will not audit or review such financial statements. Our services will be limited to presenting in financial statement form information that you represent to us.</p>
      <p>Our report on the management report of ${escHtml(c.name)} for ${escHtml(d.closingDate)} is currently expected to read as follows:</p>
      <p>We have compiled the accompanying income statement and statement of financial position of ${escHtml(c.name)} as of ${escHtml(d.closingDate)} for the period then ended. A compilation is limited to presenting in the form of financial statements information that is the representation of the sole proprietor. We have not audited or reviewed the accompanying financial statements and, accordingly, do not express an opinion or any other form of assurance on them.</p>
      <p>If for any reason we are unable to complete the compilation of your management report, we will not issue a compilation report on such statements as a result of this engagement.</p>
      <p>A compilation differs significantly from a review or an audit of financial statements. A compilation does not include performing any analytical procedures, inquiry or other procedures performed in a review. In addition, in a compilation one does not seek to obtain an understanding of an entity's internal control or assess fraud risk; test accounting records or examine source documents or other, more detailed procedures ordinarily performed in an audit. As a consequence, we will not express an opinion or provide any assurance regarding the financial statements being compiled.</p>
      <p>Our engagement cannot be relied on to disclose errors, irregularities, or illegal acts, including fraud or embezzlements that may exist. However, we will inform the appropriate level of management of any material errors that come to our attention and any irregularities or illegal acts that come to our attention, unless they are clearly inconsequential.</p>
    </div>`);

  const letterPage2 = page('Compilation Letter (continued)', `
    ${letterStyle}
    <div class="mr-letter" style="font-size:0.8rem;line-height:1.35;">
      <p>You are responsible for adopting sound accounting policies, for maintaining an adequate and efficient accounting system for safeguarding assets, for authorizing transactions and retaining supporting documentation for those transactions.</p>
      <p>Our fee for these services will be based on the amount of time required at the standard billing rate plus out of pocket expenses. However, if we encounter unexpected circumstances that require more staff time than anticipated, we will discuss the matter with you. All invoices are due and payable upon presentation.</p>
      <p>If this letter correctly expresses your understanding, please sign the enclosed copy where indicated.</p>
      <p>We appreciate the opportunity to serve you and trust that our association will be a long and pleasant one.</p>
      <div style="margin-top:40px;font-weight:700;page-break-inside:avoid;break-inside:avoid;">Accepted and Agreed by: ${escHtml(c.name)}</div>
      <div style="margin-top:36px;border-top:1px solid #999;padding-top:4px;max-width:280px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-weight:700;">${escHtml(c.name)}</div>

        <div>Date: ${escHtml(d.today)}</div>
      </div>
      <div style="margin-top:36px;max-width:280px;page-break-inside:avoid;break-inside:avoid;">
        <div style="font-family:'Segoe Script','Brush Script MT','Lucida Handwriting',cursive;font-size:1.7rem;color:#1a1a2e;line-height:1;padding-bottom:2px;">${_AFS_FIRM.signatureText}</div>
        <div style="border-top:1px solid #999;padding-top:4px;">
          <div style="font-weight:700;">${_AFS_FIRM.signatory}</div>
          <div style="font-style:italic;">${_AFS_FIRM.signatoryRole}</div>
          <div>SAICA REGISTRATION NO. ${_AFS_FIRM.saicaNo}</div>
          <div style="margin-top:6px;">Date: ${escHtml(d.today)}</div>
        </div>
      </div>
    </div>`);

  // Statement of Financial Position (before Income Statement)
  const sfpRow = (label, amount, opts) => {
    const bold = opts && opts.bold;
    const indent = opts && opts.indent;
    const topBorder = opts && opts.topBorder;
    const doubleBorder = opts && opts.doubleBorder;
    const negParen = amount < 0;
    const tight = opts && opts.tight;
    const numStr = fmt(Math.abs(amount)).replace(/R./,'');
    const displayAmt = negParen
      ? '<span style="position:absolute;left:0;">(</span><span style="margin-right:10px;">R ' + numStr + '</span><span style="position:absolute;right:4px;">)</span>'
      : '<span style="margin-right:10px;">R ' + numStr + '</span>';
    const vpad = tight ? '4px' : '10px';
    return '<tr style="' + (bold ? 'font-weight:700;' : '') + (topBorder ? 'border-top:2px solid #145A32;' : '') + (doubleBorder ? 'border-bottom:2px double #145A32;' : '') + '">' +
      '<td style="padding:' + vpad + ' ' + (indent ? '24px' : '12px') + ';font-size:0.88rem;">' + escHtml(label) + '</td>' +
      '<td style="padding:' + vpad + ' 16px ' + vpad + ' 12px;text-align:right;font-size:0.88rem;white-space:nowrap;width:160px;min-width:160px;position:relative;">' + displayAmt + '</td>' +
    '</tr>';
  };
  const sfpSectionHead = label =>
    `<tr><td colspan="2" style="padding:16px 12px 8px;font-weight:700;font-size:0.95rem;color:#145A32;border-bottom:2px solid #145A32;">${escHtml(label)}</td></tr>`;
  const sfpSpacer = `<tr><td colspan="2" style="padding:6px 0;"></td></tr>`;

  let sfpHTML = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><col style="width:auto;"/><col style="width:160px;"/>`;
  sfpHTML += sfpSectionHead('Assets');
  sfpHTML += sfpRow('Bank balance', d.bankBalance, { indent: true });
  sfpHTML += sfpRow('Total Assets', d.totalAssets, { bold: true, topBorder: true, doubleBorder: true });
  sfpHTML += sfpSpacer;

  sfpHTML += sfpSectionHead('Capital Account');
  sfpHTML += sfpRow('Opening balance', d.openingCapital, { indent: true });
  sfpHTML += sfpRow('Net profit / (loss) for the period', d.netProfit, { indent: true });
  sfpHTML += sfpRow('Less: Drawings', r2(-d.drawings), { indent: true });
  if (d.unclassifiedCount > 0) {
    sfpHTML += sfpRow(`Unclassified transactions (${d.unclassifiedCount})`, d.unclassifiedTotal, { indent: true });
  }
  sfpHTML += sfpRow('Closing capital', d.closingCapital, { bold: true, topBorder: true, doubleBorder: true });
  sfpHTML += sfpSpacer;

  sfpHTML += sfpSectionHead('Liabilities');
  sfpHTML += sfpRow('Current liabilities', d.totalLiabilities, { indent: true });
  sfpHTML += sfpRow('Total Capital and Liabilities', d.totalCapitalAndLiab, { bold: true, topBorder: true, doubleBorder: true });
  sfpHTML += `</table>`;

  if (!d.balances) {
    sfpHTML += `<div style="margin-top:20px;padding:12px 16px;background:#FFF3CD;border:1px solid #FFEEBA;border-radius:6px;font-size:0.84rem;color:#856404;">
      <strong>&#9888; Balance discrepancy:</strong> Total Assets (${fmt(d.totalAssets)}) &ne; Capital + Liabilities (${fmt(d.totalCapitalAndLiab)}). Difference: ${fmt(d.balanceDiff)}.
    </div>`;
  }
  const sfpPage = page('Statement of Financial Position', sfpHTML);

  // Cash Flow Statement (between SFP and IS)
  let cfHTML = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><col style="width:auto;"/><col style="width:160px;"/>`;
  cfHTML += sfpSectionHead('Cash flows from operating activities');
  cfHTML += sfpRow('Cash receipts from customers / income', d.cfOperatingIn, { indent: true });
  cfHTML += sfpRow('Cash paid for expenses', d.cfOperatingOut, { indent: true });
  cfHTML += sfpRow('Net cash from operating activities', d.cfOperatingNet, { bold: true, topBorder: true });
  cfHTML += sfpSpacer;
  cfHTML += sfpSectionHead('Cash flows from financing activities');
  cfHTML += sfpRow('Drawings / personal transactions', d.cfFinancing, { indent: true });
  cfHTML += sfpRow('Net cash from financing activities', d.cfFinancing, { bold: true, topBorder: true });
  cfHTML += sfpSpacer;
  if (d.unclassifiedCount > 0) {
    cfHTML += sfpSectionHead('Unclassified cash movements');
    cfHTML += sfpRow(`Unclassified transactions (${d.unclassifiedCount})`, d.cfUnclassified, { indent: true });
    cfHTML += sfpSpacer;
  }
  cfHTML += sfpSectionHead('Summary');
  cfHTML += sfpRow('Net increase / (decrease) in cash', d.cfNetMovement, { indent: true });
  cfHTML += sfpRow('Cash at beginning of period', d.cfOpeningBank, { indent: true });
  cfHTML += sfpRow('Cash at end of period', d.bankBalance, { bold: true, topBorder: true, doubleBorder: true });
  cfHTML += `</table>`;
  const cfPage = page('Cash Flow Statement', cfHTML);

  // Income Statement (after Cash Flow) — built with same sfpRow helpers for visual consistency
  const isD = d.isData;
  let isHTML = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><col style="width:auto;"/><col style="width:160px;"/>`;
  isHTML += sfpSectionHead('Income');
  isD.incomeLines.forEach(l => { if (!d.hideZeros || l.amount !== 0) isHTML += sfpRow(l.name, l.amount, { indent: true, tight: true }); });
  isHTML += sfpRow('Total Income', isD.totalIncome, { bold: true, topBorder: true, tight: true });
  isHTML += sfpSpacer;
  isHTML += sfpSectionHead('Expenses');
  isD.expenseLines.forEach(l => { if (!d.hideZeros || l.amount !== 0) isHTML += sfpRow(l.name, l.amount, { indent: true, tight: true }); });
  isHTML += sfpRow('Total Expenses', isD.totalExpenses, { bold: true, topBorder: true, tight: true });
  isHTML += sfpSpacer;
  isHTML += sfpRow('Net Income', isD.netIncome, { bold: true, topBorder: true, doubleBorder: true, tight: true });
  isHTML += `</table>`;
  const isPage = page('Income Statement', isHTML);

  return [cover, indexPage, letterPage1, letterPage2, sfpPage, cfPage, isPage].join('');
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
  buildAFSPack,
  renderAFSPack,
  renderIS,
  renderBS,
  renderBSFromTB,
  renderCF,
  renderTB,
  renderCommissionIS,
  renderVATReport,
  renderEnhancedVATReport,
  buildManagementReport,
  renderManagementReport,
  // Utilities
  fmt,
  r2,
  netByAccount,
  yearEndLabel,
};

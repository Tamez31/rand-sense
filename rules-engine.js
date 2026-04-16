// ============================================================
// rules-engine.js — Bank rule matching and auto-classification
//
// Rules map description keywords to account codes.
// They are permanent, cumulative, and never auto-deleted.
// Match confidence is tracked via match_count on each rule.
//
// Matching strategy:
//   1. Normalise both description and keyword (lowercase, collapse spaces)
//   2. Substring match — keyword must appear inside the description
//   3. When multiple rules match, the longest keyword wins
//      (more specific rules beat generic ones)
//   4. Tie-break on match_count (higher count = more trusted)
// ============================================================

// ── Text normalisation ────────────────────────────────────────
function normalise(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Find the best matching rule for one description ───────────
// rules: array of rule objects from DB.Rules.list()
// Returns the matched rule object, or null if no match.
function matchRule(description, rules) {
  const normDesc = normalise(description);
  let best = null;

  for (const rule of rules) {
    const normKeyword = normalise(rule.keyword);
    if (!normKeyword) continue;
    if (!normDesc.includes(normKeyword)) continue;

    // We have a match. Pick it if it's better than current best.
    if (!best) {
      best = rule;
      continue;
    }

    // Longer keyword = more specific = preferred
    if (normKeyword.length > normalise(best.keyword).length) {
      best = rule;
      continue;
    }

    // Equal length: higher match_count wins
    if (
      normKeyword.length === normalise(best.keyword).length &&
      (rule.match_count || 0) > (best.match_count || 0)
    ) {
      best = rule;
    }
  }

  return best;
}

// ── Apply rules to a batch of raw parsed transactions ─────────
// parsedRows:  output from csv-parsers.js  [{ date, description, amount, balance }]
// rules:       from DB.Rules.list(clientId)
// clientId, financialYear, period, sourceBank: import context
//
// Returns:
// {
//   classified:   [transaction rows ready to insert, with account_code set]
//   unmatched:    [transaction rows without account_code — need manual review]
//   matchedRuleIds: [rule ids that fired — for incrementing match_count]
// }
function applyRules(parsedRows, rules, clientId, financialYear, period, sourceBank) {
  const classified     = [];
  const unmatched      = [];
  const matchedRuleIds = [];

  for (const row of parsedRows) {
    const base = {
      client_id:      clientId,
      date:           row.date,
      description:    row.description,
      amount:         round2(row.amount),
      balance:        row.balance !== null && row.balance !== undefined ? round2(row.balance) : null,
      source_bank:    sourceBank,
      financial_year: financialYear,
      period:         period,
      is_reconciled:  false,
    };

    const rule = matchRule(row.description, rules);

    if (rule) {
      classified.push({
        ...base,
        account_code: rule.account_code,
        account_name: rule.account_name,
        vat_type:     rule.vat_type || 'none',
        vat_amount:   0, // VAT amount calculated separately by vat-module.js
      });
      matchedRuleIds.push(rule.id);
    } else {
      unmatched.push({
        ...base,
        account_code: null,
        account_name: null,
        vat_type:     'none',
        vat_amount:   0,
      });
    }
  }

  return { classified, unmatched, matchedRuleIds };
}

// ── Deduplicate matched rule IDs before incrementing ──────────
// We only want to increment each rule once per import batch,
// not once per transaction matched (that would skew counts).
function uniqueRuleIds(ids) {
  return [...new Set(ids)];
}

// ── Build a keyword from a description ───────────────────────
// When the user manually classifies a transaction, we suggest
// a keyword extracted from the description.
// Strategy: take the first meaningful word-group (up to 3 words),
// stripping common noise tokens like dates, amounts, and reference numbers.
const NOISE_TOKENS = new Set([
  'ref', 'reference', 'payment', 'transfer', 'trfr', 'trf',
  'debit', 'credit', 'order', 'debit order', 'internet',
  'pos', 'atm', 'eft', 'int', 'ac', 'acc', 'no',
]);

function suggestKeyword(description) {
  const words = normalise(description)
    .split(' ')
    .filter(w => {
      if (!w) return false;
      if (NOISE_TOKENS.has(w)) return false;
      if (/^\d+$/.test(w)) return false;       // pure numbers
      if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return false; // dates
      return true;
    });

  // Take up to 3 meaningful words as the keyword suggestion
  return words.slice(0, 3).join(' ');
}

// ── Validate a new rule before saving ────────────────────────
// Returns null if valid, or an error string if not.
function validateRule(keyword, accountCode, accountName) {
  if (!keyword || keyword.trim().length < 2) {
    return 'Keyword must be at least 2 characters.';
  }
  if (!accountCode || !accountCode.trim()) {
    return 'Account code is required.';
  }
  if (!accountName || !accountName.trim()) {
    return 'Account name is required.';
  }
  return null;
}

// ── Check for duplicate rules ────────────────────────────────
// Returns the existing rule if keyword already exists for client, else null.
function findDuplicateRule(keyword, existingRules) {
  const normNew = normalise(keyword);
  return existingRules.find(r => normalise(r.keyword) === normNew) || null;
}

// ── Bulk apply + persist via DB layer ────────────────────────
// Full import pipeline: parse → apply rules → save to DB → increment counts.
// Returns a summary object for the UI.
async function runImportPipeline(params) {
  const {
    parsedRows,
    clientId,
    financialYear,
    period,
    sourceBank,
    vatType,       // 'input' | 'output' | 'none'  (user selection at import)
    vatActive,     // boolean — is VAT enabled for this client?
  } = params;

  if (!parsedRows || parsedRows.length === 0) {
    return { ok: false, error: 'No rows to import.' };
  }

  try {
    // 1. Load current rules
    const rules = await window.DB.Rules.list(clientId);

    // 2. Apply rules to parsed rows
    const { classified, unmatched, matchedRuleIds } = applyRules(
      parsedRows,
      rules,
      clientId,
      financialYear,
      period,
      sourceBank
    );

    // 3. Apply VAT to classified rows if VAT is active
    //    (vat_amount is computed in vat-module.js if vatActive)
    let allRows = [...classified, ...unmatched];
    if (vatActive && vatType && vatType !== 'none') {
      allRows = allRows.map(row => {
        // Only apply VAT to classified income/expense rows; not to asset/liability rows.
        // vat-module will refine this — for now tag the import-level VAT type.
        if (row.account_code) {
          return {
            ...row,
            vat_type:   vatType,
            vat_amount: window.VAT ? window.VAT.extractVAT(row.amount) : 0,
          };
        }
        return row;
      });
    }

    // 4. Insert all rows into the database (transactions accumulate — never replaced)
    const saved = await window.DB.Transactions.insertBatch(allRows);

    // 5. Increment match counts for rules that fired
    const uniqueIds = uniqueRuleIds(matchedRuleIds);
    if (uniqueIds.length > 0) {
      await window.DB.Rules.incrementBatch(uniqueIds);
    }

    return {
      ok:           true,
      total:        saved.length,
      autoClassified: classified.length,
      unmatched:    unmatched.length,
      rulesApplied: uniqueIds.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Save a manual classification + create rule ────────────────
// Called when the user classifies an unmatched transaction.
//
// After saving the rule, immediately scans ALL other unclassified
// transactions for the same client and batch-classifies every match.
// This ensures the rule applies retroactively to existing unclassified
// transactions as well as all future imports.
//
// Returns { ok, ruleCreated, ruleReused, rule, autoCount }
//   autoCount = number of additional transactions auto-classified
async function classifyAndSaveRule(params) {
  const {
    transactionId,
    clientId,
    accountCode,
    accountName,
    vatType,
    vatAmount,
    keyword,          // suggested keyword — user may have edited it
    saveAsRule,       // boolean
    existingRules,
    allUnclassified,  // all currently unclassified txs for this client
  } = params;

  // 1. Classify the target transaction
  await window.DB.Transactions.classify(
    transactionId,
    accountCode,
    accountName,
    vatType || 'none',
    vatAmount || 0
  );

  let ruleCreated = false;
  let ruleReused  = false;
  let savedRule   = null;
  let autoCount   = 0;

  // 2. Save (or reuse) the rule
  if (saveAsRule && keyword && keyword.trim().length >= 2) {
    const validationError = validateRule(keyword, accountCode, accountName);
    if (validationError) {
      return { ok: true, ruleError: validationError, autoCount: 0 };
    }

    const duplicate = findDuplicateRule(keyword, existingRules);
    if (duplicate) {
      // Rule already exists — reuse it; still run retroactive scan below
      ruleReused = true;
      savedRule  = duplicate;
    } else {
      savedRule = await window.DB.Rules.create({
        client_id:    clientId,
        keyword:      keyword.trim(),
        account_code: accountCode,
        account_name: accountName,
        vat_type:     vatType || 'none',
        match_count:  1,
      });
      ruleCreated = true;
    }
  }

  // 3. Retroactively apply the rule to ALL other unclassified transactions
  //    This covers both existing unclassified rows AND ensures the rule is
  //    ready for future imports before the user sees them.
  if (savedRule && allUnclassified && allUnclassified.length > 0) {
    // Exclude the transaction we just classified manually
    const others  = allUnclassified.filter(t => t.id !== transactionId);
    // Find every other transaction whose description matches the keyword
    const matched = others.filter(t => matchRule(t.description, [savedRule]));

    if (matched.length > 0) {
      const updates = matched.map(t => ({
        id:           t.id,
        account_code: accountCode,
        account_name: accountName,
        vat_type:     vatType || 'none',
        // Compute VAT on each transaction's actual amount
        vat_amount:   (vatType && vatType !== 'none')
          ? window.VAT.extractVAT(t.amount)
          : 0,
      }));

      // Batch-write all classifications in parallel
      await window.DB.Transactions.classifyBatch(updates);

      // Bump match_count by the number of extra matches in one DB call
      await window.DB.Rules.incrementBy(savedRule.id, matched.length);

      autoCount = matched.length;
    }
  }

  return { ok: true, ruleCreated, ruleReused, rule: savedRule, autoCount };
}

// ── Commission earner: simple manual allocation ───────────────
// Commission earners have no rules engine.
// This just classifies the transaction with the chosen ITR12 category.
async function classifyCommissionTransaction(transactionId, category) {
  if (!category) return { ok: false, error: 'No category selected.' };
  await window.DB.Transactions.classify(
    transactionId,
    category.code,
    category.name,
    'none',
    0
  );
  return { ok: true };
}

// ── ITR12 categories (hardcoded per spec) ─────────────────────
const ITR12_CATEGORIES = {
  income: [
    { code: 'ITR-INC-COMM', name: 'Commission received' },
    { code: 'ITR-INC-OTH',  name: 'Other income' },
  ],
  expenses: [
    { code: 'ITR-EXP-ACC',  name: 'Accounting fees' },
    { code: 'ITR-EXP-ADV',  name: 'Advertising' },
    { code: 'ITR-EXP-BAD',  name: 'Bad debts' },
    { code: 'ITR-EXP-BNK',  name: 'Bank charges' },
    { code: 'ITR-EXP-CEL',  name: 'Cell phone' },
    { code: 'ITR-EXP-DEP',  name: 'Depreciation / Wear & tear' },
    { code: 'ITR-EXP-ENT',  name: 'Entertainment' },
    { code: 'ITR-EXP-HOM',  name: 'Home office' },
    { code: 'ITR-EXP-INS',  name: 'Insurance' },
    { code: 'ITR-EXP-INT',  name: 'Internet' },
    { code: 'ITR-EXP-LEG',  name: 'Legal fees' },
    { code: 'ITR-EXP-MOT',  name: 'Motor vehicle expenses' },
    { code: 'ITR-EXP-POS',  name: 'Postage & courier' },
    { code: 'ITR-EXP-PRI',  name: 'Printing & stationery' },
    { code: 'ITR-EXP-SAL',  name: 'Salaries & wages' },
    { code: 'ITR-EXP-SUB',  name: 'Subscriptions' },
    { code: 'ITR-EXP-TRL',  name: 'Travel - local' },
    { code: 'ITR-EXP-TRO',  name: 'Travel - overseas' },
    { code: 'ITR-EXP-UNI',  name: 'Uniforms / protective clothing' },
    { code: 'ITR-EXP-OTH',  name: 'Other expenses' },
  ],
};

// Flat list for lookup by code
const ITR12_ALL = [...ITR12_CATEGORIES.income, ...ITR12_CATEGORIES.expenses];
function getITR12Category(code) {
  return ITR12_ALL.find(c => c.code === code) || null;
}

// ── Utility ───────────────────────────────────────────────────
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ============================================================
// EXPORTS
// ============================================================
window.RulesEngine = {
  matchRule,
  applyRules,
  suggestKeyword,
  validateRule,
  findDuplicateRule,
  runImportPipeline,
  classifyAndSaveRule,
  classifyCommissionTransaction,
  ITR12_CATEGORIES,
  ITR12_ALL,
  getITR12Category,
  // Exposed for testing
  _normalise:       normalise,
  _uniqueRuleIds:   uniqueRuleIds,
};

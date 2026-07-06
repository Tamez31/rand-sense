// ============================================================
// supabase-client.js — Rand Sense data layer
// All Supabase reads/writes go through this module.
// ============================================================

const SUPABASE_URL = 'https://tdmvypmwibnqfhvqhzxs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_BueRizNjkXMlAm4XOSnWfQ_omfe001x';

let _sb = null;

function getClient() {
  if (!_sb) {
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _sb;
}

// ── Helpers ──────────────────────────────────────────────────

function unwrap(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

// ============================================================
// CLIENTS
// ============================================================

const Clients = {
  async list() {
    const sb = getClient();
    return unwrap(await sb.from('clients').select('*').order('name'));
  },

  async get(id) {
    const sb = getClient();
    const rows = unwrap(await sb.from('clients').select('*').eq('id', id));
    return rows[0] || null;
  },

  async create(data) {
    const sb = getClient();
    const rows = unwrap(await sb.from('clients').insert([data]).select());
    return rows[0];
  },

  async update(id, data) {
    const sb = getClient();
    const rows = unwrap(await sb.from('clients').update(data).eq('id', id).select());
    return rows[0];
  },

  async delete(id) {
    const sb = getClient();
    unwrap(await sb.from('clients').delete().eq('id', id));
  },
};

// ============================================================
// TRANSACTIONS
// ============================================================

// Supabase/PostgREST caps any single unpaginated request at 1000 rows
// (server-side db-max-rows default). Any client-year with more than 1000
// transactions was silently truncated to its first 1000 rows (by date) —
// confirmed directly: FY2025 (1611 rows) cut off at 2024-10-01, FY2024
// (1187 rows) cut off at 2023-12-30, both dropping the tail of the year
// from every report built on top of listByYear/listByPeriod/listUnclassified.
// Loop with .range() until a page returns fewer than pageSize rows.
async function fetchAllPages(queryBuilder) {
  const pageSize = 1000;
  let all = [];
  let offset = 0;
  while (true) {
    const page = unwrap(await queryBuilder.range(offset, offset + pageSize - 1));
    all = all.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

const Transactions = {
  // Insert many at once (bank import batch)
  async insertBatch(rows) {
    const sb = getClient();
    return unwrap(await sb.from('transactions').insert(rows).select());
  },

  // All transactions for a client in a financial year
  async listByYear(clientId, financialYear) {
    const sb = getClient();
    return fetchAllPages(
      sb
        .from('transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
        .order('date')
    );
  },

  // All transactions for a client in a specific period
  async listByPeriod(clientId, financialYear, period) {
    const sb = getClient();
    return fetchAllPages(
      sb
        .from('transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
        .eq('period', period)
        .order('date')
    );
  },

  // Unclassified transactions (no account_code) for a client
  async listUnclassified(clientId) {
    const sb = getClient();
    return fetchAllPages(
      sb
        .from('transactions')
        .select('*')
        .eq('client_id', clientId)
        .is('account_code', null)
        .order('date')
    );
  },

  // Classify a single transaction (apply account + optional VAT)
  async classify(id, accountCode, accountName, vatType, vatAmount, vatCode) {
    const sb = getClient();
    return unwrap(
      await sb
        .from('transactions')
        .update({
          account_code: accountCode,
          account_name: accountName,
          vat_type:     vatType  || 'none',
          vat_amount:   vatAmount || 0,
          vat_code:     vatCode  || 0,
        })
        .eq('id', id)
        .select()
    );
  },

  // Bulk-classify many transactions at once (rules engine result)
  async classifyBatch(updates) {
    // updates = [{ id, account_code, account_name, vat_type, vat_amount, vat_code }, ...]
    const sb = getClient();
    const promises = updates.map(u =>
      sb
        .from('transactions')
        .update({
          account_code: u.account_code,
          account_name: u.account_name,
          vat_type:     u.vat_type  || 'none',
          vat_amount:   u.vat_amount || 0,
          vat_code:     u.vat_code  || 0,
        })
        .eq('id', u.id)
    );
    const results = await Promise.all(promises);
    results.forEach(r => { if (r.error) throw new Error(r.error.message); });
  },

  // All distinct financial years for a client (for year selector)
  async listYears(clientId) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('transactions')
        .select('financial_year')
        .eq('client_id', clientId)
    );
    const years = [...new Set(rows.map(r => r.financial_year))].sort().reverse();
    return years;
  },

  // Count of unclassified transactions for a client (header-only, no row data)
  async countUnclassified(clientId) {
    const sb = getClient();
    const r  = await sb
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .is('account_code', null);
    if (r.error) throw new Error(r.error.message);
    return r.count || 0;
  },

  // Most recent transaction date for a client (used on Practice Dashboard)
  async lastImportDate(clientId) {
    const sb = getClient();
    const r  = await sb
      .from('transactions')
      .select('date')
      .eq('client_id', clientId)
      .order('date', { ascending: false })
      .limit(1);
    if (r.error) throw new Error(r.error.message);
    return (r.data || [])[0]?.date || null;
  },
};

// ============================================================
// CHART OF ACCOUNTS
// ============================================================

const COA = {
  async list(clientId) {
    const sb = getClient();
    return unwrap(
      await sb
        .from('chart_of_accounts')
        .select('*')
        .eq('client_id', clientId)
        .eq('is_active', true)
        .order('account_code')
    );
  },

  async create(data) {
    const sb = getClient();
    const rows = unwrap(await sb.from('chart_of_accounts').insert([data]).select());
    return rows[0];
  },

  async update(id, data) {
    const sb = getClient();
    const rows = unwrap(await sb.from('chart_of_accounts').update(data).eq('id', id).select());
    return rows[0];
  },

  async deactivate(id) {
    const sb = getClient();
    unwrap(await sb.from('chart_of_accounts').update({ is_active: false }).eq('id', id));
  },

  // Seed a default chart of accounts for a new company client
  async seedDefaults(clientId) {
    const defaults = [
      // Income
      { client_id: clientId, account_code: '4001', account_name: 'Sales / Revenue',       account_type: 'income' },
      { client_id: clientId, account_code: '4002', account_name: 'Other Income',           account_type: 'income' },
      // Cost of Sales
      { client_id: clientId, account_code: '5001', account_name: 'Cost of Goods Sold',     account_type: 'cost_of_sales' },
      { client_id: clientId, account_code: '5002', account_name: 'Direct Labour',          account_type: 'cost_of_sales' },
      { client_id: clientId, account_code: '5003', account_name: 'Funeral Expenses',       account_type: 'cost_of_sales' },
      { client_id: clientId, account_code: '5004', account_name: 'Subcontractors',         account_type: 'cost_of_sales' },
      // Expenses
      { client_id: clientId, account_code: '6001', account_name: 'Accounting Fees',        account_type: 'expense' },
      { client_id: clientId, account_code: '6002', account_name: 'Advertising',            account_type: 'expense' },
      { client_id: clientId, account_code: '6003', account_name: 'Bad Debts',              account_type: 'expense' },
      { client_id: clientId, account_code: '6004', account_name: 'Bank Charges',           account_type: 'expense' },
      { client_id: clientId, account_code: '6005', account_name: 'Cell Phone',             account_type: 'expense' },
      { client_id: clientId, account_code: '6006', account_name: 'Depreciation / Wear & Tear', account_type: 'expense' },
      { client_id: clientId, account_code: '6007', account_name: 'Entertainment',          account_type: 'expense' },
      { client_id: clientId, account_code: '6008', account_name: 'Insurance',              account_type: 'expense' },
      { client_id: clientId, account_code: '6009', account_name: 'Internet',               account_type: 'expense' },
      { client_id: clientId, account_code: '6010', account_name: 'Legal Fees',             account_type: 'expense' },
      { client_id: clientId, account_code: '6011', account_name: 'Motor Vehicle Expenses', account_type: 'expense' },
      { client_id: clientId, account_code: '6012', account_name: 'Office Expenses',        account_type: 'expense' },
      { client_id: clientId, account_code: '6013', account_name: 'Printing & Stationery',  account_type: 'expense' },
      { client_id: clientId, account_code: '6014', account_name: 'Rent',                   account_type: 'expense' },
      { client_id: clientId, account_code: '6015', account_name: 'Repairs & Maintenance',  account_type: 'expense' },
      { client_id: clientId, account_code: '6016', account_name: 'Salaries & Wages',       account_type: 'expense' },
      { client_id: clientId, account_code: '6017', account_name: 'Subscriptions',          account_type: 'expense' },
      { client_id: clientId, account_code: '6018', account_name: 'Telephone',              account_type: 'expense' },
      { client_id: clientId, account_code: '6019', account_name: 'Travel - Local',         account_type: 'expense' },
      { client_id: clientId, account_code: '6020', account_name: 'Utilities',              account_type: 'expense' },
      { client_id: clientId, account_code: '6021', account_name: 'Other Expenses',         account_type: 'expense' },
      // Assets
      { client_id: clientId, account_code: '1001', account_name: 'Bank Account',           account_type: 'asset' },
      { client_id: clientId, account_code: '1100', account_name: 'Trade Debtors',          account_type: 'asset' },
      { client_id: clientId, account_code: '1200', account_name: 'Inventory',              account_type: 'asset' },
      { client_id: clientId, account_code: '1300', account_name: 'Prepaid Expenses',       account_type: 'asset' },
      { client_id: clientId, account_code: '1500', account_name: 'Property, Plant & Equipment', account_type: 'asset' },
      { client_id: clientId, account_code: '1600', account_name: 'Accumulated Depreciation', account_type: 'asset' },
      { client_id: clientId, account_code: '1700', account_name: 'Loan Receivable: LLN Gabler', account_type: 'asset' },
      { client_id: clientId, account_code: '1710', account_name: 'Loan Receivable: HA Gabler',  account_type: 'asset' },
      // Liabilities
      { client_id: clientId, account_code: '2001', account_name: 'Trade Creditors',        account_type: 'liability' },
      { client_id: clientId, account_code: '2002', account_name: 'VAT Payable',            account_type: 'liability' },
      { client_id: clientId, account_code: '2003', account_name: 'PAYE Payable',           account_type: 'liability' },
      { client_id: clientId, account_code: '2100', account_name: 'Loans Payable',          account_type: 'liability' },
      // Equity
      { client_id: clientId, account_code: '3001', account_name: 'Owner\'s Equity / Share Capital', account_type: 'equity' },
      { client_id: clientId, account_code: '3002', account_name: 'Retained Earnings',      account_type: 'equity' },
      { client_id: clientId, account_code: '3003', account_name: 'Drawings',               account_type: 'equity' },
    ];
    const sb = getClient();
    unwrap(await sb.from('chart_of_accounts').insert(defaults));
  },
};

// ============================================================
// BANK RULES
// ============================================================

const Rules = {
  async list(clientId) {
    const sb = getClient();
    return unwrap(
      await sb
        .from('bank_rules')
        .select('*')
        .eq('client_id', clientId)
        .order('match_count', { ascending: false })
    );
  },

  async create(data) {
    const sb = getClient();
    const rows = unwrap(await sb.from('bank_rules').insert([data]).select());
    return rows[0];
  },

  async incrementMatchCount(id) {
    const sb = getClient();
    const rows = unwrap(await sb.from('bank_rules').select('match_count').eq('id', id));
    if (!rows.length) return;
    const current = rows[0].match_count || 0;
    unwrap(await sb.from('bank_rules').update({ match_count: current + 1 }).eq('id', id));
  },

  // Increment a single rule's match_count by an arbitrary amount (used after
  // retroactive bulk-classification so the count reflects total real matches).
  async incrementBy(id, count) {
    if (!count || count < 1) return;
    const sb = getClient();
    const rows = unwrap(await sb.from('bank_rules').select('match_count').eq('id', id));
    if (!rows.length) return;
    const current = rows[0].match_count || 0;
    unwrap(await sb.from('bank_rules').update({ match_count: current + count }).eq('id', id));
  },

  async incrementBatch(ids) {
    await Promise.all(ids.map(id => Rules.incrementMatchCount(id)));
  },
};

// ============================================================
// OPENING BALANCES
// ============================================================

const OpeningBalances = {
  async list(clientId, financialYear) {
    const sb = getClient();
    return unwrap(
      await sb
        .from('opening_balances')
        .select('*')
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
        .order('account_code')
    );
  },

  // Replace all opening balances for a client/year (atomic: delete then insert)
  async replace(clientId, financialYear, rows) {
    const sb = getClient();
    unwrap(
      await sb
        .from('opening_balances')
        .delete()
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
    );
    if (rows.length > 0) {
      const payload = rows.map(r => ({
        client_id: clientId,
        financial_year: financialYear,
        account_code: r.account_code,
        account_name: r.account_name,
        amount: r.amount,
      }));
      unwrap(await sb.from('opening_balances').insert(payload));
    }
  },

  async hasData(clientId, financialYear) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('opening_balances')
        .select('id')
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
        .limit(1)
    );
    return rows.length > 0;
  },
};

// ============================================================
// TAX TJOM DATA
// ============================================================

const TaxTjomData = {
  async listByClient(clientId) {
    const sb = getClient();
    return unwrap(
      await sb
        .from('tax_tjom_data')
        .select('*')
        .eq('client_id', clientId)
        .order('tax_year', { ascending: false })
    );
  },

  async upsert(clientId, taxYear, data) {
    const sb = getClient();
    // Check if record exists
    const existing = unwrap(
      await sb
        .from('tax_tjom_data')
        .select('id')
        .eq('client_id', clientId)
        .eq('tax_year', taxYear)
        .limit(1)
    );
    if (existing.length > 0) {
      unwrap(
        await sb
          .from('tax_tjom_data')
          .update({ data, updated_at: new Date().toISOString() })
          .eq('client_id', clientId)
          .eq('tax_year', taxYear)
      );
    } else {
      unwrap(
        await sb
          .from('tax_tjom_data')
          .insert([{ client_id: clientId, tax_year: taxYear, data }])
      );
    }
  },

  async get(clientId, taxYear) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('tax_tjom_data')
        .select('*')
        .eq('client_id', clientId)
        .eq('tax_year', taxYear)
        .limit(1)
    );
    return rows[0] || null;
  },

  // Phase 2 bridge: push Rand Sense final figures into tax_tjom_data
  // Called after financial statements are finalised for a commission earner client
  async pushFromRandSense(clientId, financialYear, summaryData) {
    await TaxTjomData.upsert(clientId, financialYear, {
      source: 'rand_sense',
      pushed_at: new Date().toISOString(),
      ...summaryData,
    });
  },
};

// ============================================================
// MIGRATION: localStorage → Supabase (Tax Tjom legacy data)
// ============================================================

async function migrateLocalStorageToSupabase() {
  const LEGACY_KEY = 'taxtjom_clients';
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return { migrated: 0 };

  let legacyClients;
  try {
    legacyClients = JSON.parse(raw);
  } catch {
    return { migrated: 0, error: 'Could not parse localStorage data' };
  }

  if (!Array.isArray(legacyClients) || legacyClients.length === 0) {
    localStorage.removeItem(LEGACY_KEY);
    return { migrated: 0 };
  }

  let migrated = 0;
  const errors = [];

  for (const legacy of legacyClients) {
    try {
      // Create or reuse a client record
      const clientPayload = {
        name: legacy.name || 'Migrated Client',
        entity_type: legacy.entity_type || 'commission_earner',
        financial_year_end: legacy.financial_year_end || 'February',
        bank: legacy.bank || 'absa',
        vat_number: legacy.vat_number || null,
        vat_active: false,
      };
      const client = await Clients.create(clientPayload);

      // Store each tax year's data
      const taxYears = legacy.tax_years || {};
      for (const [taxYear, data] of Object.entries(taxYears)) {
        await TaxTjomData.upsert(client.id, taxYear, data);
      }

      migrated++;
    } catch (err) {
      errors.push(err.message);
    }
  }

  // Clear localStorage only if all records migrated successfully
  if (errors.length === 0) {
    localStorage.removeItem(LEGACY_KEY);
  }

  return { migrated, errors };
}

// ============================================================
// PRACTICE SETTINGS
// Single-row table — one practice using this app.
// ============================================================

const PracticeSettings = {
  async load() {
    const sb = getClient();
    const result = await sb.from('practice_settings').select('*').limit(1);
    if (result.error) {
      console.error('practice_settings load error:', result.error);
      throw new Error(result.error.message);
    }
    return (result.data || [])[0] || null;
  },

  async save(data) {
    const sb = getClient();

    // Step 1: check for existing row
    const selectResult = await sb.from('practice_settings').select('id').limit(1);
    if (selectResult.error) {
      console.error('practice_settings select error:', selectResult.error);
      throw new Error(selectResult.error.message);
    }
    const existing = selectResult.data || [];

    if (existing.length > 0) {
      // Step 2a: update
      const updateResult = await sb
        .from('practice_settings')
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq('id', existing[0].id)
        .select();
      if (updateResult.error) {
        console.error('practice_settings update error:', updateResult.error);
        throw new Error(updateResult.error.message);
      }
      return (updateResult.data || [])[0];
    } else {
      // Step 2b: insert first row
      const insertResult = await sb
        .from('practice_settings')
        .insert([data])
        .select();
      if (insertResult.error) {
        console.error('practice_settings insert error:', insertResult.error);
        throw new Error(insertResult.error.message);
      }
      return (insertResult.data || [])[0];
    }
  },
};

// ============================================================
// CLEAR ALL CLIENT DATA
// Deletes transactions, bank rules, and opening balances for a
// client, then resets vat_period to null so it can be re-set.
// The client profile itself (name, entity type, bank, VAT number,
// vat_active, year end) is left intact.
// ============================================================

async function clearAllData(clientId) {
  const sb = getClient();
  // Run all three deletes in parallel — each table is keyed by client_id
  await Promise.all([
    unwrap(await sb.from('transactions').delete().eq('client_id', clientId)),
    unwrap(await sb.from('bank_rules').delete().eq('client_id', clientId)),
    unwrap(await sb.from('opening_balances').delete().eq('client_id', clientId)),
  ]);
  // Reset VAT period so the selector is editable again
  unwrap(await sb.from('clients').update({ vat_period: null }).eq('id', clientId));
}

// ============================================================
// INVOICES
// ============================================================

const Invoices = {
  async list() {
    const sb = getClient();
    return unwrap(
      await sb.from('invoices').select('*').order('created_at', { ascending: false })
    );
  },

  async create(data) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('invoices').insert([data]).select());
    return rows[0];
  },

  async update(id, data) {
    const sb   = getClient();
    const rows = unwrap(
      await sb.from('invoices')
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq('id', id).select()
    );
    return rows[0];
  },

  async delete(id) {
    const sb = getClient();
    unwrap(await sb.from('invoices').delete().eq('id', id));
  },

  async getById(id) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('invoices').select('*').eq('id', id).limit(1));
    return rows[0] || null;
  },

  async nextNumber() {
    const sb = getClient();
    const r  = await sb.from('invoices').select('invoice_number').like('invoice_number', 'RS-%');
    if (r.error) throw new Error(r.error.message);
    let max = 0;
    (r.data || []).forEach(row => {
      const num = row.invoice_number || '';
      const m5  = /^RS-(\d{5})$/.exec(num);
      const mY  = /^RS-\d{4}-(\d+)$/.exec(num);
      if      (m5) max = Math.max(max, parseInt(m5[1], 10));
      else if (mY) max = Math.max(max, parseInt(mY[1], 10));
    });
    return `RS-${String(max + 1).padStart(5, '0')}`;
  },

  nextSequentialNumber() { return this.nextNumber(); },

  async listByClient(clientId) {
    const sb = getClient();
    return unwrap(
      await sb.from('invoices')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
    );
  },

  async listOutstanding() {
    const sb = getClient();
    return unwrap(
      await sb.from('invoices')
        .select('id,amount_outstanding')
        .gt('amount_outstanding', 0)
    );
  },

  async findByClientServiceYear(clientId, serviceType, taxYear) {
    const sb   = getClient();
    const rows = unwrap(
      await sb.from('invoices')
        .select('*')
        .eq('client_id', clientId)
        .eq('service_type', serviceType)
        .eq('tax_year', taxYear)
        .limit(1)
    );
    return rows[0] || null;
  },

  async deleteByClientServiceYear(clientId, serviceType, taxYear) {
    const sb = getClient();
    unwrap(
      await sb.from('invoices')
        .delete()
        .eq('client_id', clientId)
        .eq('service_type', serviceType)
        .eq('tax_year', taxYear)
        .eq('status', 'finalized')
    );
  },
};

// ============================================================
// PAYMENTS
// ============================================================

const Payments = {
  async create(data) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('payments').insert([data]).select());
    return rows[0];
  },

  async listByInvoice(invoiceId) {
    const sb = getClient();
    return unwrap(
      await sb.from('payments').select('*')
        .eq('invoice_id', invoiceId)
        .order('payment_date')
    );
  },

  async listAll() {
    const sb = getClient();
    return unwrap(
      await sb.from('payments').select('*').order('payment_date', { ascending: false })
    );
  },
};

// ============================================================
// INVOICE LINES
// ============================================================

const InvoiceLines = {
  async createBatch(invoiceId, lines) {
    const sb   = getClient();
    const rows = lines.map(l => ({ ...l, invoice_id: invoiceId }));
    return unwrap(await sb.from('invoice_lines').insert(rows).select());
  },

  async list(invoiceId) {
    const sb = getClient();
    return unwrap(
      await sb.from('invoice_lines').select('*')
        .eq('invoice_id', invoiceId).order('created_at')
    );
  },
};

// ============================================================
// INDIVIDUAL CONTACTS
// Standalone table for personal/individual clients (tax returns,
// personal invoicing) — separate from company/commission clients.
// ============================================================

const IndividualContacts = {
  async list() {
    const sb = getClient();
    return unwrap(
      await sb.from('individual_contacts').select('*').order('name')
    );
  },

  async get(id) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('individual_contacts').select('*').eq('id', id).limit(1));
    return rows[0] || null;
  },

  async create(data) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('individual_contacts').insert([data]).select());
    return rows[0];
  },

  async update(id, data) {
    const sb   = getClient();
    const rows = unwrap(await sb.from('individual_contacts').update(data).eq('id', id).select());
    return rows[0];
  },

  async delete(id) {
    const sb = getClient();
    unwrap(await sb.from('individual_contacts').delete().eq('id', id));
  },
};

// ============================================================
// JOURNALS — stored in the transactions table with source_bank='Journal'
//
// Sign convention (debit-positive):
//   amount > 0  =  DEBIT  to account_code
//   amount < 0  =  CREDIT to account_code
//
// period field holds the journal identifier: 'JNL-N' (N = sequential number)
// description = 'JNL-N: {narration}' on every line of the same journal
// Journal numbers are global per client (not per year, not resettable).
// Posted journals are PERMANENT — no delete or edit is supported here.
// ============================================================

const _r2 = n => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

const Journals = {
  // Next unused journal number for this client (1-based, global across all years)
  async nextNumber(clientId) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('transactions')
        .select('period')
        .eq('client_id', clientId)
        .eq('source_bank', 'Journal')
    );
    if (!rows.length) return 1;
    const nums = rows.map(r => parseInt((r.period || '').replace('JNL-', '')) || 0);
    return Math.max(...nums) + 1;
  },

  // Post a new journal entry.
  // lines = [{ account_code, account_name, debit, credit }, ...]
  // Exactly one of debit/credit must be non-zero per line.
  // Total debits must equal total credits (caller should validate first).
  //
  // isCommissionEarner: sign convention differs by report engine. Company
  // clients read the ledger via buildTrialBalance, which nets debit-minus-credit
  // per account — so amount = +debit / -credit (standard double-entry) is
  // correct there. Commission earner clients read a completely different
  // pipeline (buildCommissionIS -> netByAccount), which treats amount at face
  // value as a cash-flow sign identical to imported bank statement rows
  // (negative = money out = expense increase, positive = money in = expense
  // decrease) and just negates the summed net for display. Storing a journal's
  // debit-to-expense side as positive under that convention makes the expense
  // display as a negative/credit — confirmed directly on three separate posted
  // journals (JNL-1/2/3) all showing their reallocated expense category with
  // the wrong sign. So for commission earners the sign is inverted relative to
  // the company convention: amount = -debit / +credit.
  async post(clientId, financialYear, date, narration, lines, isCommissionEarner) {
    const num    = await Journals.nextNumber(clientId);
    const period = `JNL-${num}`;
    const desc   = `${period}: ${narration}`;

    const rows = lines.map(l => ({
      client_id:      clientId,
      financial_year: financialYear,
      date,
      description:    desc,
      period,
      source_bank:    'Journal',
      account_code:   l.account_code,
      account_name:   l.account_name,
      amount:         isCommissionEarner
        ? (l.debit > 0 ? _r2(-l.debit) : _r2(l.credit))
        : (l.debit > 0 ? _r2(l.debit)  : _r2(-l.credit)),
      vat_type:       'none',
      vat_amount:     0,
      is_reconciled:  false,
      balance:        null,
    }));

    const sb = getClient();
    unwrap(await sb.from('transactions').insert(rows).select());
    return { number: num, period };
  },

  // All journal rows for a client, all years (grouped in JS by caller)
  async listByClient(clientId) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('source_bank', 'Journal')
    );
    return _sortJournals(rows);
  },

  // Journal rows for a specific financial year
  async listByYear(clientId, financialYear) {
    const sb = getClient();
    const rows = unwrap(
      await sb
        .from('transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('financial_year', financialYear)
        .eq('source_bank', 'Journal')
    );
    return _sortJournals(rows);
  },
};

function _sortJournals(rows) {
  return rows.slice().sort((a, b) => {
    const na = parseInt((a.period || '').replace('JNL-', '')) || 0;
    const nb = parseInt((b.period || '').replace('JNL-', '')) || 0;
    return na - nb || (a.date || '').localeCompare(b.date || '');
  });
}

// ============================================================
// EXPORTS — attach to window for access from other scripts
// ============================================================

window.DB = {
  Clients,
  Transactions,
  COA,
  Rules,
  OpeningBalances,
  TaxTjomData,
  PracticeSettings,
  Invoices,
  InvoiceLines,
  Payments,
  IndividualContacts,
  Journals,
  migrateLocalStorageToSupabase,
  clearAllData,
};

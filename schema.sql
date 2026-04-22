-- ============================================================
-- Rand Sense + Tax Tjom — Supabase Database Schema
-- Run this in the Supabase SQL Editor (Project: tdmvypmwibnqfhvqhzxs)
-- ============================================================

-- Enable UUID extension if not already enabled
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLE: clients
-- Shared between Rand Sense and Tax Tjom
-- ============================================================
create table if not exists clients (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  entity_type       text not null check (entity_type in ('company_cc', 'company_pty', 'commission_earner')),
  financial_year_end text not null,
  bank              text not null check (bank in ('absa', 'standard_bank', 'capitec', 'nedbank')),
  vat_number             text,
  vat_active             boolean default false,
  vat_period             text check (vat_period in ('monthly', '2monthly', 'yearly')),
  vat_registration_date  text,
  created_at             timestamp default now()
);

-- ============================================================
-- TABLE: transactions
-- All bank statement entries, accumulated (never deleted)
-- ============================================================
create table if not exists transactions (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references clients(id) on delete cascade,
  date           date not null,
  description    text not null,
  amount         numeric not null,
  balance        numeric,
  source_bank    text not null,
  account_code   text,
  account_name   text,
  vat_type       text check (vat_type in ('input', 'output', 'none')),
  vat_amount     numeric default 0,
  financial_year text not null,
  period         text not null,
  is_reconciled  boolean default false,
  created_at     timestamp default now()
);

-- ============================================================
-- TABLE: chart_of_accounts
-- Per-client account codes and names
-- ============================================================
create table if not exists chart_of_accounts (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references clients(id) on delete cascade,
  account_code text not null,
  account_name text not null,
  account_type text not null check (account_type in (
    'income', 'cost_of_sales', 'expense', 'asset', 'liability', 'equity'
  )),
  is_active    boolean default true,
  created_at   timestamp default now()
);

-- ============================================================
-- TABLE: bank_rules
-- Keyword-to-account mappings, permanent and cumulative
-- ============================================================
create table if not exists bank_rules (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references clients(id) on delete cascade,
  keyword      text not null,
  account_code text not null,
  account_name text not null,
  vat_type     text check (vat_type in ('input', 'output', 'none')),
  match_count  integer default 0,
  created_at   timestamp default now()
);

-- ============================================================
-- TABLE: opening_balances
-- Prior year AFS closing balances, used as comparatives
-- ============================================================
create table if not exists opening_balances (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references clients(id) on delete cascade,
  financial_year text not null,
  account_code   text not null,
  account_name   text not null,
  amount         numeric not null,
  created_at     timestamp default now()
);

-- ============================================================
-- TABLE: tax_tjom_data
-- Tax Tjom client profiles linked to shared clients table
-- ============================================================
create table if not exists tax_tjom_data (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references clients(id) on delete cascade,
  tax_year   text not null,
  data       jsonb not null,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- ============================================================
-- PERFORMANCE INDEXES
-- ============================================================
create index if not exists idx_tx_client_year    on transactions(client_id, financial_year);
create index if not exists idx_tx_client_period  on transactions(client_id, period);
create index if not exists idx_tx_unclassified   on transactions(client_id) where account_code is null;
create index if not exists idx_coa_client        on chart_of_accounts(client_id);
create index if not exists idx_rules_client      on bank_rules(client_id);
create index if not exists idx_ob_client_year    on opening_balances(client_id, financial_year);
create index if not exists idx_taxtjom_client    on tax_tjom_data(client_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- Single-user personal tool — disable RLS for direct access.
-- If you later add authentication, re-enable and create policies.
-- ============================================================
alter table clients          disable row level security;
alter table transactions     disable row level security;
alter table chart_of_accounts disable row level security;
alter table bank_rules       disable row level security;
alter table opening_balances disable row level security;
alter table tax_tjom_data    disable row level security;

-- ============================================================
-- HELPER FUNCTION: update tax_tjom_data.updated_at on write
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_taxtjom_updated_at on tax_tjom_data;
create trigger trg_taxtjom_updated_at
  before update on tax_tjom_data
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: invoices
-- Rand Sense practice invoices (manual + finalized ITR12 returns)
-- ============================================================

create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  client_id      uuid references clients(id) on delete set null,
  invoice_date   date,
  due_date       date,
  status         text not null default 'draft'
                   check (status in ('draft','sent','paid','finalized')),
  subtotal       numeric default 0,
  vat_amount     numeric default 0,
  total          numeric default 0,
  notes          text,
  -- ITR12 / service-specific fields
  service_type      text,   -- e.g. 'ITR12', 'Annual Financial Statements', 'VAT201'
  tax_year          text,   -- e.g. '2024'
  brochure_price    numeric,
  final_amount      numeric,
  discount          numeric default 0,
  finalized_date    timestamptz,
  -- Payment tracking
  amount_paid       numeric default 0,
  amount_outstanding numeric default 0,
  paid_date         timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- TABLE: invoice_lines
create table if not exists invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid references invoices(id) on delete cascade,
  description text not null,
  qty         numeric default 1,
  unit_price  numeric not null,
  line_total  numeric not null,
  created_at  timestamptz default now()
);

create index if not exists idx_invoices_client    on invoices(client_id);
create index if not exists idx_invoices_status    on invoices(status);
create index if not exists idx_invoicelines_inv   on invoice_lines(invoice_id);

alter table invoices       disable row level security;
alter table invoice_lines  disable row level security;

-- ============================================================
-- TABLE: payments
-- Individual payment transactions against an invoice
-- ============================================================

create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid references invoices(id) on delete cascade,
  client_id    uuid references clients(id) on delete set null,
  amount_paid  numeric not null,
  payment_date timestamptz default now(),
  created_at   timestamptz default now()
);

create index if not exists idx_payments_invoice on payments(invoice_id);
create index if not exists idx_payments_client  on payments(client_id);

alter table payments disable row level security;

-- ============================================================
-- MIGRATION: add payment tracking columns to existing invoices table
-- Run once if the invoices table already exists without these columns.
-- ============================================================
-- alter table invoices add column if not exists amount_paid        numeric default 0;
-- alter table invoices add column if not exists amount_outstanding numeric default 0;
-- alter table invoices add column if not exists paid_date          timestamptz;

-- ============================================================
-- MIGRATION: add ITR12 columns to existing invoices table
-- Run this once if invoices table already exists without these columns.
-- ============================================================
-- alter table invoices add column if not exists service_type   text;
-- alter table invoices add column if not exists tax_year       text;
-- alter table invoices add column if not exists brochure_price numeric;
-- alter table invoices add column if not exists final_amount   numeric;
-- alter table invoices add column if not exists discount       numeric default 0;
-- alter table invoices add column if not exists finalized_date timestamptz;

-- Done. All tables ready.

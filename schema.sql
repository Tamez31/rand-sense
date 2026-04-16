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
  vat_number        text,
  vat_active        boolean default false,
  vat_period        text check (vat_period in ('monthly', 'two_month_odd', 'two_month_even', 'two_month_odd_or_even', 'yearly')),
  created_at        timestamp default now()
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

-- Done. All tables ready.

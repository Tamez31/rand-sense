# Rand Sense — Cashbook & Financial Statements

**For:** Single-user South African accounting practice  
**Stack:** Pure HTML/CSS/JS + Supabase (no build tools, no frameworks)  
**Currency:** ZAR (R) throughout  
**Date format:** DD/MM/YYYY

---

## Quick Start

### 1. Set up the database (once only)

1. Go to your Supabase project: https://tdmvypmwibnqfhvqhzxs.supabase.co
2. Open the **SQL Editor**
3. Paste the contents of `schema.sql` and click **Run**
4. All tables are created with RLS disabled (personal tool — no auth needed)

### 2. Open Rand Sense

Open `rand-sense/Rand-Sense.html` in any modern browser (Chrome, Edge, Firefox).  
You will be prompted to set a 4-digit PIN on first launch.

### 3. Open Tax Tjom

Open `my-accounting-app/index.html` in any modern browser.  
No PIN required — Tax Tjom loads directly.

---

## Daily Use — Rand Sense

### Adding a client
1. Click **+ Add Company** (or + Add Commission Earner)
2. Fill in name, entity type, financial year end, bank
3. For VAT-registered companies: enter the VAT number — this activates the VAT module
4. Click **Save Client** — a default chart of accounts is created automatically

### Importing a bank statement
1. Open a client → click **Import Statement**
2. Select the financial year (e.g. `2025`) and period (e.g. `March 2024`)
3. Select the bank — the parser adapts automatically
4. Drag and drop the CSV file exported from your banking app
5. For VAT clients: choose whether this import is Output VAT or Input VAT
6. Click **Import Transactions**

#### CSV column structure (all banks)

All bank statement CSV files must use this exact column structure:

| Column | Required | Notes |
|--------|----------|-------|
| Date | Yes | DD/MM/YYYY, YYYY/MM/DD, or DD Mon YYYY |
| Description | Yes | Transaction description |
| Category | No | Ignored — may be left blank |
| Money In | Yes* | Positive number. Leave blank if money out |
| Money Out | Yes* | Positive number. Leave blank if money in |
| Fee | No | Ignored — fees appear as their own rows |
| Balance | No | Running balance after transaction |

*At least one of Money In or Money Out must be present per row.

### Classifying transactions (companies)
- After import, any transactions not matched by existing rules appear in the **classification queue** (red badge on Transactions tab)
- Click **Classify Now** to work through the queue
- Select the account, optionally set the VAT type, then tick **Save as a bank rule**
- The keyword is suggested automatically — edit it to make it more or less specific
- On the next import, matched transactions are auto-classified

### Generating financial statements
1. Open client → click **Reports** tab
2. Use the **Full Pack** button to build all statements at once, or click individual tabs
3. Toggle **Hide zero lines** to clean up the output
4. Click **PDF** to print/save as PDF, or **CSV** to download

### Importing opening balances
- Opening balances populate the comparative column on the Balance Sheet and Income Statement
- Use `opening-balances-template.csv` as your template
- Go to client → Reports tab → click **Opening Balances** button
- Select the financial year these balances open (e.g. `2025` means they are the 28 Feb 2025 closing balances)
- **Important:** debits must equal credits — the import will reject unbalanced files

---

## Daily Use — Tax Tjom

### Client profiles (new)
- A **Client Profiles** bar appears at the top of Tax Tjom
- After running a calculation, click **Save** to save it against a client
- On future visits, select a client + tax year and click **Load** to restore all fields
- Clients created in Rand Sense appear here automatically (shared database)

### Calculation (unchanged)
- Everything works exactly as before — fill in IRP5 codes and click Calculate
- The result, bracket breakdown, and IRP5 summary tabs are unaffected

---

## Financial statement logic

| Statement | What it shows |
|-----------|--------------|
| Income Statement | Revenue → Gross Profit → Expenses → Net Profit/Loss |
| Balance Sheet | Assets = Liabilities + Equity (with opening balance comparative) |
| Cash Flow | Operating / Investing / Financing activities + net bank movement |
| Trial Balance | All account codes with debit/credit columns — must balance |
| VAT Report | Output VAT collected, Input VAT claimable, Net VAT payable/refundable |

**Commission Earner Income Statement** uses the SARS ITR12 category structure and is designed to feed directly into the ITR12 return.

---

## Export formats

| Export | Format | Use for |
|--------|--------|---------|
| Individual statement PDF | Browser print | Client presentation |
| Individual statement CSV | Comma-separated | Spreadsheet analysis |
| Full Pack CSV | Combined CSV with section separators | Archive / backup |
| Transaction Ledger CSV | All cashbook entries | Audit trail |
| Tax Tjom Handoff CSV | Tax Tjom import format | Commission earner ITR12 filing |

---

## Rules engine (companies only)

- Rules map **keywords** to **account codes**
- Keywords are matched as substrings (case-insensitive) against transaction descriptions
- The longest matching keyword wins (more specific beats more general)
- Rules are **permanent** — they accumulate and are never auto-deleted
- Match count is tracked — rules that fire more often are preferred in tie-breaks
- To review rules: Client → Settings → (future: Rules tab)

---

## VAT notes

- SA VAT rate: **15%** (inclusive) — effective 1 April 2018
- All VAT is extracted from inclusive amounts: VAT = Amount × (15/115)
- Output VAT = collected on sales (money in)
- Input VAT = paid on purchases (money out, claimable)
- Net VAT = Output − Input (positive = pay SARS, negative = refund due)
- VAT numbers must be 10 digits starting with 4

---

## File structure

```
rand-sense/
  Rand-Sense.html         ← Rand Sense app (open this)
  styles.css              ← Design system
  supabase-client.js      ← All database operations
  csv-parsers.js          ← ABSA, Standard Bank, Capitec, Nedbank parsers
  rules-engine.js         ← Auto-classification, ITR12 categories
  vat-module.js           ← VAT calculations and reporting
  financial-outputs.js    ← IS, BS, CF, TB, VAT statement builders
  export.js               ← PDF print and CSV download
  schema.sql              ← Run once in Supabase SQL Editor
  opening-balances-template.csv
  README.md               ← This file

my-accounting-app/
  index.html              ← Tax Tjom app (open this)
  CLAUDE.md               ← Tax Tjom project notes
```

---

## Supabase credentials

| Key | Value |
|-----|-------|
| Project URL | https://tdmvypmwibnqfhvqhzxs.supabase.co |
| Publishable key | stored in `supabase-client.js` (safe to commit — anon/publishable only) |
| Secret key | **Never stored in code.** Keep in Supabase dashboard only. |

**The secret key must never be committed to any repository.**

---

## Troubleshooting

**"Could not load clients"** — Check your internet connection. Supabase requires network access.

**Balance sheet does not balance** — There are likely unclassified transactions. Go to Transactions tab and classify all items.

**CSV import fails** — Make sure you are selecting the correct bank. Each bank has a different column structure.

**Opening balances import rejected** — Check that debits equal credits in your CSV file. The total debit column must match the total credit column.

**PIN forgotten** — Open browser DevTools → Application → Local Storage → delete the `rs_pin` key. You will be prompted to set a new PIN.

---

*Rand Sense — Built for a South African accounting practice. Efficiency is the core product.*

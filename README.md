# Tech Defenders OS v4.2.0 · Mobile Connected

Tech Defenders OS is a connected CRM + ERP for a single-company or
multi-organization Super Admin deployment. The interface uses the supplied Tech
Defenders logo and a productivity-first black, gold and white design.

The included Android source connects to this API with short-lived mobile bearer
sessions, so daily CRM/ERP work can run from a phone without keeping a laptop or
PC switched on. The server must remain deployed on an HTTPS cloud host. See
`docs/MOBILE.md` for the mobile contract and production checklist.

This package starts clean: it retains the Tech Defenders organization, nine
login accounts, numbering series and the chart of accounts only. It contains no
demo customers, leads, products, stock, quotations, invoices, suppliers,
purchase records, jobs, tickets, employees, notifications or audit events.

## Windows setup

Requirements: Windows 10/11 and Node.js 22.3 or newer.

```powershell
# Extract Tech-Defenderss-OS.zip, then:
cd "G:\Tech Defenders\Tech-Defenderss-OS"
.\SETUP.bat
.\START.bat
```

Open <http://localhost:4173>.

During `SETUP.bat`, paste the Brevo API key you saved when the hidden prompt
appears. The verified sender is already set to
`Tech Defenders <techdefenderss@gmail.com>`. The key is written only to the
local `.env`; it is never printed, stored in the app database or included in
this ZIP. If setup was previously completed, replace the key with:

```powershell
.\CONFIGURE-BREVO.bat
```

Manual equivalent:

```powershell
npm install
node .\scripts\create-env.js
npm run smoke
npm run test:v3
npm run test:integrations
npm start
```

## Login accounts

| Email | Password | Role |
|---|---|---|
| superadmin@techdefenders.in | Super@123 | Super Admin |
| admin@techdefenders.in | Admin@123 | Administrator |
| sales@techdefenders.in | Demo@123 | Sales Manager |
| accounts@techdefenders.in | Demo@123 | Accountant |
| purchase@techdefenders.in | Demo@123 | Purchase Manager |
| store@techdefenders.in | Demo@123 | Store Manager |
| production@techdefenders.in | Demo@123 | Production Manager |
| service@techdefenders.in | Demo@123 | Service Manager |
| engineer@techdefenders.in | Demo@123 | Engineer |

Change these passwords before production use.

## Main workflows

### Client Data Package Studio

- Open **Data Import → Data Package Studio**, then select or drop up to 250 files.
- Smart routing inspects supported business data and uses file-name/type signals
  for Word files, images, videos, archives and other documents.
- Review or change every suggested destination, add the client name/reference,
  then download one normal ZIP.
- The ZIP contains the original files, a routing manifest and SHA-256 checksums.
  Upload it under **Smart Data Import**; checksum verification runs before review.
- On confirmation, CSV/Excel/JSON/XML/PDF records reach CRM, Sales, Inventory,
  Purchase, Accounts, HR or Service. Other files appear under **Client Documents**.
- Potentially executable content is stored as restricted, download-only data and
  is never executed or rendered by Tech Defenders OS.
- Defaults are 25 MB per file and 100 MB per package. All limits can be changed
  with environment variables without editing the source.

### Smart business data import

- Upload a Data Package ZIP, CSV, XLSX, XLS, JSON, XML or PDF under **Data Import → Smart Data Import**.
- The server securely inspects archives, detects business modules, maps column
  synonyms/fuzzy matches, validates rows and shows category totals.
- Duplicates default to Skip; choose Merge or Keep Both explicitly.
- Confirm only after preview. Completed imports include an audited rollback and
  downloadable CSV error report.

### Email Center, WhatsApp and communication history

- **Communication → Email Center** provides individual/bulk email, reusable
  variables, scheduling, invoice PDF attachment, retry/backoff and campaign status.
- Invoice WhatsApp deep links contain an expiring signed PDF URL and still require
  the user to press Send. Official automated templates use Meta Cloud API.
- Customer 360 includes an organization-scoped communication timeline.

### Automation Builder and analytics

- **Automations → Automation Builder** provides WHEN / IF / THEN rules, delay,
  enable/disable, test execution, job history, idempotency and retries.
- Supported actions include email, official WhatsApp, tasks/reminders,
  notifications, safe status changes and report generation.
- **Communication → Delivery Analytics** shows email, WhatsApp, invoice and
  automation execution figures from real records.

### Secure email OTP and free messaging options

- New workspace signup requires a 6-digit email OTP before any organization or
  owner record is created.
- **Sign in with Email OTP** provides passwordless login for every active user;
  normal password login remains available for the nine packaged accounts.
- OTPs are hashed at rest, expire in 10 minutes, are single-use, rate-limited
  and stop after five incorrect attempts. Production responses never reveal the
  code.
- OTP email uses the existing Brevo transactional adapter. Brevo offers a free
  tier, but its current account and daily sending limits still apply.
- The packaged sender is `techdefenderss@gmail.com`, verified in Brevo. The
  Windows setup wizard accepts the saved API key through hidden input and keeps
  it only in `.env`.
- **Administration → Live Integrations** includes free manual SMS and WhatsApp
  composer actions. They open the user's device/app with a prefilled message;
  the user reviews and presses Send, so they are not fake automated deliveries.
- Automated India SMS still uses MSG91/DLT and automated WhatsApp still uses
  Meta WhatsApp Business templates; provider onboarding and charges may apply.

### Dashboard and module app launcher

Tap **CRM**, **Sales**, **Purchase**, **Inventory**, or any other module in the
sidebar to expand only that module's apps. Dashboard home also contains a
responsive **Business apps** launcher with the same permission-aware groups.
Per-user access switches control both launchers, direct routes, search and APIs.

### Super Admin and access control

Use **Administration → Platform Control** as Super Admin. The global account
index shows users from every organization, including newly registered accounts.
Super Admin can create, edit, activate/deactivate, reset passwords, delete,
switch into an organization, open its complete data, and preview/control each
user dashboard.

Per-user iPhone-style switches control Dashboard, CRM, Sales, Purchase,
Inventory, Manufacturing, Service, Accounts, HR, Reports and Administration.
The policy is enforced in the sidebar, dashboard, search, direct routes and
backend APIs.

### CRM and lead intelligence

- Leads, customers, deals, follow-ups, activities and Kanban pipeline
- Lead conversion to customer/deal
- **CRM → Lead Intelligence** for explainable scores
- JSON lead import with duplicate email/phone protection
- Duplicate scan/controlled merge and CSV export

### Sales and billing

- Manual quotation lines—no compulsory product dropdown
- Quotation → Sales Order → GST Invoice chain
- Direct manual GST invoice creation under **Sales → GST Invoices**
- Receipts, allocations, credit notes and printable invoices
- **Sales → Sales Documents** for proformas, delivery challans and debit notes
- Proforma → Invoice conversion guard

### Local AI quotation drafts

Use **Sales → AI Quote Draft**. `SETUP.bat` automatically detects the installed
Ollama app, starts its loopback service when needed, selects an installed model
(preferring `qwen3:4b`), and writes the safe local settings into `.env`. If no
model exists, setup attempts to pull `qwen3:4b`; a failed/paused download does
not break the rest of setup. This feature supports a local Ollama instance;
it does not require a paid cloud API. The output is always marked
`review_required`, is never sent automatically, and must be assigned to a real
customer and reviewed before it can become a quotation.

To re-run only Ollama configuration:

```powershell
node .\scripts\configure-ollama.js
```

The resulting `.env` settings are:

```ini
OLLAMA_ENABLED=true
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

If Ollama is missing or offline, the page shows a real unavailable state instead
of fake output.

### Purchase and vendor finance

- Requisition approval, RFQ comparison/award, Purchase Orders and GRN/QC
- **Purchase → Vendor Billing** for purchase invoices, returns and payments
- Duplicate supplier-invoice protection
- Vendor payable journals, input GST, return reversal and vendor ledger

### Inventory and manufacturing

- Product/warehouse masters, stock summary and ledger
- Opening stock, adjustments, transfers and warehouse validation
- **Inventory → Reservations** for categories, reservations and availability
- BOM costing, job release, atomic material issue, output/rejection and closure

### Accounts and statements

- Chart of accounts, balanced journals, expenses and approval
- Trial balance and Profit & Loss
- **Accounts → Ledgers & Statements** for general ledger, customer/vendor
  statements, balance sheet and cash flow
- Bank transaction register and reconciliation API

### Service, HR and reports

- AMC contracts, renewal, service tickets, assignment, status, worklogs and parts
- Employees and leave requests
- Sales, aging, stock, lead funnel, customer and service reports
- Saved-report definitions API

### Approvals, automation and live integrations

- **Administration → Approval Center**: configurable entity, threshold and role
- **Administration → Automation**: low-stock, overdue-invoice and follow-up rules
  with idempotent job history
- **Administration → Live Integrations**: real adapters for Brevo email/OTP, MSG91
  Flow SMS, Meta WhatsApp Cloud API and Sandbox GST e-Invoice/E-Way Bill
- Live test/send forms, masked delivery history, provider identifiers and
  verified webhook status updates
- **Sales → GST Invoices**: Generate IRN, E-Way Bill, email and WhatsApp actions
- GST validation for company/customer GSTIN, addresses, pincode and HSN/SAC
- **Administration → Branches**: branch/GST registration master

Integration secrets are accepted only from server environment variables; the
web application refuses to store API keys in JSON.

## Useful commands

```powershell
npm start          # start the server
npm run smoke      # 61 backward-compatibility checks in disposable data
npm run test:v3    # 34 v3 feature/security checks in disposable data
npm run test:integrations # 22 provider/OTP checks against a local HTTP mock
npm run test:operations   # 25 import/communication/automation checks
npm test                  # all 142 isolated checks
npm run backup     # create a backup now
npm run seed       # DESTRUCTIVE: reset to accounts/config only
```

Real data is never used by any test suite. `npm run seed` is intentionally
destructive and should only be run after a verified backup.

## Data and backups

Business data is stored under `data\`. Atomic replacement prevents partial JSON
writes. A snapshot is created at startup and every 24 hours when
`AUTO_BACKUP=true`; use `BACKUP_DIR` to keep snapshots on another drive.

This storage model supports one Node.js process. Migrate to PostgreSQL before
multi-instance, high-concurrency or internet-scale hosting. See `docs/` for the
audit, architecture, database boundary, security, integrations, testing and
deployment notes.

## Render deployment (Free tier)

`render.yaml` provisions a single Node web service on Render's **Free** plan
(no cost, no persistent disk). Render's Free web services have an ephemeral
filesystem, so this app's JSON data store (`data/`, `backups/`) is **wiped on
every redeploy, manual restart, and idle spin-down** — use the Free plan only
for demos/testing, never for real business data. To retain data across
restarts, upgrade to a paid plan and restore the persistent-disk
configuration; keep one application instance while this JSON store is in use.
Full deployment, upgrade, and provider-variable instructions are in
`docs/RENDER-INTEGRATIONS.md`.

## External account boundary

The adapters make real provider calls and record only confirmed results. Live
use still requires provider accounts, credentials, sender/domain verification,
India DLT templates, Meta Business verification/approved WhatsApp templates,
and GST portal/GSP onboarding. Credentials belong in Render environment
variables, never in this ZIP or the Settings database.

For Render, `BREVO_SENDER_EMAIL=techdefenderss@gmail.com` and the sender name
are already declared in `render.yaml`. Paste the saved API key only into
Render's secret `BREVO_API_KEY` environment field. A local `.env` is excluded
from the ZIP and is not uploaded by the Blueprint.

## Verification

- Backward compatibility: 61/61 checks pass
- v3 regression: 34/34 checks pass
- Provider/OTP contract regression: 22/22 checks pass
- Mobile/Data Package operations regression: 32/32 checks pass
- Total automated checks: 149/149 pass
- JavaScript syntax: all project source files pass
- Dependency audit: run `npm audit --omit=dev` on the deployment machine
- Clean reset: 1 organization, 9 users, 23 sequences, 20 accounts, 0 business records

# Database and Migration Boundary

The store exposes one synchronous document API with two backends. Local
development and isolated tests use atomic JSON files. When `DATABASE_URL` is
configured, production hydrates all collections from PostgreSQL before serving
requests and serializes every changed collection back to `td_collections` JSONB.
This lets existing APIs run unchanged while accounts and records survive deploys.

The compatibility adapter does not yet provide row-level database constraints,
locking or multi-instance conflict resolution. Before high concurrency or
horizontal scaling, normalize these collection groups into relational tables:

- identity: organizations, branches, users, permissions
- CRM: leads, customers, deals, tasks, activities
- commerce: quotations, orders, invoices, notes, receipts and vendor documents
- inventory/manufacturing: products, warehouses, ledger, reservations, BOM/jobs
- finance: accounts, journals, expenses and bank transactions
- control: approvals, automations, provider configs, jobs, notifications, audit

Use UUID primary keys, `org_id` foreign keys, unique composite indexes for
organization/document number, supplier invoice uniqueness, and database
transactions for every stock/accounting workflow. Preserve existing API shapes
during migration so the SPA does not require a simultaneous rewrite.

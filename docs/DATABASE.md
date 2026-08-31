# Database and Migration Boundary

The bundled store is a zero-dependency document store with one JSON file per
collection and temporary-file rename on save. It is intentionally easy to run
on Windows and suitable for a controlled single-instance deployment.

It does not provide cross-file ACID transactions, database constraints, row
locking, replicas or multi-instance coordination. Before high concurrency or
horizontal scaling, migrate these collection groups to PostgreSQL:

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


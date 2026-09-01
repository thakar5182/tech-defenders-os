# Tech Defenders OS v4 Operations Architecture

## Audit result

The project remains an Express single-process application with a vanilla
JavaScript SPA and an atomic JSON collection store. Existing authentication,
tenant isolation, RBAC, CRM, customers, products, inventory, invoices,
quotations, receipts, expenses, employees, service, AMC, audit, notifications
and official provider adapters are reused. No duplicate Customer, Invoice,
Product or User model was created.

## Added boundaries

- `src/routes/operations.js` exposes the new organization-scoped API boundary.
- `src/services/imports.js` performs secure archive inspection, format parsing,
  mapping, validation, duplicate review, confirmation and rollback.
- `src/services/communications.js` owns templates, campaigns, a retry queue,
  signed invoice/unsubscribe links, PDF invoice attachments and history.
- `src/services/automation-engine.js` owns trigger evaluation, conditions,
  delayed idempotent executions, actions and retry history.
- `public/js/pages-operations.js` adds the productivity-first UI without
  replacing existing screens.

## Data migration plan

The JSON store automatically initializes the new empty collections on first
start. Existing collection files and records are not rewritten. A normal data
backup is created before startup when `AUTO_BACKUP=true`.

New collections:

- import: `importJobs`, `importFiles`, `importRecords`, `importMappings`,
  `importErrors`
- communication: `emailTemplates`, `emailCampaigns`, `emailQueue`,
  `communicationLogs`, `whatsappIntegrations`
- automation: `automationExecutions`

Existing `automationRules`, `messageDeliveries`, `customers`, `products`,
`invoices`, `quotations`, `receipts`, `expenses`, `employees`, `tickets`,
`amcContracts`, `notifications` and `auditEvents` are reused.

## Import safety and lifecycle

Uploads are held in memory only for analysis and are never served publicly.
Allowed extensions, upload size, archive entry count, per-entry size and total
expanded size are limited. Path traversal, executable extensions, nested ZIPs
and oversize entries are rejected. Uploaded content is parsed; it is never
executed. Mapping uses exact, synonym and fuzzy matching. Uncertain mappings
remain visible for review. Duplicates default to Skip; Merge and Keep Both are
explicit decisions. Confirmation stores an insertion/update plan used by the
audited rollback operation.

PDF extraction is best-effort and always carries a review warning. Large or
complex production migrations should be split into batches within the
configured limits.

## Queue behavior

Email and automation work is persisted before execution. Workers use bounded
batches, idempotency keys, retry limits and exponential backoff. The current
worker runs inside the one documented Node process because the JSON store does
not support multiple writers. For horizontal scale, migrate the collections to
PostgreSQL, move uploads/attachments to private object storage, and move queued
work to Redis/BullMQ or another durable queue before adding worker replicas.

## Provider and WhatsApp behavior

Brevo and Meta secrets remain server environment variables. Marketing email
includes a signed unsubscribe link. Invoice links are HMAC-signed and expire.
WhatsApp deep-link mode opens a prefilled `wa.me` message and records only an
`initiated` event; the user must press Send. Automated sending uses the official
Meta WhatsApp Business template adapter and reports only provider-supported
states.

## Permission model

New module keys are `communication`, `automation` and `dataImport`. Admin and
Super Admin retain full access. Sales roles receive customer communication
access, accountants receive invoice communication and controlled import access,
and other roles remain restricted unless an administrator enables the module.
All enforcement is server-side; hidden navigation is not authorization.

## Production boundary

This release is production-capable for a controlled single-instance deployment
with persistent storage, HTTPS, strong secrets, configured provider accounts,
backups and monitoring. It does not claim horizontal scalability, external
virus scanning, distributed transactions or guaranteed delivery without those
external services. See `DEPLOYMENT.md`, `.env.example` and `render.yaml`.

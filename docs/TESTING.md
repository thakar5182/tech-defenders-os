# Testing

`npm run smoke` runs 61 compatibility checks. `npm run test:v3` runs 34 checks
for new branches, intelligence, sales documents, vendor finance, reservations,
statements, approvals, AI failure state, integrations, automation, audit chaining
and CSRF-origin defense.

Both suites create an operating-system temporary data directory before importing
the application and remove it afterward. They never touch the packaged `data`.

`npm run test:integrations` runs 22 provider and OTP contract checks against a disposable
local HTTP server. It validates Brevo/MSG91/Meta payloads, message idempotency,
secret redaction, GST authentication, IRN/E-Way storage and Meta webhook
signatures without sending a paid message or government submission.

`npm run test:operations` runs 32 end-to-end checks for mobile bearer login, Data Package Studio,
arbitrary-document routing, checksum manifests, Smart Data Import, mapping,
duplicate review, confirmation, rollback, email templates/queue/provider
acceptance, recipient masking, WhatsApp deep links, automation execution and
communication analytics. `npm test` runs all 149 checks.

Before release also run:

```powershell
node --check server.js
Get-ChildItem -Recurse -Filter *.js | Where-Object FullName -NotMatch node_modules | ForEach-Object { node --check $_.FullName }
npm audit --omit=dev
```

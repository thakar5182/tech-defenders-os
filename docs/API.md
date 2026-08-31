# API Guide

All endpoints are same-origin under `/api`. Authentication uses the HTTP-only
`td_token` cookie. Errors use `{ "error": "message", "code": "optional" }`.

Core groups: `/auth`, `/dashboard`, `/crm`, `/sales`, `/purchase`, `/inventory`,
`/manufacturing`, `/service`, `/finance`, `/reports`, `/admin`.

v3 groups under `/v3`:

- `/crm/lead-insights`, `/crm/lead-deduplicate`, `/crm/leads-import|export`
- `/sales/proformas`, `/sales/delivery-challans`, `/sales/debit-notes`
- `/purchase/invoices`, `/purchase/returns`, `/purchase/payments`, vendor ledger
- `/inventory/categories`, `/inventory/reservations`, product availability
- `/finance/general-ledger`, customer ledger, balance sheet, cash flow, bank transactions
- `/approvals/workflows`, `/approvals/requests`
- `/ai/status`, `/ai/quotation-draft`
- `/admin/integrations`, `/admin/branches`
- `/automation/rules`, `/automation/jobs`
- `/reports/saved`

Live provider groups under `/integrations`:

- `/status`, `/:provider`
- `/email/send`, `/sms/send`, `/whatsapp/send`, `/deliveries`
- `/gst/verify`, `/gst/einvoice/:invoiceId`, `/gst/ewaybill/:invoiceId`, `/gst/submissions`
- Public verified callbacks: `/webhooks/meta`, `/webhooks/brevo`, `/webhooks/msg91`

All provider configuration/actions require authentication and RBAC except the
callback endpoints, which require a provider signature or high-entropy webhook
token. API secrets are never accepted in request bodies.

New list endpoints accept `page`, `limit` (maximum 200) and, where useful, `q`.
Permissions are enforced by module/action on the server.

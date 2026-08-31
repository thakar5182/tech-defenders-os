# Live Provider Integrations

Tech Defenders OS v3.1 includes real server-side adapters for:

- Brevo transactional email (`POST /v3/smtp/email`)
- MSG91 Flow SMS for India DLT-approved templates
- Meta WhatsApp Cloud API for approved Business templates
- Sandbox.co.in GST e-Invoice/IRP and E-Way Bill APIs

Open **Administration → Live Integrations** to enable a provider, inspect the
required Render environment variables, run live verification, and view masked
delivery/GST history. Enabling a provider without credentials reports
`missing_credentials`; credentials alone report `configured_not_verified`; only
a successful provider request changes the state to `active`.

## Security and reliability

- Secrets are accepted only from environment variables and never returned by an API.
- Recipients are masked in the delivery log.
- Message requests support `Idempotency-Key`; GST invoice/E-Way submissions use
  deterministic per-invoice keys by default.
- Email/SMS/WhatsApp retry only timeouts, HTTP 429 and provider 5xx responses.
- GST generation is not automatically retried because duplicate compliance
  submissions require controlled reconciliation.
- Provider messages, request hashes, IRN/acknowledgement and E-Way Bill numbers
  are audit logged. No API key/token is stored in an audit record.
- Meta callbacks use `X-Hub-Signature-256`. Brevo and MSG91 callback URLs use a
  high-entropy token configured in the provider dashboard.

## Operational endpoints

| Function | Endpoint |
|---|---|
| Provider state | `GET /api/integrations/status` |
| Send email | `POST /api/integrations/email/send` |
| Send SMS | `POST /api/integrations/sms/send` |
| Send WhatsApp | `POST /api/integrations/whatsapp/send` |
| Delivery history | `GET /api/integrations/deliveries` |
| Verify GST session | `POST /api/integrations/gst/verify` |
| Generate IRN | `POST /api/integrations/gst/einvoice/:invoiceId` |
| Generate E-Way Bill | `POST /api/integrations/gst/ewaybill/:invoiceId` |
| GST history | `GET /api/integrations/gst/submissions` |

## Webhook URLs

Replace `https://your-service.onrender.com` with the real Render hostname:

- Meta verification/callback: `https://your-service.onrender.com/api/integrations/webhooks/meta`
- Brevo: `https://your-service.onrender.com/api/integrations/webhooks/brevo?token=<BREVO_WEBHOOK_TOKEN>`
- MSG91: `https://your-service.onrender.com/api/integrations/webhooks/msg91?token=<MSG91_WEBHOOK_TOKEN>`

Never place the provider API key in a webhook URL.

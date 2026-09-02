# Render Deployment

The included `render.yaml` uses a Render **Free** web service plus external
PostgreSQL. Render's local filesystem is ephemeral, so `DATABASE_URL` is a
required secret. A Neon Free PostgreSQL connection string can be used.

## Deploy (Free plan)

1. Put this extracted project in a (private or public) GitHub repository.
2. Create a PostgreSQL database and copy its pooled connection string.
3. In Render, choose **New → Blueprint**, connect the repository and approve
   `render.yaml`. Enter `DATABASE_URL` and a new 12+ character
   `INITIAL_SUPERADMIN_PASSWORD` when prompted.
4. Add the provider environment variables below in **Environment**. Mark every
   key/token/password as secret and never put real values in `render.yaml`.
5. Deploy and confirm `/api/health` returns `ok: true` plus
   `storage.mode: "postgres"` and `storage.durable: true`.
6. Log in as `superadmin@techdefenders.in`, complete Company Settings and
   manage role accounts from Platform Control.

## Google Sign-In

Create a Google **Web application** OAuth client, add the exact Render HTTPS
origin under Authorized JavaScript origins, and put its public client ID in
`GOOGLE_CLIENT_ID`. No Google client secret belongs in this app. Set
`GOOGLE_AUTO_SIGNUP=true` to let a new verified Google user create a normal
organization-admin workspace; Google login can never create a Super Admin.

## Required provider variables

| Provider | Render variables |
|---|---|
| Brevo | Secret `BREVO_API_KEY`; `BREVO_SENDER_EMAIL=techdefenderss@gmail.com` and `BREVO_SENDER_NAME=Tech Defenders` are predeclared |
| MSG91 | `MSG91_AUTH_KEY`, optional default `MSG91_DEFAULT_TEMPLATE_ID`, `MSG91_WEBHOOK_TOKEN` |
| Meta WhatsApp | `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, optional template/language defaults |
| Sandbox GST | `SANDBOX_API_KEY`, `SANDBOX_API_SECRET`, `SANDBOX_EINVOICE_USERNAME`, `SANDBOX_EINVOICE_PASSWORD`, optional `SANDBOX_GSTIN`, `SANDBOX_IRP_SOURCE` |

Brevo is required for public new-workspace signup and optional email-OTP login.
The packaged sender `techdefenderss@gmail.com` has been verified in Brevo. Add
the saved key only to Render's secret `BREVO_API_KEY` field. Until that key is present, packaged
password accounts can still sign in, but email OTP delivery and public signup
return an explicit configuration error instead of creating an unverified user.

## Ollama boundary

The Windows `SETUP.bat` Ollama auto-configuration applies when Tech Defenders OS
and Ollama run on the same PC. A Render container cannot reach Ollama running on
your Windows computer through `127.0.0.1`; therefore keep local AI disabled on
Render unless a separately secured AI service is designed and deployed.

## Before GST submission

Company Settings must contain the legal name, GSTIN, state code and a complete
address with six-digit pincode. Each B2B customer needs GSTIN/state/address, and
every invoice line needs a valid HSN/SAC code. Generate an IRN first; the E-Way
Bill action then requests the transport mode, distance and vehicle/transporter
details.

## Backup and recovery

PostgreSQL is the durable source of truth. Enable your database provider's
point-in-time recovery or scheduled exports. Local JSON snapshots on Render
Free are diagnostic only and disappear with the container.

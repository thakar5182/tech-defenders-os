# Render Deployment

The included `render.yaml` is now configured for Render's **Free** web-service
plan (no cost, no persistent disk).

> ⚠️ **Free tier data-loss warning:** Render's Free web services use an
> **ephemeral filesystem**. This app stores all business data as JSON files
> under `data/` (with snapshots under `backups/`) on local disk via
> `db/store.js`. On the Free plan, that data is **wiped on every redeploy,
> manual restart, and automatic idle spin-down** (Free services spin down
> after ~15 minutes of inactivity and restart clean on the next request).
> Use the Free plan only for demos, evaluation or short-lived testing —
> **never for real/production data**. To keep data across restarts, upgrade
> to a paid plan and restore the persistent-disk configuration described in
> "Upgrading to persistent storage" below.

## Deploy (Free plan)

1. Put this extracted project in a (private or public) GitHub repository.
2. In Render, choose **New → Blueprint**, connect the repository and approve
   `render.yaml`. It provisions a single Free web service with no disk.
3. Add the provider environment variables below in **Environment**. Mark every
   key/token/password as secret and never put real values in `render.yaml`.
4. Deploy and confirm `https://<service>.onrender.com/api/health` returns
   `ok: true`.
5. Log in, change all starter passwords, complete Company Settings and enable
   providers under **Administration → Live Integrations**. Remember any data
   entered here disappears on the next restart/redeploy/spin-down (see
   warning above).

## Upgrading to persistent storage (paid plan)

When ready for real data, edit `render.yaml`:

1. Change `plan: free` to a paid plan such as `starter`.
2. Add back a `disk:` block mounted at `/var/data` (e.g. `sizeGB: 1`).
3. Add back the `DATA_DIR=/var/data/tdos` and `BACKUP_DIR=/var/data/backups`
   environment variables so the app writes to the persistent disk instead of
   the container's local, ephemeral `data/`/`backups/` folders.
4. Keep exactly one instance — this JSON store is not safe for multiple
   concurrent instances. Migrate to PostgreSQL before scaling out.

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

On the **Free** plan, backups written to the local `backups/` folder are lost
along with everything else on restart/redeploy/spin-down, so treat the Free
deployment as disposable. On a **paid** plan with the persistent disk
restored (see above), download `/var/data/backups` snapshots regularly to
independent storage — a Render disk protects records across deploys but is
not an off-site backup. For multiple server instances or high concurrency,
migrate the store to PostgreSQL before scaling.

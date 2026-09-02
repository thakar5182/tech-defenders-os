# Production Deployment

1. Use Node.js 22.3+ and set `NODE_ENV=production`.
2. Generate a unique 48-byte `JWT_SECRET` and set `COOKIE_SECURE=true`.
3. Place the app behind an HTTPS reverse proxy on one canonical hostname.
4. Set `DATABASE_URL` to durable PostgreSQL and `REQUIRE_PERSISTENT_STORAGE=true`.
5. Set a secret 12+ character `INITIAL_SUPERADMIN_PASSWORD` before first boot.
6. Keep `SYNC_SUPERADMIN_PASSWORD=false` except during an explicit recovery.
7. Set `PUBLIC_APP_URL` to the canonical HTTPS origin and generate a separate
   32+ character `INVOICE_LINK_SECRET` for signed invoice/unsubscribe links.
8. Configure provider and import limits from `.env.example`, then run `npm test`
   and `npm audit --omit=dev` in the deployment environment.
9. Configure firewall, log retention, monitoring, disk-space alerts and restore drills.

The PostgreSQL adapter durably stores every collection while preserving the
existing API. Keep one application instance until stock/accounting workflows
are migrated to row-level SQL transactions and the queue becomes distributed.
For Render Persistent Disk and provider onboarding, follow
`RENDER-INTEGRATIONS.md`, then complete the controls in `INTEGRATIONS.md`.

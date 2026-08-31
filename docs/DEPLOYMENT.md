# Production Deployment

1. Use Node.js 18+ and set `NODE_ENV=production`.
2. Generate a unique 48-byte `JWT_SECRET` and set `COOKIE_SECURE=true`.
3. Place the app behind an HTTPS reverse proxy on one canonical hostname.
4. Put `DATA_DIR` and `BACKUP_DIR` on durable, access-controlled storage.
5. Run one application instance only while using the JSON store.
6. Change all bundled passwords and remove accounts that are not required.
7. Run all three test suites and `npm audit --omit=dev` in the deployment environment.
8. Configure firewall, log retention, monitoring, disk-space alerts and restore drills.

Before multiple instances, migrate to PostgreSQL and a durable background queue.
For Render Persistent Disk and provider onboarding, follow
`RENDER-INTEGRATIONS.md`, then complete the controls in `INTEGRATIONS.md`.

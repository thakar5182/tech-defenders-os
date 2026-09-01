# Architecture

## Runtime

- Express server in `server.js`
- Route modules under `src/routes/`
- Shared GST, RBAC, numbering, stock, audit and notification helpers in `src/util.js`
- Atomic JSON collections in `db/store.js`
- Vanilla JavaScript hash-routed SPA under `public/`

Every business record carries `orgId`. Authentication resolves an active
organization and route predicates filter IDs and references to that organization.
Super Admin may switch the active organization through a signed replacement
session; normal users cannot.

## Request path

1. Security headers, request ID and same-origin write guard
2. JWT cookie verification and token-version revocation check
3. Password-change enforcement
4. Module/action permission middleware
5. Organization-scoped validation
6. Business mutation, accounting/stock effect and hash-chained audit event

## Deployment shape

This edition runs as one Node.js process. Static files and APIs share one origin,
which supports strict SameSite cookies. Use a TLS reverse proxy in production.
Do not start multiple app instances against the same JSON directory.


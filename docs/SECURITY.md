# Security Notes

- JWT sessions use HTTP-only, strict SameSite cookies.
- Production refuses a JWT secret shorter than 32 characters.
- Token versions revoke sessions after password/access changes and logout.
- Password hashes/reset secrets are never returned to the browser.
- Temporary passwords require a change before business APIs are available.
- Unsafe browser requests with a foreign Origin are rejected.
- Permissions and tenant checks run on APIs, not only in navigation.
- Integration secrets are environment-only.
- New audit entries are SHA-256 chained to reveal alteration of the sequence.
- CSP, content-type, frame, referrer and permissions headers are set.

For internet deployment add TLS, a persistent/distributed rate limiter, managed
secrets, centralized logs, backup encryption, vulnerability monitoring,
malware scanning before enabling attachments and an independent penetration test.


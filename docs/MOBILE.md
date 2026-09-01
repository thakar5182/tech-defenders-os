# Android mobile connection

Tech Defenders OS v4.2 exposes the same role-based business APIs to the official
Android client. Password and OTP login requests identify themselves with
`X-TD-Client: mobile` (and `client: mobile` in the JSON body). Successful mobile
login responses include a signed bearer token; browser login continues to use
an HTTP-only cookie and does not expose the token in JSON.

## Cloud requirement

The Android app does not require a laptop or PC to stay switched on. It does
require this backend to be deployed continuously at an HTTPS URL. Configure that
URL as `expo.extra.apiUrl` in the Android source `app.json`, or enter it on the
app login screen.

For production, use persistent storage/database hosting. Render Free instances
can sleep and their local filesystem is not durable, so they are suitable only
for preview/testing unless persistent storage is configured.

## Mobile API contract

- `POST /api/auth/login` accepts password login plus `client: mobile`.
- `POST /api/auth/request-otp` and `POST /api/auth/login-otp` support OTP login.
- `Authorization: Bearer <token>` authenticates subsequent API calls.
- `GET /api/health` reports `mobileApi: true` when this v4.2 backend is deployed.
- Existing permissions and organization scoping apply unchanged on mobile.
- Data Package Studio imports use `/api/ops/imports`; documents use
  `/api/ops/documents`.

## Production checklist

1. Change every seeded password.
2. Set a long random `JWT_SECRET` and enable secure cookies.
3. Deploy only behind HTTPS and restrict CORS to trusted origins.
4. Configure durable `DATA_DIR`/database storage and automated backups.
5. Configure the verified Brevo sender if OTP/email features are required.
6. Confirm `/api/health`, mobile login and role permissions before distributing
   the APK/AAB.

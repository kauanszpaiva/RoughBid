# Authentication and access control

RoughBid uses Supabase Auth as its single identity boundary. Enable email OTP/magic
links and the required Google, Azure, or Okta provider in the Supabase dashboard.
Register only `${APP_URL}/auth/callback` as a redirect URL. Provider secrets and the
Supabase service-role key are server-only; browser code receives only the public URL
and publishable key.

## Roles

Workspace authorization is enforced by PostgreSQL row-level security, not UI state:

| Role | Access |
| --- | --- |
| Admin | Workspace/member administration and all project operations |
| Estimator | Read/write projects, estimates, and plan files |
| Viewer | Read projects, estimates, and plan files |

Platform administrators remain a separate profile flag and do not implicitly join a
tenant. Every query still requires workspace membership, preventing cross-organization data
access.

## Workspace access operations

1. An admin-only server route calls `issueAccessGrant`. Persist the supplied digest and
   dates in `access_grant_tokens` with a service-role client; display the returned secret
   once and never log it.
2. An authenticated user submits the secret. Hash it in the API and invoke
   `redeem_access_grant` with the user's Supabase session (never the service role).
3. The database locks and consumes the token, creates a dedicated workspace with the
   user as Admin, and creates the configured entitlement in one transaction.
4. RLS gates each project and storage object by both active entitlement and membership.
   At the expiration instant, product access ends automatically. Tokens are single-use.

Treat access grant secrets like passwords: send them over HTTPS, redact request bodies
and query strings from logs, rate-limit redemption by user and IP, and revoke exposed
grants server-side.

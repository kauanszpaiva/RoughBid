# Authentication and access control

RoughBid uses Supabase Auth as its single identity boundary. The current application
uses branded email magic links and is invite-only during the limited pilot. Register
`${APP_URL}/app/` as the allowed redirect for these links, preserving the invitation
query parameters. The older OAuth/SSO server helpers use `${APP_URL}/auth/callback`;
that callback needs an explicit application route before enabling those providers.
The current login UI does not offer OAuth/SSO. Provider secrets and the Supabase
service-role key are server-only; browser code receives only the public URL and
publishable key.

The browser reports failed or stalled saved-session resolution with a retry action.
An expired email link has an explicit recovery message; raw callback errors are not
displayed. Sign-out affects this device, waits for the SDK confirmation and preserves
an actionable error when the SDK fails. Changing accounts cannot consume the previous
account's completed authenticated response or show its workspace invitation.

Production prerequisites are the existing `reserve_magic_link_attempt` and
`authorize_roughbid_magic_link` RPCs, their service-role grants, an authorized user or
valid invitation, Supabase redirect configuration and the configured email sender.
Variable names are `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `RESEND_API_KEY` and
`AUTH_RATE_LIMIT_SECRET` (or the existing server-only fallback). Their values and
production delivery were not inspected or tested in the isolated implementation.
The endpoint deliberately returns the same accepted response for unknown accounts
and unconfirmed delivery, preserving the existing anti-enumeration policy. A browser
success message means the request was accepted; it does not prove email delivery.

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

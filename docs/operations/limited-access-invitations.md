# Limited RoughBid access invitations

The platform owner manages invitations under **Access invitations** in the desktop sidebar or mobile menu. This is separate from **Invite a teammate**, which shares an existing company's workspace.

## Access presets

| Preset | Access period after redemption | New-project allowance |
| --- | --- | --- |
| Single-project sample (`sample1`) | 7 days | 1 project total |
| Limited month (`month1`) | 30 days | 1 project in each rolling 7-day window |
| Pilot (`pilot60`) | 60 days | 2 projects in each rolling 7-day window |

Every preset permits one PDF per project, no larger than 10 MiB or 10 pages, and one AI attempt per project. The account allocation is $5, with a shared $100 cohort ceiling; the other $25 of the owner's stated $125 maximum is a safety reserve. Usage reservations are conservative allocations, not proof of the provider's actual invoice cost.

The cohort has at most 25 distinct invited email addresses. Duplicate requests preserve the original invitation and preset. Revocation and expiration do not erase the audit record or restore a previously allocated seat. The owner's complimentary account is excluded from these allocations.

## Owner workflow

1. Select a preset and enter the intended recipients, one per line or separated by commas. The dashboard accepts up to 25 per submission and sends one recipient per API request so progress remains recorded if the browser closes.
2. Submit **Send access invitations**. This is the explicit send action; opening or refreshing the dashboard sends nothing.
3. Check status. **Sent** means the provider accepted the message, not that the recipient's inbox delivered it. Failed messages remain visible for retry. Successfully sent invitations are not resent by duplicate submissions. The owner can copy an unexpired private link if the recipient needs it again.
4. The recipient opens the invitation and signs in or creates an account with that exact email. The token is preserved through the branded authentication email. Redemption creates a separate private workspace and starts the selected period. Forwarding the link to another email does not grant access.
5. **Revoke access** ends the complimentary grant. Saved projects remain; normal paid use continues through standard checkout.

Recipients are not enrolled into the owner's workspace. No card is collected at activation, and no automatic charge is scheduled at expiry. Later paid use follows RoughBid's standard checkout. Automatic conversion would require a separate subscription/card acceptance flow and is not implemented by these invitations.

## Server requirements

- Apply migrations `0027_limited_pilot.sql`, `0031_pilot_notifications.sql`, and the coordinated provider/billing migrations before enabling invitations.
- Set `PILOT_INVITE_SIGNING_SECRET` to a stable, randomly generated server-only secret of at least 32 characters. Do not use a public `VITE_` variable, return it to the browser, or rotate it casually: rotation invalidates outstanding links. HMAC uses a dedicated domain and normalized email so retry does not require plaintext token storage.
- Reuse the verified `RESEND_API_KEY`, HTTPS `APP_URL`, and server Supabase credentials.
- Keep authentication redirects for `/app/` with the `pilot_invite` query intact.
- The database independently checks the owner's privileged flag, token digest, authenticated email, cohort capacity, single enrollment, project quotas, file limits, and budget reservation.
- The email provider idempotency key is `roughbid-pilot-invite/<invitation id>`. Stored message IDs prevent re-dispatch after recorded acceptance. If delivery succeeded but tracking failed, check the provider before retrying after its idempotency retention period.

## Delivery and expiry reminders

The existing Resend sending domain `mail.kspdominion.group` was verified on 2026-09-08; existing RoughBid sign-in and organization invitations had delivered statuses that day. No pilot invitations were sent during development. The delivery webhook at `/api/webhooks/resend` and server-only `RESEND_WEBHOOK_SECRET` were configured during this release. Production rejected unsigned events and accepted a signed, ignored QA event. The handler authenticates the raw request body, checks a five-minute timestamp tolerance, and stores deduplicated provider event IDs. A real recipient delivery remains to be observed after the owner selects participants.

`GET /api/pilot/reminders` sends due notices 7 days and 1 day before expiry, then once after expiry, omitting the first notice for the 7-day sample. Set a server-only `CRON_SECRET` and invoke this endpoint with the matching Bearer authorization using the hourly Vercel cron. Each invocation claims at most 10 outbox rows with independent leases. The database deduplicates enrollment/notice/expiry, suppresses revoked or bounced recipients, preserves a stable provider idempotency key, and stops uncertain attempts for manual review after 23 hours or five attempts. Empty cohorts dispatch no email. Failed provider requests retry after 15 minutes; hourly execution drains the cohort and keeps retries inside the provider idempotency window. `pilot_notification_outbox` stores status, attempts, acceptance, and provider delivery status. Deployment must configure the cron and webhook before treating notifications as operational.

## Validation performed

The hourly cron and its credential were configured in production on 2026-09-08. An authenticated empty-cohort run returned `claimed:0,sent:0,failed:0`; an unauthenticated request returned 401. This verifies deployment and database access without sending messages.

Behavior tests cover owner/customer separation, session-derived identity, cohort rejection before sending, token digest storage, preserved authentication redirect, duplicate/expired/revoked invite handling, failed-email retry state, provider idempotency, safe response fields, and stated email limits. The coordinated migration test suite verifies the actual database rules. A passing build does not prove real recipient activation or actual provider expenditure.

The notification tests also execute PostgreSQL to validate due windows, exclusive leases, immutable outbox identities, repeated-send prevention, late-event reconciliation, bounce suppression, and service-only access. Signature tests include the official published example from [Svix manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual). Resend's [verification documentation](https://resend.com/docs/webhooks/verify-webhooks-requests) requires the original raw request body; the implementation follows that contract.

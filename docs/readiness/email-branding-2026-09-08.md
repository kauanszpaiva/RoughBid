# RoughBid email branding verification — 2026-09-08

The local login, limited-access invitation, and expiry reminder emails now use the same RoughBid logo and table layout. The public PNG URL is `https://roughbid.vercel.app/brand/roughbid-logo-email.png`, displayed at 240 × 80 with automatic height on a white header. Images have explicit dimensions, `alt="RoughBid"`, and `border="0"`. Every email retains a plaintext alternative.

The HTML renderer escapes headings, body copy, footer copy, and action URLs. The authentication URL, pilot token, recipient-bound activation, limits, no-automatic-charge terms, and provider idempotency keys are unchanged.

Four remote Resend templates were read, updated, published, then read again successfully:

| Template | Alias | Verified after publication |
| --- | --- | --- |
| [Workspace Welcome](https://resend.com/templates/66b1db59-f33c-47d1-99bc-27771cac4413) | `roughbid-workspace-welcome` | Logo, original variables, original plaintext |
| [Organization Invite](https://resend.com/templates/89f054a6-1593-4079-9065-f60586c0f477) | `roughbid-organization-invite` | Logo, original variables, original plaintext |
| [Proposal Opened](https://resend.com/templates/61d9441b-de16-4a75-8dae-274e1af12d8f) | `roughbid-proposal-opened` | Logo, original variables, original plaintext |
| [Proposal Signed](https://resend.com/templates/84301e57-44cb-4a93-829e-9b548aad9d28) | `roughbid-proposal-signed` | Logo, original variables, original plaintext |

Their subjects and sender remain unchanged. No other project's templates were changed. Resend regenerated the plaintext when HTML alone was changed; the exact original plaintext was restored explicitly and verified after republication.

The proposal templates expect `APP_URL`, while the application previously provided only `PROPOSAL_URL`. The application now supplies `APP_URL` as an additional alias for the same proposal URL, preserving the existing variables. This prevents the published templates' buttons from silently using their homepage fallback.

Validation: 29 relevant email, invitation, and notification tests passed, including action-URL preservation, HTML escaping, plaintext fallbacks, logo attributes, template variable mapping, and idempotency. API TypeScript validation passed. No real email was sent by this branding task; asset publication, actual inbox rendering, login completion, and Supabase SMTP/template verification are separate deployment acceptance checks.

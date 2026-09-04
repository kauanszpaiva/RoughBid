# Resend integration status

Verified sending domains already available:
- `kspdominion.group`
- `mail.kspdominion.group`

Draft template needed:
- Name: RoughBid Workspace Welcome — Draft
- Alias: `roughbid-workspace-welcome`
- Sender: `RoughBid <hello@mail.kspdominion.group>`
- Status: not published and no email was sent from this repo work.

Draft template created through the Resend connector on 2026-09-04:
- Name: RoughBid Workspace Invite Approval Draft
- Alias: `roughbid-workspace-invite-approval`
- Template ID: `6db15836-91a2-4b31-b08f-abcd2355d135`
- Preview: https://resend.com/templates/6db15836-91a2-4b31-b08f-abcd2355d135
- Status: draft; publish only after Kauan approves sender/copy.

Approval email copy is stored in
[`docs/approvals/resend-approval-email.md`](../approvals/resend-approval-email.md).
Transactional send requires explicit `from` and recipient addresses in the connector.

The final product domain can replace the KSP sender once the brand/domain is approved and DNS is verified.

Published RoughBid SaaS templates created on 2026-09-04:
- Name: RoughBid Workspace Welcome
- Alias: `roughbid-workspace-welcome`
- Template ID: `66b1db59-f33c-47d1-99bc-27771cac4413`
- Preview: https://resend.com/templates/66b1db59-f33c-47d1-99bc-27771cac4413
- Sender: `RoughBid <hello@mail.kspdominion.group>`
- Status: published

- Name: RoughBid Organization Invite
- Alias: `roughbid-organization-invite`
- Template ID: `89f054a6-1593-4079-9065-f60586c0f477`
- Preview: https://resend.com/templates/89f054a6-1593-4079-9065-f60586c0f477
- Sender: `RoughBid <hello@mail.kspdominion.group>`
- Status: published

Backend activation:
- Add `RESEND_API_KEY` to Vercel Production.
- Optionally add `APP_URL=https://roughbid.vercel.app`.
- Workspace invites automatically send `roughbid-organization-invite` when `RESEND_API_KEY` exists; the API still returns the invite link as backup.

Supabase Auth email:
- Browser login currently uses Supabase Auth magic links.
- To send Supabase Auth emails through Resend, configure Supabase Auth SMTP with the Resend SMTP credentials in the Supabase dashboard or Management API.
- Keep the app URL and redirect URL as `https://roughbid.vercel.app` until the final RoughBid domain is purchased and verified.

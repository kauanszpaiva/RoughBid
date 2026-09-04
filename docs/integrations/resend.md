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

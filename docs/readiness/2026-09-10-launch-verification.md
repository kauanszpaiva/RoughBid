# RoughBid launch verification — 2026-09-10

This release follows production `19e6374017eaca5af743cd81359f42bd9d720de2`.
Its scope is correcting verified data-integrity and recovery defects and proving
the controlled-pilot journey. Commercial GA remains separately gated.

## Changes

- Finding geometry is extraction evidence, not a verified cost source. Newly
  accepted quantities need estimator-entered prices. Historical lines tagged
  `AI Finding Geometry Pricing` retain their quantities, amounts and source for
  review, but block final export until an estimator explicitly confirms costs.
- Rapid duplicate review actions are guarded. An accepted finding whose import
  was interrupted by closing the modal can be recovered after reopening.
- A failed saved-result load can be retried without another provider request.
- Durable saved-result retrieval selects its explicit findings relationship.
- Identical unfinished uploads can renew their signed URL without inserting
  another file or consuming another pilot file allocation. Completed files cannot
  be overwritten. Tenant, uploader, metadata and storage-path checks remain.
- Proposal opening/signing locks the target row before changing its state.
  Migration `0038_serialize_client_proposal_actions.sql` was applied as
  `20260910161422`; public token permissions are preserved.
- Invitation capacity comes from the cohort. Removed stale budget-margin copy;
  missing address-comparison data no longer implies manual estimating is blocked.

## Live evidence before this candidate's production deployment

- Official project: GitHub `kauanszpaiva/RoughBid`; Supabase
  `piasgpciojstjalaqazu`; Vercel `prj_dPsFKXX7HQXFSxbwb8lg5Z4stc9s`, KSP team.
- Owner session opened its real projects, 23-page PDF, saved findings and the
  usage dashboard. Missing historical telemetry is explicitly unknown.
- One invitation and real email magic-link login reached a KSP QA recipient.
  Gmail classified both as spam despite SPF, DKIM and DMARC passing. Provider
  acceptance alone was not used as delivery evidence.
- The wrong signed-in email could not redeem the invitation. The correct
  recipient received a separate workspace, activated for exactly 60 days,
  with a two-project rolling-seven-day quota.
- Actual QA authentication was used against production API routes: owner usage
  and invitation administration denied with 403, cross-tenant project read/write
  and file read denied with 404, cross-tenant finding write denied with 403.
  Its own project returned 200; anonymous owner usage returned 401.
- Independent read-only SQL/RLS tests confirmed real owner records exist but
  cannot be selected by the QA identity. The SQL transaction was rolled back.
- Cohort capacity 25, lifetime reservation cap $100, per-participant cap $5,
  one $0.25 reservation per AI attempt. No budget increase or real charge.

## Validation and evidence boundaries

Regression coverage includes malicious geometry prices, manual price confirmation,
duplicate acceptance, reopening after interrupted acceptance, interrupted uploads,
tenant/path mismatch and proposal row locking. Browser fixtures are explicitly
synthetic; they are separate from the real supplied PDF used for pilot verification.
Chromium and WebKit passed the PDF/CSP and React review tests.

The production smoke ledger must be updated after deployment. An old deployment
being READY does not certify this candidate. A full Stripe TEST Checkout and
signed-webhook cycle, approved membership prices and appropriate LIVE configuration
are required for paid GA; see the separate Stripe audit.

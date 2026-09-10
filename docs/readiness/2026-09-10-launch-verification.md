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

Each deployment is verified against its exact merge commit. An old deployment
being READY does not certify the next candidate. A full Stripe TEST Checkout and
signed-webhook cycle, approved membership prices and appropriate LIVE configuration
are required for paid GA; see the separate Stripe audit.

## First production verification and follow-up

PR51 merged as `aadd0234f85fb8922dc50a03306224b57fb0efaa`. Vercel deployment
`dpl_EMRQhktfL43zduRqygWAuDoES4vL` became READY and served `roughbid.vercel.app`.
The candidate passed 454 tests and both browser gates before merge.

The interrupted pilot upload resumed the same file ID and completed with the real
ten-page PDF. The authenticated browser rendered it. All eight API authorization
checks passed again; a third project was refused with HTTP429 and no new row.

The first actual pilot analysis failed safely at JSON parsing. The provider
reported 6,281 input and 4,089 output tokens; the corresponding estimated cost was
$0.020045 and actual invoiced cost remained unknown. The single $0.25 reservation
remained counted. No findings or substitute quantities were saved. The near-cap
output strongly suggests truncation; that response's finish reason was not logged.

The follow-up patch bounds the pilot response to twelve prioritized evidence
findings with a structured schema, includes schema text in token preflight, rejects
MAX_TOKENS distinctly, and visibly discloses incomplete coverage. Input/output,
model, reservation and attempt limits remain unchanged. Its real provider
acceptance must be verified after deployment in the QA account's second existing
project using that project's unused normal file/AI allowance. No quota reset.

## Verified bounded pilot run and human review

PR52 merged as `cfc33dd208b1522fe9b12eceff67592ab469abbe`; production deployment
`dpl_BjnLWNBJ9HqTUBikMwrSd56GViij` was READY at the production alias. The tested
candidate passed 469 tests, type checks, build, production dependency audit
(zero reported vulnerabilities), and Chromium/WebKit browser gates. Expired
cached sessions now perform one safe refresh for protected GETs; definitive
refresh rejection returns the user to sign-in. Mutations are never replayed.

The second existing QA project `0482d510-d894-4b55-954c-463ea0479ddf` used its
normal unused file/AI allowance. Its real PDF is the unchanged first ten pages
of the 23-page 24 Angell architect set, SHA-256
`ef1be96d0b021534615adb29c33743bdc5ad97606563a950d8366e1ffef0fb05`.
Job `12845d78-e45f-4fd7-92e6-9ece29599ff9` completed at 17:07:02 UTC with
11 persisted findings requiring human review. One candidate without usable
evidence was omitted. The browser rendered the PDF, saved findings and explicit
partial-coverage warnings. This is not certification of an exhaustive takeoff.

Human review accepted the first-floor unit area of 1,270 SF after checking the
actual page 7 text. A slab item that confused a 4-inch thickness with a 4-LF
quantity was rejected. Final state: one accepted, one rejected, nine pending.
The accepted quantity retained its finding/page provenance and had no invented
cost. Client PDF, internal PDF, CSV and proposal export remained blocked until
an estimator supplies verified prices.

The two real QA runs reserved $0.50 in total; their combined token-based estimated
cost was $0.032152. Actual provider invoiced cost remains unknown. No quota or
budget was reset. All eight live authorization checks passed again, and a third
project was refused with HTTP429 without inserting a row.

## Payment-return follow-up candidate

A real Stripe-hosted TEST payment succeeded, but signed delivery initially
returned HTTP400. The matching existing TEST endpoint signing secret was
corrected in Vercel Production and requires this candidate's deployment.
Server diagnostics report only a fixed validation stage, never payloads,
signatures, keys or freeform error details.

The paid-return fix reads the existing quote through an authenticated, scoped,
read-only GET. It restores its original trades and scope on reload and separates
payment refresh from explicit AI start. Unpaid prices may be recalculated after
rechecking saved state; saved completed readings remain accessible during a
provider outage. The mode filter prevents historical TEST quotes appearing after
a LIVE-mode switch. Browser fixtures cover these transitions and verify that
passive recovery creates no quote, checkout, write or AI request.

Signed payment delivery, duplicate delivery, refund revocation and the real
payment-return UI must be recorded after this candidate becomes production.
The Stripe audit records exact TEST object IDs and the remaining commercial gates.

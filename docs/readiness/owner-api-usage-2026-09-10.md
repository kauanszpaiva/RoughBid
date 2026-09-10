# Owner API usage - implementation and release evidence

## Outcome and scope

Issue #45. Private administrative panel inside Settings & Estimator Profile for the
confirmed canonical owner, `kauan@kspdominion.group`. The server verifies the exact
Auth user ID, confirmed email and a fresh platform-admin role. Ordinary users and
unconfirmed identities are denied before financial data queries.

GET `/api/owner-usage?days=60` supports 7/30/60/90 days, global/per-user operations,
tokens, estimates, unknowns, historical coverage gaps and live cohort reservations.
It refreshes approximately every 15 seconds while open and visible. This is polling,
not a live provider invoice. There is no paid API call just to display the report.

Every Gemini generate/count operation inside the synchronous service or durable
worker writes an attempt before dispatch and settles trusted SDK usage before AI
output parsing. Generation output includes thinking tokens. Accounting failures stop
model/provider fallback. Transport errors retain unknown costs; settlement failures
retain pending exposure. No plan text, PDF content, secrets or prompts enter telemetry.

`actual_cost_usd` is displayed only when a value already exists in the trusted ledger.
This change DOES NOT connect Google billing or retrieve a prepaid balance. Estimates
are not provider-confirmed expenditures. Historical absent telemetry stays unknown.
Other providers, platform invoices and other applications are outside this meter.

## Audited production state (2026-09-10, read-only)

- Main: b81370e67d7ed88d9efd24e17ff417ff3be3ee23.
- Integration base: PR #41 at c9f7f5d4011d1b98a084420a4c5f7d9cfecd05e0.
- 22 historical jobs, zero usage ledger events, zero pilot enrollments at audit.
- founding-pilot-60d: 25 seats, $100 lifetime reservation budget, $0 reserved.
- API previously advertised $125; the new response reads the real database value.
- Pilot SQL already enforces rolling weekly projects, expiry, one PDF (10 MiB/10
  pages), one AI attempt/project, $0.25 permanent reserve and $5 reserve/user.
- Owner complimentary use is not free provider usage and is not covered by the
  pilot cohort cap. Migration 0037 adds a separate atomic 25-attempt rolling
  24-hour cap across all owner workspaces; failed attempts remain counted.

## Funding scenario (not a measured cost forecast or hard guarantee)

Current Google standard Gemini 3.8 Flash tariff: $0.75/M input and $3.75/M output,
including thinking, through 2026-12-31. Meter tariff expires for review 2026-12-01.
Sources: https://ai.google.dev/gemini-api/docs/pricing and
https://ai.google.dev/gemini-api/docs/billing (checked 2026-09-10).

Assuming 32,000 input and 4,096 TOTAL charged output/thinking tokens per analysis:
$0.03936 per analysis, $0.70848 per person for 18 analyses in 60 days; 25 people:
450 analyses / $17.712; 35 people: 630 analyses / $24.7968. These exclude infrastructure,
non-pilot/owner usage, prior invoices, other apps and unmeasured provider overages.
The 35-person case is a scenario, not the active capacity.

At the unchanged $0.25 permanent reserve, those cohorts need $112.50 and $157.50
respectively. The current $100 cap admits at most 400 reserved attempts. Adding
provider credit alone does not change that internal reservation bottleneck.

Recommendation: start with $30-$50 of isolated provider credit, auto-reload disabled,
only after checking the correct billing account and existing balance. Retain the
$100 internal cap. Do not promise uninterrupted full-quota use until safe reserve
settlement or a separately approved budget policy has been implemented. Provider
prepay/spend caps themselves have documented processing latency and are not an
instantaneous application-level safety gate. No credit was purchased by this work.

## Validation

Local production build and API/web typechecks passed. Full local monorepo suite:
431 passed / zero failed. Owner tests cover identity, role revocation, per-user
attribution, cost math, accounting outages, unknown telemetry, malformed model JSON,
no fallback on accounting errors and live cohort reporting.

Offline browser/component QA with synthetic data passed: closed panel makes no API
call; open report; search; period query; desktop/mobile overflow; sign-out clearing;
403 clearing. This is NOT an authenticated production smoke test. Localhost browser
navigation was unavailable in this runtime, so the same compiled component was
rendered offline with intercepted synthetic API responses.

The integration base contained strict TypeScript errors in App, AIPlanModal and
BlueprintViewer. Minimal fixes omit absent optional properties and type validated
bounding boxes as four-element tuples. No pricing or geometry behavior was changed.

## Release gates and limits

Do not merge/deploy the full integration base until PR #41's production schema and
release gates are approved and verified. No production migration or budget/provider
flag change was performed here. Recheck migration order and branch concurrency.

Before broader rollout: authenticated smoke of the new panel/attempt ledger; provider
billing reconciliation; owner-inclusive global atomic spending protection; safe
settlement of conservative pilot reservations; review usage ledger retention on
project/workspace deletion (existing foreign keys restrict project deletion and
cascade workspace deletion). Existing SELECT RLS for workspace admins must also be
reviewed against any owner-only visibility requirement beyond this new endpoint.

The new panel and endpoint are implemented; complete financial-control release is
NOT declared complete. Preserve reservations and do not label historical gaps $0.

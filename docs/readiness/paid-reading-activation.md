# Paid reading pilot: activation and recovery

Status: **NO-GO for release or provider activation**. This change implements
controls and isolated tests. It does not configure a budget, enable a workspace,
select a real model, create a hosted test environment or certify a real payment.
Stripe live and Gemini production require separate approval of the final SHA
and environment after the TEST gate. This implementation rejects live outright;
live requires another reviewed change, not merely an environment toggle.

## Admission and spending

The HTTP path requires `PAID_PLAN_READINGS_ENABLED=true`,
`PAID_PLAN_READINGS_STAGE=test`, `STRIPE_MODE=test`, an explicit `GEMINI_MODEL`
and a configured server-only key. `VERCEL_ENV=production` or
`APP_ENV=production` closes admission. There is no default/fallback model;
latest, preview and experimental aliases are rejected. Gemini must support the
selected request configuration before it can qualify for the isolated pilot.

Migration 0019 creates three private tables with RLS and no direct grants to
anonymous, authenticated or service-role clients:

- `plan_reading_pilot_config`: singleton `id=1`, disabled, budget zero, no model,
  token limits or rates. Only a database owner can configure it.
- `plan_reading_pilot_workspaces`: empty allowlist; each permitted workspace
  requires its own enabled row.
- `plan_reading_pilot_usage`: an immutable attempt identity `(job_id, attempt)`
  and quote/workspace identity, pinned model/rates/token ceilings, reservation,
  provider token usage/model version and settlement state. No PDF, PAN, prompt
  or other raw customer content belongs in this cost ledger.

Quote, checkout and reservation check the same workspace admission RPC. They
reject missing/exhausted capacity before PDF download or a new Stripe request.
The reservation RPC makes the final atomic decision using a global singleton
row lock shared by every workspace and settlement. A checkout does not itself
reserve AI capacity; a paid request can wait if another job consumes capacity.
No new payment is needed to retry the same eligible quote.

The per-attempt hold in USD is:

```text
(max_input_tokens * input_usd_per_million
 + max_output_tokens * output_usd_per_million) / 1,000,000
```

Admission requires lifetime exposure plus this hold to fit within `budget_usd`.
Exposure includes all measured attempts plus the full holds of pending or
unknown attempts, across every workspace. A new day, failed job, refund or
configuration update does not reset lifetime spend. Existing ledger rates and
limits do not change when the configuration changes.

Input is counted before generation; invalid or oversized counts deny dispatch.
Output is bounded to the configured limit (at most 8,000). The paid path sends
one generation request to one model, with one SDK attempt and no fallback.
Provider usage is recorded before findings can be completed. Input, candidate
output and thinking tokens are accounted for; unsupported tool usage or missing
or inconsistent metadata becomes unknown. Cached input is conservatively priced
at the full input rate. Reported model version is retained separately from the
requested model; a missing version is explicitly `unreported`.

USD telemetry is provider token usage multiplied by the pinned tariff, **not a
provider invoice**. Before enabling the pilot, verify the selected model,
context pricing tiers and request features against [Google's pricing](https://ai.google.dev/gemini-api/docs/pricing)
and [token-counting API](https://ai.google.dev/api/tokens). Configure a conservative
upper tariff for the entire permitted context. No numeric rate, model or budget
is approved by this document. The ledger does not cover infrastructure, other
applications sharing a key, taxes or calls made outside this API. Use a separate
provider project/key and its own quotas for the pilot.

Measured cost above a hold is never clipped: the full amount is counted and the
pilot is disabled. This limits admission using conservative bounds; it is not a
guarantee that a remote provider cannot bill above its reported/estimated bounds.

## Retry, credit and refund policy

This is the enforced TEST operational policy. Commercial refund eligibility and
customer terms still require approval before a live canary.

| Outcome | Cost treatment | Retry and customer-payment treatment |
| --- | --- | --- |
| Admission denied | No job, attempt or cost hold | No provider call. Correct consent, payment, allowlist or capacity first. |
| Reserved but generation never dispatched (including changed PDF) | Release the pending hold only after the server proves this path | The quote still counts the reserved attempt. At most two attempts total; changed PDF requires support review, never a silent replacement. |
| Provider replied with verifiable usage but result failed validation | Settle measured cost, save no invented findings | Explicit user retry may use the same paid quote, within two total attempts and remaining global capacity. |
| Provider timeout, invalid/missing usage, or process termination | Full hold remains unknown/pending | No automatic retry, credit, refund or release of estimated exposure. Operator reconciliation is required. |
| Result completed | Settle measured cost, persist `needs_review` findings | Reuse existing result without another charge; admin/estimator reviews it. |
| Settlement or database completion failed | Return reconciliation error; do not claim success | Inspect quote, job and usage state before any retry. |
| Two attempts used | Preserve all measured costs/holds | Stop. Support reviews evidence and any credit/refund decision; no automatic third attempt. |
| Refund/dispute event | Preserve provider cost ledger; existing signed-event path revokes payment eligibility | A refund does not refund Gemini usage or reopen eligibility. No refund API is invoked automatically. |

An operator must retain quote/job/attempt, Stripe event and provider evidence,
the failure reason, decision owner and timestamp for any reconciliation or
credit/refund. Idempotent settlement accepts an identical replay only; conflicting
or unknown settlements cannot be rewritten by application clients. Do not reset
`attempts`, delete ledger rows, fabricate zero usage or turn failed jobs into paid
success. Any owner-only data repair needs reviewed SQL and a separate transaction
and audit record. An orphan remains blocked until that repair is justified.

## Kill switch and recovery

Set the application flag false and `private.plan_reading_pilot_config.enabled`
false to close new admissions. Disable a workspace allowlist row to contain one
tenant. These controls do not cancel requests already dispatched to Gemini;
their holds remain included until reconciliation.

The [0018 recovery procedure](0018-isolated-schema-gate.md) contains transaction
rollback evidence and scripts that pause new reservations and human review
without dropping consent, labor or payment data. Allow usage settlement to drain
already-running requests. Resume restores only intended RPC grants and does not
enable the pilot. Never grant access to the private unbudgeted reservation
function, which is callable only by the guarded public wrapper's owner.

Local SQL tests validate the lock-based budget logic and real PostgreSQL
permissions in PGlite. They do not certify parallel hosted connections, Supabase
advisors, PostgREST/authentication, backup/PITR restore or runtime deadlines.
Those proofs belong to the isolated hosted gate before provider activation.

## Required TEST evidence and final map

The final evidence must bind repository, exact head SHA, reconciled main SHA,
[CI artifact](release-gate.md), preview deployment, isolated Supabase project and
migration hashes, post-migration advisors, backup/restore, Stripe TEST account and
signed webhook, dedicated Gemini project/model/rates/budget, smoke tests and
rollback owner. Do not put keys, webhook secrets or raw provider inputs in logs.

After the CI/schema/activation fronts and hosted safety checks pass, use a
synthetic PDF in the isolated workspace. Prove quote -> Stripe TEST checkout ->
signed webhook -> paid -> reservation -> real Gemini -> usage ledger -> persisted
findings -> human review. Capture identifiers and measured counts. Repeat with a
duplicate webhook, wrong amount/mode, changed PDF, provider failure and an eligible
explicit retry. Assert no duplicate charge/hold/findings and no synthetic output.
These real external checks remain pending; fake transport and SQL fixtures must
never be labelled a real Stripe/Gemini E2E.

Only then can a separate proposal identify the exact live canary SHA/environment,
one allowlisted KSP workspace, one low-value payment, explicit USD cap and tested
kill switch/rollback for the user's approval. A green compile gate alone leaves
the release decision at NO-GO.

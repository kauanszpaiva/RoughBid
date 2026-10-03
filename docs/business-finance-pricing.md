# RoughBid Business, Finance, and Pricing Plan

Status: controlled-sales operating policy, approved for technical activation on 2026-09-10. Legal copy remains an operational draft pending counsel review.

Active pricing versions:
- Project plan reading: `2026-09-05-v1` (conservative configured cost model; 50% target margin for non-members).
- Marketplace Supplier Price Import: `2026-09-10-marketplace-v1`, $49/month.

The paid Full implementation added on 2026-10-03 is a separate, explicitly configured `full_v2` purchase. Its policy below does not establish live activation, provider funding, observed inference cost, or a completed customer payment.

## Product Positioning

RoughBid is an independent construction estimating SaaS for small contractors, estimators, and owners who do not have technical blueprint experience.

The buyer is usually also the operator: the same person or company reads the plan, buys materials, manages labor, sends the proposal, and delivers the work. Estimates must therefore connect scope, material purchasing, labor assumptions, supplier pricing, overhead, markup, and client presentation in one simple flow.

Primary promise:
- Upload a construction plan.
- RoughBid explains the plan in plain language.
- RoughBid creates a usable estimate, takeoff, and client-facing proposal.
- The contractor can send the proposal, track opens, and collect signature without forcing the client to create an account.

The product should feel low-risk to try and inexpensive enough for a small contractor to say yes quickly, while every AI-heavy action is constrained by credits and cost limits.

## Commercial Principles

- Keep standalone project-reading gross margin at 50% after AI, storage, support overhead, and Stripe card fees.
- Membership discounts intentionally reduce project-reading margin to 40%, 35%, 30%, and enterprise as low as 20%.
- Charge per project, because contractors understand jobs better than tokens.
- Calculate the project-reading charge from its reviewed cost policy. Quick uses configured base/page/trade costs; Full uses a conservative processing upper bound for every page, configured overhead and payment fees, and the actual subscription tier.
- Charge before AI output. A user can preview the project-reading price, but Gemini must not receive the plan until Stripe confirms payment by webhook.
- Use subscriptions to discount future project-reading charges and increase retention.
- Sell local pricing/code datasets as paid marketplace add-ons, not as unlimited free usage.
- Never allow postpaid negative balance without owner approval.
- Do not price live project reads outside the margin guardrail in `packages/domain/src/project-charge.ts`.

## Project Reading Price Formula

The live implementation calculates the project-reading charge at request time:

`charge = ceil((policy_cost + fixed_payment_fee) / (1 - target_margin - payment_fee_percent))`

Target margins:

| Membership | Target margin on project read |
| --- | ---: |
| No membership | 50% |
| Starter | 40% |
| Pro | 35% |
| Team | 30% |
| Enterprise | 20% |

Quick cost inputs come from environment configuration and should include both paid attempts, Gemini usage, storage/read overhead, support reserve, and any fixed operational cost assigned to the read. Full follows the distinct one-run policy below. Missing inputs disable checkout. A configured cost allowance is not evidence of observed provider usage or realized profit.

Subscriptions reduce the margin RoughBid keeps on each future project read. The monthly subscription prices are not hard-coded yet; they must be approved and configured as Stripe price ids before `BILLING_MEMBERSHIPS_ENABLED=true`.

Marketplace add-ons:
- Supplier Price Import: $49/month and the only sellable initial SKU.
- New England Code Assistant, Regional Material Price Tables, and Local Labor Benchmarks remain unavailable until their datasets, sources, licensing, and update processes are verified.

## Paid Full Fixed-Price Policy

The customer reviews a fixed price for every physical page of one selected, saved PDF revision. Earlier revisions are separate purchases. This price uses a conservative processing allowance, not a forecast or pass-through invoice of actual AI consumption. Actual provider costs may be lower; no completed real inference or measured average cost is implied by the pricing formula.

The immutable `paid-full-v1` contract binds the file hash, page manifest, seven evidence stages, Gemini 3.8 Flash, the 2 by 2 regional policy, output limits, reviewed tariff, membership, fixed price and one durable execution. Its `one-durable-run-budget-wait-no-uncertain-replay` policy explicitly permits automatic continuation across rolling company-budget windows, without an additional customer charge. Four stages have one request per page; discipline, conflict detection and completeness have four region requests each. Thus the complete allowance is `16 × physical pages` calls, including informational or blank pages. Saved checkpoints can resume safely; uncertain provider requests do not gain another attempt or a new purchase budget. The changed scheduling policy changes the contract hash and requires fresh acceptance.

Three amounts must remain distinct:

| Amount | Meaning |
| --- | --- |
| `providerCostUpperBoundUsd` | Conservative tariff-based allowance, not observed or expected consumption. |
| `operatingReserveUsd` | Technical authorization capacity for all calls, including unknown telemetry. It is neither the customer price nor proof of provider funds. |
| `amountCents` | Fixed customer price accepted before Stripe Checkout; based on the policy cost, configured fees and target margin. |

For the currently reviewed standard Gemini tariff, the model-wide envelope uses 1,048,576 input tokens and 65,536 combined output/thinking tokens. At $0.75 and $3.75 per million respectively, the envelope is $1.032192, rounded conservatively to $1.04 per request. It does **not** claim that a one-page PDF consumes a million input tokens. The current payload also includes bounded prior evidence, instructions and a response schema; no unverified character-to-token conversion is used to price that context. Google's media-resolution guide gives model-dependent PDF token allocations, so the older generic 258-tokens/page statement is not used as a guaranteed request bound. Sources: [standard pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash), [output limit including thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens), [media resolution](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution#token-counts).

`policy_cost_cents = 104 × maximum_calls + configured_base_overhead_cents + pages × configured_page_overhead_cents`

`operating_reserve_usd = maximum_calls × max(company_call_reservation, reviewed_stage_call_reservations)`

The existing domain formula applies a target margin on revenue, not markup on cost: standard 50%, Starter 40%, Pro 35%, Team 30%, Enterprise 20%. Platform owners making a voluntary purchase use their actual subscription tier, without manufacturing an Enterprise subscription. Target margin is a policy calculation, not a guarantee of realized profit: actual fees, overhead, failures, refunds and model consumption must still be reconciled.

For a combined purchase of several PDFs, the order applies `projectChargeCents(sum(child.costCents), fixedFee, feeBps, membership)` once, with one common membership and reviewed fee policy. The fixed payment fee is not charged once per file. Allocate the resulting integer cents proportionally across files with deterministic largest remainders; allocations must sum exactly to the order total. The order receipt/hash binds these allocations and the original immutable file contracts. Its Stripe session and payment intent belong to the order; child execution authorization does not represent a separate charge at the child's earlier standalone quote amount. Admission checks the combined call allowance against the tariff window, and revoking the order fences every child, including any not yet enqueued.

Full requires explicit `PAID_FULL_PRICING_VERSION`, overhead inputs, payment fee inputs and paid execution ceilings; zero overhead is valid only when explicitly reviewed and configured. There are no invented production defaults. This tariff expires on 2027-01-01 UTC and must be reviewed before further dispatch at the changed tariff.

Before charging, Full verifies the workspace's AI consent, compatible live worker, immutable quote, actual live Stripe account and a company cap capable of admitting one call. Current usage may already fill that window: the accepted waiting policy permits even the first call to wait. Accepting the quote preserves the complete operating allowance as the purchase obligation under the company lock. That obligation does not consume every future call's rolling-window capacity immediately: actual call admission still reserves against the shared company limit atomically, including other providers and geometry. The signed paid Stripe event then reserves/enqueues the unique run; returning to the browser does not authorize payment or start work by itself. Queue failure preserves payment and the run identity for retry.

The company rolling-window limit, the whole-purchase authorization and provider prepaid balance are separate constraints. A Stripe receipt does not top up the AI provider or prove sufficient provider funds. With a $2.50 call reservation, one page carries $40 of complete-run technical allowance while each call is admitted separately against the $25 rolling-day ceiling. A run that exhausts current company capacity saves a durable waiting state and may wait longer than 24 hours before automatic continuation. It keeps the same purchase, full page/stage scope and total allowance. This is scheduling, not permission to raise a cap, manufacture provider funds or repeat an uncertain request.

Admission also checks the real company cap and window against the remaining reviewed-tariff validity. The minimum number of budget windows under the conservative reservation is `ceil(maximum_calls / floor(company_cap / reservation_per_call))`. Allow one additional initial window when current available capacity cannot cover a call (or is unknown), so the admission horizon is `now + (windows - 1 + initial_wait_window) × window_duration`. If that horizon reaches tariff expiry, reject the quote before payment rather than omit pages. This is an admission bound, not a promised completion date: other admitted work, provider failures and unavailable funding can delay completion further. Dispatch must stop if the reviewed tariff/profile expires after purchase, retain all checkpoints and show that processing review is required. No automatic extra charge, uncertain-call retry or refund is implied. Only completed contracted evidence can count as complete scope.

An uncertain Checkout creation can retain a hold without a saved session ID. Keep it until reconciled; clock expiry alone cannot prove that a delayed payment will not arrive. Result access and manual review remain distinct from permission to make another paid provider call.

## Unit Economics Snapshot

Target cost policy:
- Start with conservative measured costs from test reads.
- Include two paid attempts for a Quick quote; paid Full instead owns one durable run with no automatic uncertain-call replay.
- Recalculate before enabling live mode whenever Gemini pricing, file size limits, Stripe fees, or support reserve assumptions change.
- Stop checkout when the configured margin plus payment fee would make the denominator invalid.

## Payment Method Flow

Use Stripe-hosted Checkout for all payments.

Flow:
1. User creates account with Supabase magic link.
2. RoughBid creates or finds the workspace billing account.
3. User selects a project file, scope, and trades.
4. API creates a project-reading quote and Stripe Checkout Session.
5. Stripe collects card/payment method.
6. Stripe webhook is the source of truth.
7. Supabase marks the project-reading quote paid after webhook verification.
8. Gemini reads the plan only after the paid quote is reserved by the API.
9. User can manage membership payment method, invoice, cancellation, and plan changes in Stripe Customer Portal after membership prices are configured.

Do not mark a user paid based only on frontend redirect success. Only signed Stripe webhook events should grant credits or paid access.

## Paid Quote Rules

Every workspace has isolated project-reading quotes. Quotes are never shared across unrelated organizations.

Rules:
- Create the quote before AI output and before any model call.
- Reuse an existing paid or active checkout quote for the same file hash, scope, trades, amount, membership, and pricing version.
- Mark the quote paid only from the signed Stripe webhook.
- Reserve a job only after payment, role check, file hash check, and workspace AI consent.
- Allow at most two attempts per Quick quote; each paid Full quote owns exactly one durable run.
- Mark failed model output as failed; do not save simulated substitute quantities.
- Revoke quote access on refund or dispute webhook.
- Subscriptions discount future project reads instead of granting unlimited usage.
- Optional prepaid credit packs can be added later, but should be secondary.
- Marketplace add-ons do not include project usage.
- Every ledger write needs an idempotency key.

Implemented entities:
- `project_reading_quotes`
- `project_payment_events`
- `plan_reading_jobs`
- `plan_reading_findings`

Implemented entities for marketplace access and wider usage accounting:
- `api_usage_events`
- `marketplace_entitlements`
- `marketplace_purchases`

## Usage Limits By Plan

The attempt counts in this legacy Quick table do not grant extra executions to a paid Full quote.

| Plan | Monthly price | Project-read margin | Active projects | Seats | PDF limit | AI attempts/paid quote | Client proposal links/month | Included feeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Starter | TBD | 40% | TBD | TBD | 50 MB current paid-path hard cap | 2 | TBD | TBD |
| Pro | TBD | 35% | TBD | TBD | 50 MB current paid-path hard cap | 2 | TBD | TBD |
| Team | TBD | 30% | TBD | TBD | 50 MB current paid-path hard cap | 2 | TBD | TBD |
| Enterprise | custom | as low as 20% | custom | custom | custom after engineering review | custom contract | custom | custom |

Enterprise/custom can exist later, but should require manual approval because usage can destroy margins if unlimited.

## AI Provider Strategy

Use a routing model:
- Low-cost provider first for OCR cleanup, drawing classification, room/object detection, and simple takeoff extraction.
- Stronger expensive model only for verification, ambiguous plan sections, code reasoning, and final estimate review.
- Cache extracted plan structure by file hash.
- Reuse prior project context inside the same workspace, but never across unrelated workspaces.
- Track every provider request in `api_usage_events`.

Suggested provider categories:
- Cheap OCR/extraction: budget providers or self-hosted models where quality is acceptable.
- Strong review: premium multimodal model only after cheap extraction has produced structured evidence.
- Embeddings/search: low-cost embedding model for code, specs, and price-table retrieval.
- Background jobs: keep page rendering queued for viewer thumbnails; run paid AI reading inline after payment until the product needs a separate queue with the same paid quote guard.

Sensitive data rule:
- Do not send customer/client PII, addresses, or signatures to low-trust providers unless explicitly approved in the data processing policy.
- For plan images, strip unnecessary metadata and send only the cropped page/region required for the operation when possible.

## Marketplace Strategy

Marketplace is internal and paid separately.

Initial feeds:
- New England state code helper for CT, MA, ME, NH, RI, VT.
- Regional material price tables.
- Local labor benchmarks.
- Supplier/imported price sheets.

Feed behavior:
- User can preview feed coverage before paying.
- Paid entitlement unlocks feed in estimates and assemblies.
- Estimate output must identify when a price came from marketplace data versus user-entered data.
- Marketplace cost/royalty is included in margin calculations.

## Finance Controls

Every Gemini generation call must reserve against `provider_spend_policy` before dispatch. The initial company-wide rolling-24-hour ceiling is $25 with a conservative $2.50 reservation per call. Known measured cost replaces the reservation; failed or missing telemetry keeps the full reservation instead of becoming $0. This circuit breaker is independent of per-workspace job limits and quote attempts.

Weekly checks:
- Average COGS per completed project.
- Trial COGS per new user.
- Quote creation to paid conversion.
- Paid quotes, failed reads, completed reads, refunds, and disputes.
- Gross margin by plan.
- Gross margin by marketplace feed.
- Failed payment rate and churn.

Automatic blockers:
- Stop project AI when the quote is unpaid, expired, revoked, file-changed, or over attempt limits.
- Block below-margin pricing in code/tests.
- Require owner approval for free credit grants outside support adjustments.

## Approval Gates

Owner approval required before:
- Creating live Stripe prices.
- Publishing final public pricing copy.
- Allowing card-required trials.
- Enabling postpaid usage.
- Selling code/legal guidance as authoritative compliance advice.
- Sending plan/customer data to new third-party AI providers.
- Changing credit expiration/refund terms.

Legal review required before customer-facing terms describe:
- Construction code accuracy.
- Estimate reliability.
- Refunds or credit expiration.
- Marketplace data warranties.
- Client proposal signature validity.

# RoughBid Business, Finance, and Pricing Plan

Status: controlled-sales operating policy, approved for technical activation on 2026-09-10. Legal copy remains an operational draft pending counsel review.

Active pricing versions:
- Project plan reading: `2026-09-24-cost-plus-v2` (measured configured cost; charge = cost + 30%, then the membership factor: 2.00 without a membership, 1.85 Starter, 1.70 Pro, 1.60 Team). Bump `PROJECT_PRICING_VERSION` to this value when activating the rule, because an existing quote is reused only while its stored pricing version matches.
- Marketplace Supplier Price Import: `2026-09-10-marketplace-v1`, $49/month.

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

- Charge per project, because contractors understand jobs better than tokens.
- Price every project read as a cost-plus charge: the measured cost of serving that project, plus 30%, then the membership factor below.
- Keep the ladder in `packages/domain/src/project-charge.ts` and keep the per-membership floor guard: a factor that would undercut that membership's minimum margin disables checkout instead of pricing it.
- Calculate the measured cost from real drivers: base cost, PDF page count, selected trades, and the fixed card fee RoughBid pays Stripe per charge.
- Charge before AI output. A user can preview the project-reading price, but Gemini must not receive the plan until Stripe confirms payment by webhook.
- Use subscriptions to retain customers and to lower what they pay per project, never to make a project read free.
- Sell local pricing/code datasets as paid marketplace add-ons, not as unlimited free usage.
- Never allow postpaid negative balance without owner approval.
- Do not price live project reads outside the guardrail in `packages/domain/src/project-charge.ts`.

## Project Reading Price Formula

The live implementation calculates the project-reading charge at request time, per project:

```
measured_cost = base + (pages * per_page) + (trades * per_trade) + fixed_card_fee
charge        = ceil(measured_cost * 1.30 * membership_factor)
```

Membership factors and the margin each one implies:

| Membership | Plan price | Factor | Implied margin | Minimum-margin floor |
| --- | ---: | ---: | ---: | ---: |
| No membership | — | 2.00 | 50.0% | 50% |
| Starter | $9/month | 1.85 | 45.9% | 40% |
| Pro | $29/month | 1.70 | 41.2% | 35% |
| Team | $79/month | 1.60 | 37.5% | 30% |
| Enterprise (no SKU yet) | — | 1.60 | 37.5% | 20% |

The pricier the plan, the lower the per-project factor: the subscription pays part of each project's
work, and every tier still clears its own minimum-margin floor. Enterprise has no sellable SKU yet and
is mapped to the Team factor until its commercial terms are approved.

Worked example with configured costs of 100 base, 10 per page, 20 per trade and a 30 cent card fee:

| Pages | Trades | Measured cost | No membership | Starter | Pro | Team |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 200 cents | 520¢ ($5.20) | 481¢ ($4.81) | 442¢ ($4.42) | 416¢ ($4.16) |
| 20 | 3 | 390 cents | 1014¢ ($10.14) | 938¢ ($9.38) | 862¢ ($8.62) | 811¢ ($8.11) |
| 50 | 7 | 770 cents | 2002¢ ($20.02) | 1852¢ ($18.52) | 1702¢ ($17.02) | 1602¢ ($16.02) |

The charge is rounded up to the next cent, so a factor never rounds in the customer's favor. The
pricing engine also computes that membership's minimum-margin charge for the same cost and refuses
checkout if the factor would ever land below it.

Measured cost inputs come from environment configuration and should include both paid attempts, model
usage at the configured output ceiling, storage/read overhead, support reserve, and any fixed
operational cost assigned to the read. Missing inputs disable checkout.

Subscriptions reduce the margin RoughBid keeps on each future project read. The monthly subscription prices are not hard-coded yet; they must be approved and configured as Stripe price ids before `BILLING_MEMBERSHIPS_ENABLED=true`.

Marketplace add-ons:
- Supplier Price Import: $49/month and the only sellable initial SKU.
- New England Code Assistant, Regional Material Price Tables, and Local Labor Benchmarks remain unavailable until their datasets, sources, licensing, and update processes are verified.

## Unit Economics Snapshot

Target cost policy:
- Start with conservative measured costs from test reads.
- Include two paid attempts per quote, since the database allows one retry after provider failure.
- Include the full plan-reading output ceiling, because a truncated drawing reading is discarded rather than credited back.
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
- Allow at most two attempts per quote.
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

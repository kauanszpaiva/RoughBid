# RoughBid Billing, Credits, and Marketplace

Status: Supplier Price Import approved for controlled commercial activation; memberships and unverified data feeds remain disabled.

Primary commercial plan: see `docs/business-finance-pricing.md`.

## Current Implementation Snapshot

- Implemented as domain rules: trial credits, trial COGS caps, legacy project-size reference pricing, subscription project discounts, and 50%+ unit-margin guardrails live in `packages/domain/src/billing.ts`.
- Implemented as domain rules: plan limits, marketplace add-on catalog, estimated Stripe card fees, marketplace feed economics, and project-level margin checks.
- Implemented in API: dynamic per-project Checkout plus catalog-price subscription Checkout, raw-body signed webhooks, fresh Stripe subscription reads, idempotent workspace entitlement reconciliation, and refund/dispute revocation.
- Implemented in UI: a workspace Marketplace with server-verified Supplier Price Import entitlement, bounded CSV parsing, template download, and explicit unavailable states for unverified data feeds.
- Implemented in database: project payment ledger, Marketplace checkout claims/purchases/entitlements/price mappings, API usage ledger, and company-wide provider-spend reservations.
- Not enabled: Starter/Pro/Team memberships, credit packs, New England code data, regional material data, and labor benchmarks.

## Model

Use RoughBid internal project charges. Stripe sells subscriptions, per-project charges, and marketplace add-ons; RoughBid's ledger decides when a workspace can run AI, create client views, or consume paid price data.

## Trial Guardrail

- Free trial: 2 project credits.
- Hard trial API COGS cap: $0.80 per user, absolute stop before $1.00.
- Trial limits: 2 active projects, 25 MB PDF per project, 3 AI generations per project, no batch processing, no team seats.
- Require verified email before consuming AI budget.
- Start with low-cost model routing and escalate only after structured validation failure.

## Active Prices

Per-project plan reading uses the server-generated dynamic formula and pricing
version `2026-09-05-v1`; the legacy fixed size values in the domain package are
not the controlled-sales Checkout source of truth. The production example of a
10-page Framing quote is $12.74 against $5.70 of conservatively configured cost.

Starter, Pro, and Team subscriptions are disabled. Their historical reference
values are not approved customer prices and must not be advertised or mapped to
Stripe until the complete membership lifecycle is approved.

Marketplace add-ons:
- Supplier Price Import: $49/month, approved initial SKU (`2026-09-10-marketplace-v1`).
- The other three proposed feeds are not sellable until their data and licenses are verified.

Gross margin rule:
- Target max variable COGS per completed project: $0.75.
- If observed COGS exceeds $0.90/project, block cheaper overage until owner approval.
- Keep minimum gross margin at 50%+ after AI, storage, email, observability, and payment fee allocation.

## Plan Limits

| Plan | Project discount | Active projects | Seats | PDF limit | AI generations/project | Client proposal links/month |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Starter | 10% | 5 | 1 | 25 MB | 3 | 25 |
| Pro | 25% | 20 | 3 | 50 MB | 5 | 100 |
| Team | 40% | 80 | 10 | 75 MB | 8 | 400 |

## Minimum Database Entities

`billing_accounts`
- workspace, Stripe customer/subscription IDs, plan status, trial dates, trial budget/spend.

`credit_grants`
- source type, Stripe checkout/invoice IDs, project charge/reservation balance, expiration, status.

`credit_ledger_entries`
- atomic grant/reserve/capture/release/refund/adjustment entries with idempotency keys.

`project_entitlements`
- one row per project that tracks reserved/completed credit status, generation count, API budget/spend.

`api_usage_events`
- provider, model, operation, token counts, estimated/actual cost, request ID.

`marketplace_entitlements`
- workspace, feed ID, status, region coverage, subscription item ID, entitlement dates.

`marketplace_purchases`
- workspace, feed ID, Stripe checkout/invoice IDs, amount paid, data COGS/royalty estimate.

`stripe_price_mappings`
- internal plan/feed IDs mapped to Stripe price IDs per mode/environment.

## Accounting Rules

- Reserve the calculated project charge when AI estimation starts.
- Capture when the first useful estimate is saved.
- Release on provider failure, validation failure, or user cancellation before saved output.
- Do not release for repeated regeneration after successful first estimate; regeneration spends the project budget.
- Subscription included credits reset monthly and do not roll over by default.
- Purchased credits are consumed after subscription credits unless accounting/legal approves another rule.
- Ledger writes must be atomic and idempotent.

## Provider Cost Routing

- Use low-cost AI first for OCR cleanup, drawing classification, extraction, and draft takeoff.
- Use expensive models only for ambiguous plan regions, code reasoning, final review, or failed validation retries.
- Cache extracted plan structure by file hash.
- Track every AI and data-provider request in `api_usage_events`.
- Stop processing before project or trial cost caps are reached.

## Approval Gates

Owner approval required for:
- Exact Stripe product names and prices.
- Trial card requirement.
- Purchased-credit expiration and refund policy.
- Any postpaid/negative balance usage.
- Production Stripe resources and webhook activation.
- Provider/model routing when customer plan data may be sent to a third party.
- Customer-facing legal language around credits, estimates, code guidance, and construction pricing.

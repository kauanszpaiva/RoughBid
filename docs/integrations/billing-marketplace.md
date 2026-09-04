# RoughBid Billing, Credits, and Marketplace

Status: owner approval required before creating new Stripe prices.

## Current Implementation Snapshot

- Implemented as domain rules: trial credits, trial COGS caps, proposed plan catalog, subscription overage discounts, and 50%+ unit-margin guardrail live in `packages/domain/src/billing.ts`.
- Implemented in API: Stripe hosted subscription checkout supports one configured `STRIPE_PRICE_ID`; signed subscription webhooks mirror subscription status idempotently.
- Implemented in UI: Price Marketplace is an informational workspace screen with active/draft/licensed feed states.
- Not implemented yet: multi-plan checkout selection, project-credit packs, atomic credit ledger, per-project reservation/capture/release, API usage cost ledger, paid marketplace feed purchases, and Stripe price mapping by plan.

## Model

Use RoughBid internal project credits. Stripe sells plans and credit packs; RoughBid's ledger decides when a workspace can run AI, create client views, or consume paid price data.

## Trial Guardrail

- Free trial: 2 project credits.
- Hard trial API COGS cap: $0.80 per user, absolute stop before $1.00.
- Trial limits: 2 active projects, 25 MB PDF per project, 3 AI generations per project, no batch processing, no team seats.
- Require verified email before consuming AI budget.
- Start with low-cost model routing and escalate only after structured validation failure.

## Proposed Prices

Do not create these in production until approved.

One-time project credits:
- 1 project credit: $7.00.
- 5 project credits: $25.00.
- 20 project credits: $80.00.

Subscriptions:
- Starter: $19/month, includes 5 monthly project credits, extra projects $4.00.
- Pro: $49/month, includes 20 monthly project credits, extra projects $3.00.
- Team: $149/month, includes 80 monthly project credits, extra projects $2.50.

Gross margin rule:
- Target max variable COGS per completed project: $0.75.
- If observed COGS exceeds $0.90/project, block cheaper overage until owner approval.
- Keep minimum gross margin at 50%+ after AI, storage, email, observability, and payment fee allocation.

## Minimum Database Entities

`billing_accounts`
- workspace, Stripe customer/subscription IDs, plan status, trial dates, trial budget/spend.

`credit_grants`
- source type, Stripe checkout/invoice IDs, credits granted/remaining, expiration, status.

`credit_ledger_entries`
- atomic grant/reserve/capture/release/refund/adjustment entries with idempotency keys.

`project_entitlements`
- one row per project that tracks reserved/completed credit status, generation count, API budget/spend.

`api_usage_events`
- provider, model, operation, token counts, estimated/actual cost, request ID.

## Accounting Rules

- Reserve 1 credit when AI estimation starts.
- Capture when the first useful estimate is saved.
- Release on provider failure, validation failure, or user cancellation before saved output.
- Do not release for repeated regeneration after successful first estimate; regeneration spends the project budget.
- Subscription included credits reset monthly and do not roll over by default.
- Purchased credits are consumed after subscription credits unless accounting/legal approves another rule.
- Ledger writes must be atomic and idempotent.

## Approval Gates

Owner approval required for:
- Exact Stripe product names and prices.
- Trial card requirement.
- Purchased-credit expiration and refund policy.
- Any postpaid/negative balance usage.
- Production Stripe resources and webhook activation.
- Provider/model routing when customer plan data may be sent to a third party.
- Customer-facing legal language around credits, estimates, code guidance, and construction pricing.

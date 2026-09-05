# RoughBid Business, Finance, and Pricing Plan

Status: draft operating plan. Owner approval required before creating live Stripe prices or publishing customer-facing price copy.

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

- Keep minimum gross margin at 50% or higher after AI, storage, email, data feed, and Stripe card fees.
- Keep trial COGS below $1.00 per user, with a soft target of $0.80 or lower.
- Charge per project, because contractors understand jobs better than tokens.
- Calculate the project charge from project size and complexity.
- Use subscriptions to discount project charges and increase retention.
- Sell local pricing/code datasets as paid marketplace add-ons, not as unlimited free usage.
- Never allow postpaid negative balance without owner approval.
- Do not price live products below the guardrail in `packages/domain/src/billing.ts`.

## Recommended Price Ladder

Per-project charges are based on project size. This avoids charging a tiny bathroom refresh the same as a dense multi-trade renovation.

| Project size | Base project price | Target use case | Included AI budget |
| --- | ---: | --- | --- |
| Small | $7 | Small repair, bath refresh, single-room finish update | up to $0.75 COGS |
| Standard | $15 | Kitchen remodel, basement finish, small addition | up to $1.25 COGS |
| Large | $29 | Whole-home remodel, multi-room addition, larger deck/exterior package | up to $2.50 COGS |
| Complex | $49 | Light commercial, multi-trade renovation, dense plan set | up to $5.00 COGS |

Entry without subscription:
- User pays the base project price for each project.
- No monthly commitment.
- Good for a contractor trying RoughBid on one job.

Subscriptions:
- Starter: $9/month, 10% discount on every project.
- Pro: $29/month, 25% discount on every project.
- Team: $79/month, 40% discount on every project.

Marketplace add-ons:
- New England Code Assistant: $9/month.
- Regional Material Price Tables: $19/month.
- Local Labor Benchmarks: $29/month.
- Supplier Price Import: $49/month.

## Unit Economics Snapshot

Target COGS per completed AI project:
- Cheap model plan read and extraction: $0.45.
- Expensive model review/escalation reserve: $0.30.
- Total target project COGS: $0.75.
- Review cap: $0.90. If observed COGS exceeds this, cheaper overage must be blocked until review.

Approximate project margin after Stripe card fee:

| Size | No subscription | Starter price | Pro price | Team price | Lowest margin target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | $7.00 | $6.30 | $5.25 | $4.20 | 50%+ |
| Standard | $15.00 | $13.50 | $11.25 | $9.00 | 50%+ |
| Large | $29.00 | $26.10 | $21.75 | $17.40 | 50%+ |
| Complex | $49.00 | $44.10 | $36.75 | $29.40 | 50%+ |

The Team-discounted small project is the lowest acceptable floor under current assumptions. Do not lower it unless real COGS drops materially or payment economics change.

## Trial Policy

Trial should not require a card at first.

Trial limits:
- 14 days.
- 2 project credits.
- 2 active projects.
- 25 MB PDF limit per project.
- 3 AI generations per project.
- No batch processing.
- No team seats.
- Verified email required before AI spend.
- Hard stop before $1.00 in AI/provider cost per user.

Trial conversion:
- Show the per-project size price first.
- Show Starter as the lowest-friction monthly discount.
- Explain usage as "projects", not tokens.

## Payment Method Flow

Use Stripe-hosted Checkout for all payments.

Flow:
1. User creates account with Supabase magic link.
2. RoughBid creates or finds the workspace billing account.
3. User selects a project size, subscription, or marketplace add-on.
4. API creates Stripe Checkout Session.
5. Stripe collects card/payment method.
6. Stripe webhook is the source of truth.
7. Supabase ledger grants credits or add-on entitlement after webhook verification.
8. User can manage payment method, invoice, cancellation, and plan changes in Stripe Customer Portal.

Do not mark a user paid based only on frontend redirect success. Only signed Stripe webhook events should grant credits or paid access.

## Credit Ledger Rules

Every workspace has isolated credits. Credits are never shared across unrelated organizations.

Rules:
- Reserve the project charge when AI estimation starts.
- Capture the project charge when the first useful estimate is saved.
- Release the credit if provider failure, validation failure, or user cancellation happens before saved output.
- Regenerations after a useful saved estimate consume the same project budget until generation limit is reached.
- Subscriptions discount future project charges instead of granting unlimited usage.
- Optional prepaid credit packs can be added later, but should be secondary.
- Marketplace add-ons do not include project usage.
- Every ledger write needs an idempotency key.

Required database entities:
- `billing_accounts`
- `credit_grants`
- `credit_ledger_entries`
- `project_entitlements`
- `api_usage_events`
- `marketplace_entitlements`
- `marketplace_purchases`
- `stripe_price_mappings`

## Usage Limits By Plan

| Plan | Monthly price | Project discount | Active projects | Seats | PDF limit | AI generations/project | Client proposal links/month | Included feeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Starter | $9 | 10% | 5 | 1 | 25 MB | 3 | 25 | New England codes |
| Pro | $29 | 25% | 20 | 3 | 50 MB | 5 | 100 | Codes, material prices |
| Team | $79 | 40% | 80 | 10 | 75 MB | 8 | 400 | Codes, material prices, labor benchmarks |

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
- Background jobs: queue all plan processing, enforce per-project budget before each step.

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

Weekly checks:
- Average COGS per completed project.
- Trial COGS per new user.
- Conversion from trial to paid.
- Credits sold, reserved, captured, released, expired.
- Gross margin by plan.
- Gross margin by marketplace feed.
- Failed payment rate and churn.

Automatic blockers:
- Stop trial AI when user reaches hard COGS cap.
- Stop project AI when reserved project budget is exhausted.
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

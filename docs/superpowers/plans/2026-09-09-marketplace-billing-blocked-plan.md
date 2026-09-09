# RoughBid Regional Marketplace Billing — BLOCKED Gate

> **Status:** Intentionally non-executable.
> **Reason:** The approved Pricing Intelligence spec defines entitlement behavior but does not define exact Regional Price Book sale prices or authorize Stripe mutations.

## Approved commercial shape

Regional Price Books support both:

1. **Monthly Region Pass** — access + updates while active.
2. **One-Time Region Purchase** — permanent access to the purchased/retained book version + 12 months of updates; later updates require renewal.

Each workspace also receives:
- one free Regional Price Book
- one free region change during the first 30 days

Those rules are implemented/planned in the entitlement workstream independently from Stripe.

## What is not approved yet

No implementation agent may invent or infer any of these:
- monthly Region Pass price
- one-time Region Purchase price
- renewal price after the 12-month update window
- discounts/bundles for multiple regions
- refund/cancellation commercial policy beyond normal entitlement state mechanics
- Stripe Product names/IDs
- Stripe Price IDs
- live-vs-test activation timing

The older planning values in `docs/integrations/billing-marketplace.md` (`Regional Material Price Tables: $19/month`, `Local Labor Benchmarks: $29/month`) are historical proposals, not authorization for the new combined Regional Price Book product.

## Required decisions before a billing implementation plan can exist

Kauan must explicitly approve concrete values/policies for:

1. monthly price per region (or a deterministic tier table)
2. one-time purchase price per region (or deterministic tier table)
3. update-renewal price/policy after 12 months
4. whether prices are identical across regions or region-specific
5. whether taxes are Stripe Tax/manual/out of V1 scope
6. refund policy for monthly and one-time purchases

Only after those decisions are fixed should a new dated executable billing plan be written.

## Separate mutation approvals

Even after pricing is decided, execution must remain split:

### Phase A — code + Stripe TEST only

Requires explicit authorization for:
- adding Stripe mapping/config code
- creating TEST products/prices/checkouts if the environment/tool call mutates Stripe TEST state
- webhook handling tests
- entitlement reconciliation tests

### Phase B — production Stripe

Requires a fresh, exact production authorization naming:
- exact code SHA/PR
- exact Stripe products/prices to create or activate
- production webhook/config changes
- canary/smoke procedure
- rollback/disable procedure

Approval for PR #40, the Pricing Intelligence spec, or any non-billing workstream cannot be reused for this.

## Eventual billing architecture (fixed boundaries, not executable tasks)

When unblocked, the implementation should extend existing server billing boundaries rather than let the web client grant access.

Expected future objects:
- Stripe product/price mappings for `region_monthly` and `region_one_time`
- checkout metadata containing workspace + regional book identity
- signed webhook reconciliation into `workspace_regional_entitlements`
- idempotent purchase/subscription event ledger
- cancellation/expiry mapping
- one-time `update_access_until = purchased_at + 12 months`
- retained entitled version snapshot

Security rules:
- checkout creation revalidates admin role + workspace
- client metadata is not trusted in webhook reconciliation without server mapping
- webhook event IDs are idempotent
- a paid entitlement is never granted from a successful browser redirect alone
- Stripe failure never deactivates the free region
- canceled monthly access never destroys historical estimate snapshots

## TEST acceptance cases required once unblocked

A future executable plan must prove at least:

1. admin can create checkout; estimator/viewer cannot
2. monthly TEST checkout activates correct workspace/book only after signed webhook
3. one-time TEST checkout creates permanent book access and exactly 12 months of update entitlement
4. duplicate webhook cannot duplicate entitlement/purchase
5. tampered workspace/book metadata cannot grant cross-tenant access
6. monthly cancellation stops future current-book use according to approved policy
7. one-time post-12-month access retains last entitled version
8. failed/expired checkout grants nothing
9. existing free region remains intact
10. historical estimate keeps exact source version after subscription cancellation

Until the commercial decisions and mutation approvals above exist, **do not create Stripe products, prices, checkout routes, or production billing resources for Regional Price Books.**

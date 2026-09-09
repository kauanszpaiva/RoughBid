# RoughBid Pricing Intelligence Implementation Roadmap

> **Spec:** `docs/superpowers/specs/2026-09-09-pricing-intelligence-design.md`
> **Status:** Approved design; implementation plans prepared; no production mutation authorized by this document.
> **Base:** `b81370e67d7ed88d9efd24e17ff417ff3be3ee23`

## Goal

Deliver Pricing Intelligence without turning one risky feature into a mega-PR. Each workstream is independently testable and mergeable. Production database, Stripe, provider-spend, and Paid GA changes remain separately gated.

## Non-negotiable architecture boundaries

1. Keep plan extraction separate from pricing. `apps/api/src/ai-plan/gemini.ts` must continue to reject invented money/labor pricing; it may extract address and evidenced site-condition facts only.
2. The browser-local `StorageService` price book is not authoritative for Pricing Intelligence. Durable pricing data is workspace-scoped in Supabase.
3. Retire the hard-coded fallback rates in `apps/api/src/ai-plan/pricing.ts` before enabling the new pricing flow. The approved design is fail-closed; fabricated/default unit rates cannot silently become customer estimates.
4. Historical accepted pricing is snapshot-based. Regional-book updates and live research refreshes create new observations/suggestions; they do not rewrite prior accepted estimates.
5. All pricing/entitlement decisions execute server-side with workspace checks. The UI may display state but cannot grant a region or select a proprietary price source by itself.
6. Client proposals never expose contractor cost, raw internal material/labor economics, markup, margin, confidence, source URLs, or proprietary Regional Book data.
7. Do not use a blanket migration command in production. Repo migrations `0023`-`0025` are intentionally not part of this feature and must not be swept into production accidentally. Any future production migration step must name the exact Pricing Intelligence migration and requires an explicit production approval.
8. Marketplace Stripe integration is blocked until exact Regional Price Book prices and a separate production billing authorization exist.

## Workstreams and order

### 01 — Pricing context + plan-derived address

Plan: `2026-09-09-pricing-context-plan.md`

Delivers:
- structured plan-address evidence
- durable project pricing context
- plan/project conflict detection
- `Use plan address` / `Keep project address`
- hard blocker preventing pricing while address is unresolved

Dependency: none beyond current plan-reading/project APIs.

### 02 — Company Price Book + Job Conditions

Plan: `2026-09-09-company-price-book-job-conditions-plan.md`

Delivers:
- durable free Company Price Book
- contractor-confirmed price precedence
- server-side material/labor/equipment/other records
- Job Conditions Check and confirmation state
- structured explicit cost-condition inputs (trash, disposal, pickup, floor carry, access, etc.)

Dependency: Workstream 01 project pricing context.

### 03 — Official Regional Price Books + workspace entitlements

Plan: `2026-09-09-regional-price-books-entitlements-plan.md`

Delivers:
- official RoughBid Regional Price Book catalog/versioning
- one free region per workspace
- one free change during first 30 days
- monthly and one-time entitlement domain states without Stripe checkout
- one-time purchase update window = 12 months
- authorized read path for proprietary regional data

Dependency: Workstream 02 pricing item vocabulary. No Stripe dependency.

### 04 — Live research + Pricing Recommendation Engine

Plan: `2026-09-09-live-research-pricing-engine-plan.md`

Delivers:
- provider-neutral price research contract
- grounded web research adapter with source URLs/provenance
- 30-day live-material freshness
- source hierarchy: Company -> Regional -> Live -> broader benchmark -> Needs Review
- fail-closed confidence rules
- Contractor Cost / Company Price / AI Recommended Client Price
- explicit operational-cost lines
- full estimate pricing + per-line repricing + affected-line refresh domain APIs

Dependency: Workstreams 01-03.

### 05 — Estimate review UI + client proposal privacy

Plan: `2026-09-09-estimate-review-client-proposal-plan.md`

Delivers:
- `Price Estimate with AI`
- `AI Suggested / Needs Review`
- Accept / Edit / Reject / Reprice
- source/freshness/confidence presentation for internal users
- selective stale/refresh UI
- client-safe proposal projection and regression tests

Dependency: Workstream 04 APIs.

### 06 — Marketplace billing integration (BLOCKED)

Gate document: `2026-09-09-marketplace-billing-blocked-plan.md`

Blocked on:
- exact monthly Region Pass price(s)
- exact one-time Region Purchase price(s)
- renewal/update price policy after 12 months
- explicit Stripe TEST authorization, followed separately by explicit production authorization

No Stripe product/price/resource creation is authorized by the approved Pricing Intelligence spec alone.

## Branch / PR strategy

Use a separate implementation branch or worktree per workstream. Suggested names:

- `feat/pricing-context`
- `feat/company-price-book-job-conditions`
- `feat/regional-price-books`
- `feat/pricing-research-engine`
- `feat/pricing-review-proposal`

Do not stack all workstreams into one branch. Each PR must rebase/merge from the previous accepted workstream before implementation begins.

## Release gates per workstream

Every PR must satisfy:

1. RED test written first for each new rule.
2. Focused test passes after implementation.
3. `npm run test:domain`
4. `npm run test:api`
5. `npm run test:web` when UI is touched.
6. `npm run db:validate` when migrations are touched.
7. `npm run build:app` for web-impacting changes.
8. `npm run build` before a release candidate.
9. Security review of workspace/RLS/role checks for new tables/routes.
10. No production database or Stripe action without a fresh exact-scope approval.

## Migration numbering and production safety

Planned repository migration files:

- `0035_pricing_context.sql`
- `0036_company_price_book_job_conditions.sql`
- `0037_regional_price_books_entitlements.sql`
- `0038_pricing_observations_suggestions.sql`
- billing migration number reserved only after Workstream 06 is unblocked

Migration numbers describe repository order only. They are **not** permission to run every pending migration in production. Before any production DB change, enumerate live migration history and explicitly verify that applying the selected Pricing Intelligence migration will not implicitly execute `0023`-`0025` or any unrelated pending migration.

## Definition of done for the complete feature

The feature is complete only when all of the following are true:

- plan-derived address has evidence and conflict handling
- one unresolved address prevents live/local pricing research
- manual Company prices persist server-side and win source selection
- Job Conditions include explicit logistics/disposal/access costs
- Regional Book access is workspace-authorized and versioned
- free-region + 30-day swap rule is atomic
- monthly vs one-time entitlement semantics are tested
- live research retains source URL/date/region/unit/confidence
- live material research older than 30 days is stale
- low-confidence values never auto-apply
- accepted suggestions preserve provenance/snapshot
- Contractor Cost, Company Price, and AI Recommended Client Price remain distinct
- existing company margin policy is never silently reduced
- internal UI explains suggestions and permits review
- client proposal exposes only customer-safe scope + sale price
- no legacy hard-coded default rate can silently price an estimate
- billing remains disabled until separately approved

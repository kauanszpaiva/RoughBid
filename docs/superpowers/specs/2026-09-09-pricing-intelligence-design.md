# RoughBid Pricing Intelligence Design

Date: 2026-09-09
Status: Approved design, implementation not started
Scope: AI-assisted construction pricing, regional price books, job-condition costs, client-price recommendations

## 1. Product goal

RoughBid should move from plan takeoff assistance into a pricing workflow that can estimate both:

1. **Contractor Cost** — the probable internal cost to perform the work.
2. **Recommended Client Price** — the amount RoughBid recommends the contractor charge the customer.

The system must remain transparent, reviewable, location-aware, fail closed when evidence is weak, and preserve the contractor's own confirmed prices as the highest-priority source.

## 2. Core principles

- The plan reader and the pricing engine remain separate responsibilities.
- The plan reader extracts project facts and quantities from uploaded drawings; it does not invent prices or labor hours.
- Pricing uses explicit sources, provenance, timestamps, region, freshness, and confidence.
- AI-suggested pricing can prefill an estimate but is always marked `AI Suggested` and `Needs Review` until accepted.
- Low-confidence pricing is never silently applied.
- A contractor-confirmed company price is never silently overwritten by AI.
- Job-condition costs must be represented as visible estimate lines rather than hidden inside a generic margin whenever practical.
- Client-facing proposals hide contractor cost, cost breakdown, markup, margins, pricing source internals, and AI confidence.

## 3. Address extraction and pricing region

### 3.1 Address extraction from drawings

The plan-intelligence pipeline must attempt to extract the project address from the drawings, especially from cover sheets, title blocks, permit information, and project-information sections.

Expected extracted fields:

- project name
- street address
- city
- state
- ZIP code
- building / lot / unit when present
- physical PDF page number
- verbatim source excerpt
- confidence score

An unreadable or missing address must never be fabricated.

### 3.2 Address precedence and conflict handling

RoughBid compares the plan-derived address with the address stored on the project.

If they agree, the normalized address becomes the pricing location.

If they differ materially, RoughBid must block pricing research and show an explicit conflict resolution UI:

- `Use plan address`
- `Keep project address`

No external pricing research should run until the conflict is resolved.

### 3.3 Region fallback chain

Pricing research should start with the project ZIP and expand only when data is insufficient:

`ZIP -> city -> metro/region -> state -> broader region -> national benchmark`

The pricing result must record which geographic level was actually used.

## 4. Pricing source hierarchy

The source precedence is fixed as follows:

1. **Company Price Book — contractor-confirmed prices**
2. **Unlocked RoughBid Regional Price Book**
3. **AI Live Research**
4. **Broader benchmark fallback**

### 4.1 Company Price Book

The contractor may add and maintain manual pricing at no additional charge.

Supported data includes:

- materials
- labor
- equipment
- assemblies
- supplier information
- company-specific operational costs

Confirmed company prices have highest priority.

If live or regional research indicates a meaningful discrepancy, RoughBid may warn that the company price appears stale or outside current market ranges, but it must not replace the price automatically.

### 4.2 RoughBid Regional Price Books

Regional Price Books are official RoughBid-curated products in V1. Third-party sellers are not supported in V1.

A regional book may contain:

- material benchmarks
- labor benchmarks
- equipment benchmarks
- delivery / pickup assumptions
- disposal and dump-fee benchmarks
- regional adjustment factors
- version and effective date
- source lineage and refresh metadata

Every workspace receives one Regional Price Book for free.

Rules for the free region:

- one free region per workspace/company
- one free region change during the first 30 days
- after that, another region requires purchase or subscription

Regional entitlements belong to the workspace, not to an individual user.

Owner/Admin controls:

- choosing the free region
- changing the free region within the allowed window
- buying regions
- starting or canceling subscriptions
- renewing update access
- viewing billing history

Authorized employees/estimators may use unlocked regions but cannot change billing.

### 4.3 Paid regional access models

RoughBid supports both:

**Monthly Region Pass**
- active access while subscribed
- ongoing updates while active

**One-Time Region Purchase**
- permanent access to the purchased regional book
- includes 12 months of updates from purchase date
- after 12 months, the workspace keeps the latest version it received
- future updates require a renewal/upgrade

Historical estimates must retain the exact regional-book version used even if entitlement later expires.

### 4.4 AI Live Research

Live research is used to fill gaps, validate regional-book values, or price items that lack a sufficiently current trusted internal value.

Material live-research results have a default freshness window of 30 days.

After 30 days they are `STALE` and must not be represented as current without refresh.

Every live-research result must retain at least:

- source name
- source URL or canonical source identifier
- observed price/range
- unit
- observed date
- region/geographic scope
- freshness status
- confidence

## 5. Pricing engine outputs

For each priced estimate line, RoughBid should distinguish internal cost from client price.

### 5.1 Contractor Cost

Contractor Cost can include:

- material
- labor
- equipment
- delivery
- material pickup
- freight
- waste allowance
- mobilization
- floor/stair carry
- elevator restrictions
- parking/logistics
- floor/property protection
- occupied-property inefficiency
- dumpster
- debris handling
- trash removal
- dump/disposal fees
- cleanup
- travel
- lift/scaffold
- permits/inspection allowances when applicable and evidenced/confirmed
- other explicit job-condition costs

Where practical, operational costs should appear as visible estimate lines rather than being hidden inside labor or markup.

### 5.2 Company Price

The Company Price is calculated using the contractor's configured financial policy, including project/company overhead and markup.

This remains the deterministic baseline generated from the contractor's own rates.

### 5.3 AI Recommended Client Price

The AI Recommended Client Price may recommend a higher amount than the Company Price when supported by local market evidence, risk, complexity, or site conditions.

The system must explain the adjustment.

AI must never silently reduce the contractor's configured minimum margin or pricing policy.

The UI should make the distinction clear:

- Contractor Cost
- Company Price
- AI Recommended Client Price

## 6. Job Conditions Check

A dedicated **Job Conditions Check** runs before final pricing.

It combines:

- facts extracted from drawings
- project metadata
- address/location context
- contractor confirmation for facts that cannot be safely inferred

The system should consider at minimum:

- floor count / stairs
- usable elevator availability
- material carry distance
- difficult access
- parking limitations or paid parking
- material pickup versus delivery
- delivery restrictions
- occupied property
- floor/furniture protection
- restricted work hours
- long carry distance
- dumpster availability
- manual debris carry-out
- disposal/dump fees
- final cleanup
- lift/scaffold needs
- travel/mobilization
- permit/inspection needs when relevant

AI may prefill a condition only when supported by evidence.

Unknown conditions are marked `Needs confirmation`.

Confirmed conditions create or adjust explicit estimate lines.

## 7. User workflow

Recommended end-to-end flow:

1. Upload construction drawings.
2. AI plan reader extracts quantities, drawing disciplines, project address, and evidentiary facts.
3. Resolve any plan/project address conflict.
4. Review takeoff.
5. Run Job Conditions Check.
6. Contractor confirms unknown site conditions.
7. User selects `Price Estimate with AI`.
8. Pricing engine resolves each line against the pricing hierarchy.
9. AI fills sufficiently confident suggestions into the estimate as `AI Suggested / Needs Review`.
10. Contractor accepts, edits, or rejects suggestions.
11. Financial engine calculates Contractor Cost, Company Price, and AI Recommended Client Price.
12. Contractor finalizes client-facing proposal.

Pricing research must not rerun automatically on every small estimate edit.

Supported explicit actions:

- `Price Estimate with AI` — full pricing pass
- `Reprice` — one selected line
- `Refresh affected prices` — when address, region, quantities, or job conditions materially change

Confirmed manual/company pricing remains protected from silent replacement.

## 8. Confidence and fail-closed behavior

Pricing confidence should be based on factors such as:

- source authority
- recency
- geographic relevance
- unit match
- exact item/spec match
- agreement across multiple sources
- regional-book quality/version
- contractor historical confirmation when available

If confidence is too low:

- no price is automatically applied
- the estimate line remains incomplete or needs review
- RoughBid may show a benchmark range for context
- user can manually enter a value, research again, or explicitly choose a benchmark

Fallback order remains:

`Company -> Regional Book -> Live Research -> Broader Benchmark -> Needs Review`

No fabricated price is permitted merely to complete an estimate.

## 9. Estimate UI

Each AI-priced line should be able to show:

- quantity + unit
- material cost
- labor cost
- equipment/other cost
- explicit operational-cost lines when applicable
- total contractor cost
- source label: `COMPANY`, `ROUGH BID REGION`, `LIVE RESEARCH`, or `BLENDED`
- source region
- freshness/date
- confidence
- `AI Suggested`
- `Needs Review`
- actions: `Accept`, `Edit`, `Reject`, `Reprice`

Useful comparison UI when multiple sources exist:

- Company price
- RoughBid Regional Book value
- Live research value/range
- warning when the company value materially diverges from recent market evidence

## 10. Client proposal boundary

Client-facing proposals must not expose internal economics.

Do not show the client:

- contractor cost
- raw material cost
- raw labor cost
- internal equipment cost
- overhead percentage
- markup percentage
- margin
- AI confidence
- source URLs
- regional-book proprietary values
- internal research details

The proposal may show a consolidated scope and client-facing price, for example:

`Tile Installation — $12,600`

with a plain-language scope such as:

`Includes materials, installation labor, material handling, debris removal, disposal, and final cleanup.`

Internal estimate = full transparency.
Client proposal = scope + sale price.

## 11. Data model boundaries

Implementation should introduce durable records rather than storing pricing provenance only in browser-local state.

Likely domain entities:

### Project pricing context
- normalized pricing address
- address source (`plan`, `project`, `confirmed_override`)
- plan-address evidence
- resolved pricing region
- address-conflict status

### Job conditions
- condition type
- value/status
- source (`plan`, `project`, `user`, `AI`)
- confidence
- evidence
- confirmed_by / confirmed_at

### Price sources
- source type (`company`, `regional_book`, `live_research`, `benchmark`)
- source identity
- URL/reference
- region
- effective/observed date
- freshness
- confidence

### Price observations
- item/spec identity
- unit
- material/labor/equipment/other classification
- observed value or range
- source record
- normalized value

### Pricing suggestions
- estimate line
- suggested material/labor/equipment/other values
- contractor-cost result
- company-price result
- AI-recommended-client-price result
- adjustment explanations
- confidence
- status (`suggested`, `accepted`, `edited`, `rejected`, `stale`)
- accepted/edited provenance

### Regional price-book catalog
- region
- version
- effective date
- update metadata
- official RoughBid status

### Workspace regional entitlements
- workspace
- region/book
- entitlement type (`free`, `monthly`, `one_time`)
- entitlement status
- purchase/subscription timestamps
- update-entitlement end date
- retained book version after updates expire
- free-region selection/change metadata

## 12. Security and trust boundaries

- Pricing research and entitlement decisions must execute server-side.
- Client-provided region/book IDs are never trusted without workspace entitlement validation.
- Pricing source provenance must be immutable enough to reconstruct how a historical estimate was priced.
- Existing estimates must not silently change when a Regional Price Book is updated.
- A refresh creates a new pricing snapshot/suggestion; it does not rewrite prior accepted historical evidence invisibly.
- Regional-book content is workspace-authorized proprietary data and must not be exposed through public/client proposal surfaces.
- Role checks must enforce Owner/Admin billing actions separately from estimator usage rights.

## 13. Billing design boundary

This design defines the entitlement model but does not authorize production Stripe changes by itself.

Required paid flows eventually include:

- monthly region subscription
- one-time region purchase
- 12-month update entitlement for one-time purchases
- free-region entitlement at workspace creation
- one free change in first 30 days
- cancellation/expiry behavior
- historical estimate access after entitlement changes

Exact prices for Regional Price Books are a separate business/pricing decision and are not defined in this design.

## 14. Research-provider architecture

The pricing domain should depend on a narrow provider interface rather than coupling business logic to a single web-search/AI vendor.

Conceptual provider responsibilities:

- receive normalized pricing query + location + unit/spec
- return structured observations with source provenance
- never write directly into the estimate

The pricing engine is responsible for:

- source prioritization
- freshness
- confidence
- normalization
- blending/range decisions
- fail-closed behavior
- persistence
- recommendation generation

This allows live research providers to change later without rewriting estimate logic.

## 15. Testing requirements

Implementation must include tests for at least:

1. Plan-derived address is persisted with page/source evidence.
2. Conflicting project/plan address blocks pricing until resolved.
3. Confirmed Company Price Book values win over AI/regional/live values.
4. AI warns about stale/outlier company values without overwriting them.
5. Locked Regional Price Books cannot be queried by an unauthorized workspace.
6. One free region is enforced per workspace.
7. One free region change is allowed only during the first 30 days.
8. Monthly and one-time entitlements behave differently as designed.
9. One-time purchase retains the last received version after the 12-month update period ends.
10. Live material observations older than 30 days become stale.
11. Low-confidence pricing is not auto-applied.
12. Job conditions produce explicit estimate cost lines.
13. Pricing suggestions are marked AI Suggested / Needs Review.
14. Accepted company pricing is never silently replaced during refresh.
15. Client proposal output excludes contractor cost, markup, margin, confidence, and proprietary source detail.
16. Historical estimates retain the exact pricing snapshot/version originally accepted.
17. Changing address/quantity/job conditions marks only affected pricing as stale and enables selective refresh.
18. Full-pricing and per-line repricing do not create duplicate charges or duplicate accepted lines.

## 16. Recommended implementation decomposition

This feature is too broad for a single implementation PR. Implementation should be split into independent, reviewable stages:

1. **Plan address extraction + address conflict resolution**
2. **Durable pricing-domain schema + provenance model**
3. **Company Price Book server persistence and confirmed-price precedence**
4. **Job Conditions Check**
5. **Regional Price Book catalog + free entitlement rules**
6. **Regional paid entitlement model**
7. **Live research provider abstraction + freshness/confidence**
8. **Pricing recommendation engine (Contractor Cost / Company Price / AI Recommended Price)**
9. **Estimate review UI and selective repricing**
10. **Client proposal privacy boundary**
11. **Paid marketplace billing integration after separate production approval and pricing decision**

Each stage should be independently testable and should avoid production billing changes until the billing stage is explicitly authorized.

## 17. Explicit non-goals for V1

- user-created marketplace listings
- third-party sellers/payouts
- lifetime updates for one-time regional purchases
- silent automatic replacement of contractor-confirmed pricing
- uncontrolled research on every keystroke/edit
- exposing internal price-book data to clients
- auto-applying low-confidence prices
- allowing AI to fabricate missing address, price, labor hours, or site conditions

## 18. Definition of done for the complete feature

The full feature is complete when a contractor can:

1. upload plans and have RoughBid extract/confirm the project address;
2. resolve address conflicts safely;
3. complete takeoff and job-condition confirmation;
4. run one explicit AI pricing pass;
5. receive local material, labor, equipment, and operational-cost suggestions with provenance;
6. see Contractor Cost, Company Price, and AI Recommended Client Price separately;
7. accept/edit/reject suggestions without losing provenance;
8. use one free official Regional Price Book and purchase/subscribe to others;
9. keep manual company pricing free and highest priority;
10. generate a client proposal that exposes only scope and sale price, not internal economics.

# RoughBid Estimate Pricing Review + Client Proposal Privacy Implementation Plan

> **Goal:** Turn Pricing Intelligence results into a safe estimator workflow and guarantee that client-facing proposal surfaces never leak internal economics.
> **Depends on:** Workstream 04 pricing APIs and persisted suggestions.
> **Production release:** NOT authorized by this plan.

## Architecture

Internal estimator UI may show full cost/source/confidence data. Public/client proposal APIs must use a **separate safe DTO** that cannot contain raw internal estimate fields by type or serializer design.

Suggestion acceptance is server-recorded for provenance. The existing project `app_state` remains a convenient UI cache, but accepted pricing state is rehydratable from server suggestion records, so a browser/local save delay cannot destroy provenance.

## Task 1 — RED: web pricing types and internal presentation model

**Files**
- Modify: `apps/web/app/src/services/api.ts`
- Modify: `apps/web/app/src/types/index.ts`
- Add: `apps/web/app/src/utils/pricingPresentation.ts`
- Add: `apps/web/test/pricing-presentation.test.ts`

### Step 1: write failing tests

Add types for:

```ts
export type PricingSuggestionStatus = 'suggested' | 'manual_review_only' | 'accepted' | 'edited' | 'rejected' | 'stale';

export type PricingSuggestion = {
  id: string;
  runLineId: string;
  lineKey: string;
  status: PricingSuggestionStatus;
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
  otherCost: number;
  contractorCost: number;
  companyPrice: number;
  recommendedClientPrice: number;
  confidence: number;
  sourceSummary: PricingSourceSummary;
  explanations: string[];
};
```

Extend `EstimateItem` only with optional UI-cache metadata, not authoritative entitlement logic:

```ts
pricingSuggestionId?: string;
pricingStatus?: PricingSuggestionStatus;
pricingSource?: 'COMPANY' | 'ROUGH BID REGION' | 'LIVE RESEARCH' | 'BLENDED';
pricingConfidence?: number;
recommendedClientPrice?: number;
pricingObservedAt?: string;
```

Presentation tests:
- `0.85` -> sufficient-confidence suggestion label, still `Needs Review`
- `0.70` -> `Manual review only`; no auto-fill instruction
- stale -> `Refresh affected prices`
- company source renders `COMPANY`
- regional source renders book/version label without proprietary underlying rows

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-presentation.test.ts
```

### Step 3: implement pure presentation helpers

Do not compute source entitlement, cost, or recommendation client-side; format server values only.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/web/test/pricing-presentation.test.ts
```

### Step 5: commit

```bash
git add apps/web/app/src/services/api.ts apps/web/app/src/types/index.ts apps/web/app/src/utils/pricingPresentation.ts apps/web/test/pricing-presentation.test.ts
git commit -m "feat: add pricing suggestion presentation model"
```

## Task 2 — suggestion Accept / Edit / Reject provenance API

**Files**
- Modify: `apps/api/src/pricing/service.ts`
- Modify: `apps/api/src/pricing/routes.ts`
- Add: `apps/api/test/pricing-suggestion-actions.test.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED tests

Endpoint:

```text
PATCH /api/pricing-suggestions/:suggestionId
```

Actions:

```json
{ "action": "accept" }
```

```json
{
  "action": "edit",
  "values": {
    "materialCost": 3150,
    "laborCost": 4620,
    "equipmentCost": 0,
    "otherCost": 625,
    "recommendedClientPrice": 12600
  }
}
```

```json
{ "action": "reject" }
```

Tests:
- viewer -> 403
- wrong workspace -> no data leak
- stale suggestion cannot be accepted without reprice/explicit edit
- `manual_review_only` cannot be one-click accepted; explicit edit is required
- accept stamps `accepted_by/accepted_at`
- edit stamps `edited_by/edited_at` and retains original source summary for audit
- reject retains suggestion/evidence, marks status rejected
- repeated accept/reject is idempotent or returns stable conflict, never duplicates a snapshot

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-suggestion-actions.test.ts
```

### Step 3: implement service methods

```ts
acceptSuggestion(id: string): Promise<PricingSuggestion>;
editSuggestion(id: string, values: HumanEditedPricing): Promise<PricingSuggestion>;
rejectSuggestion(id: string): Promise<PricingSuggestion>;
```

Edits are explicit human overrides; do not relabel them as AI confidence.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-suggestion-actions.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/pricing/service.ts apps/api/src/pricing/routes.ts apps/api/test/pricing-suggestion-actions.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: add pricing suggestion review actions"
```

## Task 3 — internal pricing review components

**Files**
- Add: `apps/web/app/src/components/PricingRunPanel.tsx`
- Add: `apps/web/app/src/components/PricingSuggestionRow.tsx`
- Add: `apps/web/app/src/components/PricingSummaryCard.tsx`
- Add: `apps/web/test/pricing-run-panel.test.ts`

### Step 1: RED component tests

Required internal row rendering:

```text
Tile Installation — 420 SF
Material             $3,150
Labor                 $4,620
Material pickup         $275
3rd-floor carry         $420
Trash/disposal           ...
Contractor Cost        $...
Company Price          $...
AI Recommended         $...
Source     LIVE RESEARCH / ROUGH BID REGION / COMPANY / BLENDED
Confidence  ...
AI Suggested · Needs Review
[Accept] [Edit] [Reject] [Reprice]
```

Tests must prove:
- internal contractor cost visible to authorized estimator
- operational lines are not hidden inside markup
- source/date/confidence visible internally
- low-confidence suggestion has no Accept shortcut
- stale suggestion displays refresh action
- accepted company-confirmed value is visually protected from silent AI replacement

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-run-panel.test.ts
```

### Step 3: implement focused components

Keep network orchestration out of row component. `PricingRunPanel` owns async actions and passes data/actions to rows.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/web/test/pricing-run-panel.test.ts
```

### Step 5: commit

```bash
git add apps/web/app/src/components/PricingRunPanel.tsx apps/web/app/src/components/PricingSuggestionRow.tsx apps/web/app/src/components/PricingSummaryCard.tsx apps/web/test/pricing-run-panel.test.ts
git commit -m "feat: add internal pricing review components"
```

## Task 4 — `Price Estimate with AI` orchestration without hidden fanout

**Files**
- Modify: `apps/web/app/src/pages/EstimatePage.tsx`
- Modify: `apps/web/app/src/App.tsx` only as needed to pass workspace/project save state
- Add: `apps/web/app/src/hooks/usePricingRun.ts`
- Add: `apps/web/test/pricing-run-workflow.test.ts`

### Step 1: RED workflow tests

Required behavior:
1. unresolved address -> button disabled/blocked with address-resolution explanation
2. Job Conditions unresolved -> show warning/checklist before pricing; user may not silently skip a required unresolved condition
3. click `Price Estimate with AI` -> one `createPricingRun` call
4. lines already resolved by Company/Regional data show immediately
5. live-research-required lines are advanced with bounded explicit line calls and progress UI
6. no request happens from ordinary quantity input keystrokes
7. browser/page reload can reload the persisted run and continue remaining lines
8. double click does not duplicate run/provider requests

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-run-workflow.test.ts
```

### Step 3: implement `usePricingRun`

Hook responsibilities:
- create/reload run
- maintain progress state
- advance `research_required` lines sequentially (or at a fixed concurrency of 1 for V1)
- stop on cancellation/unmount; never schedule background work after unmount
- reload persisted status on resume

The **single user click** authorizes the full requested pricing run, but every provider call remains a persisted, bounded line request to prevent hidden retries/fanout.

### Step 4: integrate into `EstimatePage`

Replace/augment `Estimate Help` with the approved primary action `Price Estimate with AI`. Preserve manual editing.

### Step 5: GREEN + build

```bash
node --experimental-strip-types --test apps/web/test/pricing-run-workflow.test.ts
npm run test:web
npm run build:app
```

### Step 6: commit

```bash
git add apps/web/app/src/pages/EstimatePage.tsx apps/web/app/src/App.tsx apps/web/app/src/hooks/usePricingRun.ts apps/web/test/pricing-run-workflow.test.ts
git commit -m "feat: wire price estimate with AI workflow"
```

## Task 5 — apply accepted pricing to project UI cache and rehydrate from server

**Files**
- Add: `apps/web/app/src/utils/pricingApplication.ts`
- Modify: `apps/web/app/src/pages/EstimatePage.tsx`
- Modify: `apps/web/app/src/App.tsx`
- Add: `apps/web/test/pricing-application.test.ts`

### Step 1: RED tests

Pure merge helper:

```ts
applyAcceptedSuggestion(project, suggestion) -> updated Project
```

Must:
- match only the intended stable `lineKey`/estimate item ID
- set material/labor/equipment/other-compatible fields without duplicating a line
- preserve quantity/name/CSI identity
- attach suggestion provenance metadata
- recalculate `directCost`
- refuse a suggestion for a different project/line

Rehydration test:
- if browser `app_state` lacks pricing metadata but server has an accepted suggestion, the page can overlay/recover that accepted server snapshot
- rejected/stale suggestion never overwrites a manually confirmed current project value

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-application.test.ts
```

### Step 3: implement

After successful server `accept/edit`, apply returned values to current `Project` and use the existing `ProjectSaveQueue` path in `App.tsx` to persist `app_state`.

The server suggestion record remains provenance authority; `app_state` is a synchronized product-state cache.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/web/test/pricing-application.test.ts
npm run test:web
```

### Step 5: commit

```bash
git add apps/web/app/src/utils/pricingApplication.ts apps/web/app/src/pages/EstimatePage.tsx apps/web/app/src/App.tsx apps/web/test/pricing-application.test.ts
git commit -m "feat: apply accepted pricing to project estimates"
```

## Task 6 — selective stale detection and refresh UX

**Files**
- Modify: `apps/api/src/pricing/service.ts`
- Modify: `apps/api/test/pricing-service.test.ts`
- Modify: `apps/web/app/src/hooks/usePricingRun.ts`
- Modify: `apps/web/test/pricing-run-workflow.test.ts`

### Step 1: RED tests

Implement `evaluateRunStaleness()` from stored snapshots vs current:
- address changed -> all geographically dependent lines stale
- quantity changed -> that line stale
- unit/item key changed -> that line stale
- confirmed Job Condition changed -> related operational lines + affected base lines stale
- Regional Book version updated -> only regional-sourced affected lines stale
- unrelated project note change -> no pricing stale state

No live research occurs merely because a stale state is detected.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-service.test.ts --test-name-pattern="stale"
node --experimental-strip-types --test apps/web/test/pricing-run-workflow.test.ts --test-name-pattern="refresh"
```

### Step 3: implement

UI copy/action:

`Some prices are out of date because the address, quantities, or job conditions changed.`

Button: `Refresh affected prices`

Action creates/updates refresh run and advances only affected lines under the same explicit workflow.

### Step 4: GREEN

```bash
npm run test:api
npm run test:web
```

### Step 5: commit

```bash
git add apps/api/src/pricing/service.ts apps/api/test/pricing-service.test.ts apps/web/app/src/hooks/usePricingRun.ts apps/web/test/pricing-run-workflow.test.ts
git commit -m "feat: refresh only affected pricing suggestions"
```

## Task 7 — RED: client-safe proposal DTO at the server boundary

**Files**
- Modify: `apps/api/src/proposals/service.ts`
- Modify: `apps/api/src/proposals/routes.ts`
- Modify: `apps/api/src/proposals/share.ts`
- Add or modify: `apps/api/test/proposals.test.ts`
- Add: `apps/api/test/proposal-privacy.test.ts`

### Why this task is mandatory

Current `renderProposalHtml()` explicitly renders `Materials`, `Labor`, `Equipment`, `Other`, `Overhead`, and `Markup`. That violates the approved client boundary and must be replaced before Pricing Intelligence client proposals ship.

### Step 1: RED privacy tests

Define a DTO that cannot carry internal economics:

```ts
export type ClientProposalView = {
  proposalId: string;
  projectName: string;
  estimateVersion: number;
  customer: ProposalCustomer;
  brand: ProposalBrand;
  currency: string;
  scopeLines: Array<{ name: string; description?: string; clientPrice?: number }>;
  proposalTotal: number;
  notes?: string;
  finalizedAt: string;
};
```

Tests construct an internal estimate with unique sentinel numbers:
- material = `1234.56`
- labor = `2345.67`
- overhead = `345.78`
- markup = `456.89`
- confidence = `0.876`
- source URL = `https://internal.example/source`

Assert neither public JSON nor generated HTML contains those fields/values/URL.

Also assert client view may contain final sale price and plain-language included scope.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/proposal-privacy.test.ts
```

Expected: FAIL because current server proposal HTML exposes internal categories/overhead/markup.

### Step 3: refactor server proposal generation around safe DTO

`renderProposalHtml` must accept `ClientProposalView`, not raw `Estimate`.

Do not “hide with CSS”; remove data from the DTO/serialization path entirely.

If scope-line client prices are not explicitly available/approved, render scope names/descriptions and one `Proposal total` rather than allocating overhead/markup across lines with guessed math.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/proposal-privacy.test.ts apps/api/test/proposals.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/proposals/service.ts apps/api/src/proposals/routes.ts apps/api/src/proposals/share.ts apps/api/test/proposals.test.ts apps/api/test/proposal-privacy.test.ts
git commit -m "fix: enforce client proposal pricing privacy"
```

## Task 8 — client proposal web/PDF privacy parity

**Files**
- Modify: `apps/web/app/src/pages/ClientProposalPage.tsx`
- Modify: `apps/web/app/src/components/ProposalModal.tsx`
- Modify: `apps/web/app/src/utils/pdfExport.ts`
- Add: `apps/web/test/client-proposal-privacy.test.ts`

### Step 1: RED tests

Assert all client-facing web/export paths:
- show scope + customer-facing sale price
- do not show Contractor Cost
- do not show material/labor raw cost
- do not show overhead/markup/margin
- do not show AI confidence
- do not show source/provider URLs
- do not show proprietary Regional Book version/item price data

Use the same sentinel-value strategy as the server privacy test.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/client-proposal-privacy.test.ts
```

### Step 3: implement safe DTO consumption

ClientProposalPage should render only the public API's safe proposal payload. Do not import internal `Project`/`EstimateItem` pricing structures into public proposal code.

Local PDF export for estimator-created proposal must project internal state into the same safe DTO first.

### Step 4: GREEN + build

```bash
node --experimental-strip-types --test apps/web/test/client-proposal-privacy.test.ts
npm run test:web
npm run build:app
```

### Step 5: commit

```bash
git add apps/web/app/src/pages/ClientProposalPage.tsx apps/web/app/src/components/ProposalModal.tsx apps/web/app/src/utils/pdfExport.ts apps/web/test/client-proposal-privacy.test.ts
git commit -m "fix: keep internal pricing out of client proposal UI"
```

## Task 9 — final Workstream 05 verification

Fresh verification:

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Manual preview checks:
1. click `Price Estimate with AI` once; run progresses and persists
2. no provider request on ordinary edit keystrokes
3. sufficient suggestions show AI Suggested / Needs Review
4. low-confidence suggestion cannot one-click apply
5. Accept/Edit/Reject provenance survives reload
6. Material Pickup, floor carry, trash/disposal, cleanup, etc. appear explicitly where confirmed/priced
7. Contractor Cost, Company Price, AI Recommended Price are visually distinct internally
8. Recommended Client Price never lower than Company Price
9. changed quantity/address/conditions only mark affected prices stale
10. public proposal JSON, web view, server PDF, and local export contain no internal cost/markup/margin/confidence/source leakage

No production deployment is authorized by this plan.

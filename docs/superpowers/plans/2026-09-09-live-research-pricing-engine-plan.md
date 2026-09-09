# RoughBid Live Research + Pricing Recommendation Engine Implementation Plan

> **Goal:** Resolve material/labor/operational pricing from trusted sources, retain provenance, fail closed on weak data, and produce Contractor Cost, Company Price, and AI Recommended Client Price.
> **Depends on:** Workstreams 01-03.
> **Provider spend:** Only explicit user actions (`Price Estimate with AI`, `Reprice`, `Refresh affected prices`) may initiate live research. No background/keystroke research.
> **Production DB/provider config:** NOT authorized by this plan.

## Architecture

Create a separate pricing domain under `apps/api/src/pricing/`. The plan reader remains pricing-free. Pricing proceeds per stable estimate-line snapshot:

`resolved address -> company price -> entitled regional book -> optional grounded live research -> broader geography fallback -> Needs Review`

Do not use a fire-and-forget serverless worker. A pricing run is durable, but external research is advanced by explicit bounded line requests. If the browser closes, persisted run/line state can resume later without duplicate provider calls.

### Critical correction to current code

`apps/api/src/ai-plan/pricing.ts` currently contains hard-coded placeholder/default and New England rates without durable source provenance. Those rates conflict with the approved fail-closed Pricing Intelligence design. They must not survive as an automatic pricing fallback. Workstream 04 replaces that approach with sourced observations.

## Task 1 — RED: durable pricing runs, observations, and suggestions

**Files**
- Add: `supabase/migrations/0038_pricing_observations_suggestions.sql`
- Add: `supabase/test/pricing-observations-suggestions.test.mjs`

### Step 1: write failing schema tests

Require these durable entities.

```sql
create table public.pricing_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  run_type text not null check (run_type in ('full','line','refresh')),
  status text not null check (status in ('created','researching','needs_review','ready','failed')),
  input_fingerprint text not null,
  pricing_address_snapshot jsonb not null,
  job_conditions_snapshot jsonb not null default '[]'::jsonb,
  regional_versions_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, project_id, input_fingerprint)
);
```

```sql
create table public.pricing_run_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pricing_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  line_key text not null,
  item_key text not null,
  name text not null,
  category text,
  quantity numeric(18,6) not null,
  unit text not null,
  research_status text not null check (research_status in ('not_needed','research_required','researching','complete','failed')),
  created_at timestamptz not null default now(),
  unique (run_id, line_key)
);
```

```sql
create table public.price_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pricing_runs(id) on delete cascade,
  run_line_id uuid not null references public.pricing_run_lines(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_type text not null check (source_type in ('company','regional_book','live_research','benchmark')),
  source_name text not null,
  source_url text,
  source_ref text,
  source_region text,
  source_version text,
  price_basis text not null check (price_basis in ('supplier_material','retail_material','loaded_labor','wage','billable_labor','installed','equipment','service_fee')),
  category text not null check (category in ('material','labor','equipment','other')),
  unit text not null,
  low_rate numeric(14,6),
  typical_rate numeric(14,6) not null,
  high_rate numeric(14,6),
  observed_at timestamptz not null,
  freshness_status text not null check (freshness_status in ('current','stale')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

```sql
create table public.pricing_suggestions (
  id uuid primary key default gen_random_uuid(),
  run_line_id uuid not null unique references public.pricing_run_lines(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null check (status in ('suggested','manual_review_only','accepted','edited','rejected','stale')),
  material_cost numeric(14,2) not null default 0,
  labor_cost numeric(14,2) not null default 0,
  equipment_cost numeric(14,2) not null default 0,
  other_cost numeric(14,2) not null default 0,
  contractor_cost numeric(14,2) not null default 0,
  company_price numeric(14,2) not null default 0,
  recommended_client_price numeric(14,2) not null default 0,
  confidence numeric(4,3) not null,
  source_summary jsonb not null,
  explanations jsonb not null default '[]'::jsonb,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Add RLS using current admin/estimator/viewer roles. Only server-controlled service functions may insert live research observations; authenticated users may read observations for their workspace. Suggestion acceptance/edit/reject requires admin/estimator.

### Step 2: RED

```bash
node --test supabase/test/pricing-observations-suggestions.test.mjs
```

Expected: FAIL because migration does not exist.

### Step 3: implement migration/indexes

Indexes:
- pricing runs by workspace/project/created_at
- observations by run_line/source_type/freshness
- suggestions by project/status

Do not create Stripe tables in this migration.

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/pricing-observations-suggestions.test.mjs
```

### Step 5: commit

```bash
git add supabase/migrations/0038_pricing_observations_suggestions.sql supabase/test/pricing-observations-suggestions.test.mjs
git commit -m "feat: add durable pricing research and suggestion records"
```

## Task 2 — RED: provider-neutral live research contract

**Files**
- Add: `apps/api/src/pricing/research-provider.ts`
- Add: `apps/api/test/pricing-research-provider.test.ts`

### Step 1: write failing contract/validation tests

```ts
export type PriceResearchQuery = {
  itemKey: string;
  itemName: string;
  category: 'material' | 'labor' | 'equipment' | 'other';
  quantity: number;
  unit: string;
  address: { city?: string; state?: string; postalCode?: string };
  geographicScope: 'zip' | 'city' | 'metro' | 'state' | 'region' | 'national';
  jobConditions: readonly JobCondition[];
};

export type ResearchObservation = {
  sourceName: string;
  sourceUrl: string;
  sourceRegion: string;
  priceBasis: PriceBasis;
  category: PriceCategory;
  unit: string;
  lowRate?: number;
  typicalRate: number;
  highRate?: number;
  observedAt: string;
  confidence: number;
};

export interface PriceResearchProvider {
  research(query: PriceResearchQuery): Promise<readonly ResearchObservation[]>;
}
```

Validator tests must reject:
- source URL missing for live research
- non-HTTP(S) URLs
- negative/non-finite rates
- wrong unit/category
- `wage` observation used directly as `loaded_labor`
- source region omitted
- confidence outside 0..1

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-research-provider.test.ts
```

### Step 3: implement contract + sanitizer

Never let provider output write an estimate directly. Provider returns candidate observations; resolver decides usability.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-research-provider.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/research-provider.ts apps/api/test/pricing-research-provider.test.ts
git commit -m "feat: define sourced price research contract"
```

## Task 3 — grounded Google Search adapter with citation verification

**Files**
- Add: `apps/api/src/pricing/gemini-grounded-research.ts`
- Add: `apps/api/test/gemini-grounded-research.test.ts`
- Modify: `apps/api/src/http/handler.ts` only when wiring the adapter into pricing dependencies

### Step 1: RED tests with a fake Gemini client

The repository already uses `@google/genai`. The current SDK/API supports Google Search grounding via `tools: [{ googleSearch: {} }]`. Build another narrow client interface rather than coupling to the plan reader.

Test that the adapter:
- sends no plan PDF or private plan text; only normalized item/location/job-condition query needed for pricing
- asks for current local pricing and distinguishes material, loaded labor, billable labor, installed price, service fee, etc.
- requires cited HTTP(S) sources
- rejects a model-emitted `source_url` that does not occur in provider grounding metadata/citations
- returns zero observations instead of fabricating a source when citations are absent
- never performs a second provider call automatically after an invalid response

Fake response shape should include model JSON plus grounding URLs. The exact SDK wrapper can normalize either `groundingMetadata.groundingChunks[].web.uri` or current citation annotations into one verified URL set.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/gemini-grounded-research.test.ts
```

### Step 3: implement adapter

Prompt requirements:

```text
Research current construction pricing for the exact item and unit in the supplied location.
Return only observed/source-backed prices. Do not estimate a missing price.
Classify each observation's basis: supplier_material, retail_material, loaded_labor,
wage, billable_labor, installed, equipment, or service_fee.
Every observation must include an HTTP(S) source URL grounded by Google Search.
Do not convert wages into loaded labor and do not convert installed prices into contractor cost.
```

Call the model with Google Search grounding enabled. After parsing JSON, intersect every claimed `sourceUrl` with the grounded URL set. Drop anything not verifiably cited.

Use a dedicated env variable/config object for pricing research even if it initially points to the same provider account. This keeps pricing research spend/config independently disableable.

Fail closed when config is missing: return/throw a stable `LIVE_PRICING_RESEARCH_UNAVAILABLE`; do not fall back to legacy hard-coded rates.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/gemini-grounded-research.test.ts apps/api/test/pricing-research-provider.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/gemini-grounded-research.ts apps/api/test/gemini-grounded-research.test.ts
git commit -m "feat: add grounded live pricing research adapter"
```

## Task 4 — RED: freshness, geographic fallback, and confidence policy

**Files**
- Add: `apps/api/src/pricing/evidence.ts`
- Add: `apps/api/test/pricing-evidence.test.ts`

### Step 1: write failing tests

Rules:
- live **material** observation <=30 days old -> current
- >30 days -> stale
- future observation dates rejected
- exact ZIP/city evidence ranks above state/region/national when all else equal
- mismatched unit never blends
- two independent current sources with matching basis/unit and reasonable spread can reach auto-suggest confidence
- one live source is capped below auto-suggest threshold
- stale source cannot independently produce auto-suggest

Use explicit thresholds:

```ts
export const AUTO_SUGGEST_CONFIDENCE = 0.80;
export const MANUAL_REVIEW_MIN_CONFIDENCE = 0.60;
export const LIVE_MATERIAL_FRESHNESS_DAYS = 30;
```

One-source live evidence should cap at `0.74`; therefore it may inform manual review but cannot silently prefill.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-evidence.test.ts
```

### Step 3: implement deterministic scoring

Inputs should include:
- source type/authority
- recency
- geography scope
- unit match
- price basis compatibility
- cross-source agreement

Do not ask the LLM to assign the final application confidence score. Provider confidence can be an input; app policy owns the final score.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-evidence.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/evidence.ts apps/api/test/pricing-evidence.test.ts
git commit -m "feat: add deterministic pricing evidence policy"
```

## Task 5 — source hierarchy resolver + retire hard-coded fallback pricing

**Files**
- Add: `apps/api/src/pricing/source-resolver.ts`
- Add: `apps/api/test/pricing-source-resolver.test.ts`
- Delete or replace: `apps/api/src/ai-plan/pricing.ts`
- Delete or replace: `apps/api/test/ai-plan-pricing.test.ts`
- Modify: `apps/web/app/src/services/api.ts` to remove stale `geometry.pricing` assumptions if no live API path uses them

### Step 1: RED hierarchy tests

Required cases:
1. exact active Company confirmed price wins
2. regional match used when no company match
3. live research used when no company/regional match
4. broader geography evidence is fallback only
5. weak evidence -> `Needs Review`, no numeric auto-prefill
6. company price may receive an outlier warning but its confirmed value is not overwritten
7. `wage` cannot be used as contractor `laborCost` without an explicit loaded-labor source/company burden model
8. `billable_labor` may inform market/recommended client price but not direct contractor labor cost
9. `installed` price may inform client-market comparison but cannot be split into material/labor with guessed percentages

### Step 2: add RED regression proving hard-coded defaults are forbidden

Replace the current legacy test expectation (`Miscellaneous fastener package` automatically gets `$25 EA + $20 labor`) with:

```ts
const resolution = await resolver.resolve(unknownFastener);
assert.equal(resolution.status, 'needs_review');
assert.equal(resolution.autoApply, false);
assert.equal(resolution.observations.length, 0);
```

### Step 3: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-source-resolver.test.ts apps/api/test/ai-plan-pricing.test.ts
```

Expected: FAIL under legacy hard-coded behavior.

### Step 4: implement resolver and remove legacy automatic rates

Do not keep `UNIT_DEFAULT_RATES` or `LABEL_KEYWORD_RATES` as hidden fallback. If historic benchmarks are valuable, they must later be imported as an official, versioned Regional Price Book with provenance.

Suggested resolver output:

```ts
export type PriceResolution = {
  status: 'resolved' | 'manual_review_only' | 'needs_review';
  sourceType: 'company' | 'regional_book' | 'live_research' | 'benchmark' | null;
  autoApply: boolean;
  category: PriceCategory;
  unit: string;
  rate: string | null;
  range: { low: string; high: string } | null;
  confidence: number;
  observations: PriceObservation[];
  warnings: string[];
};
```

### Step 5: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-source-resolver.test.ts
npm run test:api
```

### Step 6: commit

```bash
git add -A apps/api/src/ai-plan/pricing.ts apps/api/test/ai-plan-pricing.test.ts apps/api/src/pricing/source-resolver.ts apps/api/test/pricing-source-resolver.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: replace hard-coded plan rates with sourced pricing resolver"
```

## Task 6 — explicit Job Condition cost-line generation

**Files**
- Add: `apps/api/src/pricing/operational-lines.ts`
- Add: `apps/api/test/pricing-operational-lines.test.ts`

### Step 1: RED tests

Confirmed conditions should generate explicit **pricing requests**, not invented costs. Examples:

```ts
floor_carry({ floors: 3 }) -> itemKey 'operations:floor-carry', category 'labor'
material_pickup({ required: true, trips: 2 }) -> 'operations:material-pickup'
disposal_fees({ required: true }) -> 'operations:disposal-fee', category 'other'
manual_debris_carry -> 'operations:debris-handling', category 'labor'
final_cleanup -> 'operations:final-cleanup', category 'labor'
lift_scaffold -> one or more equipment/service pricing requests
```

Tests must prove:
- rejected/not-applicable condition generates no line
- `Needs confirmation` condition generates no priced line
- confirmed condition creates a visible named line request
- there is no embedded default dollar rate

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-operational-lines.test.ts
```

### Step 3: implement deterministic mapping

Mapping converts context -> what must be priced; source resolver still determines the money.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-operational-lines.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/operational-lines.ts apps/api/test/pricing-operational-lines.test.ts
git commit -m "feat: model explicit job condition cost lines"
```

## Task 7 — RED: Contractor Cost / Company Price / AI Recommended Price engine

**Files**
- Add: `packages/domain/src/pricing-recommendation.ts`
- Modify: `packages/domain/src/index.ts`
- Add: `packages/domain/test/pricing-recommendation.test.ts`

### Step 1: write failing fixed-point domain tests

Reuse `calculateProject` for deterministic Company Price.

Input:

```ts
const result = calculatePricingRecommendation({
  costLines: [
    { id: 'tile-material', category: 'material', quantity: '1', unitRate: '3150' },
    { id: 'tile-labor', category: 'labor', quantity: '1', unitRate: '4620' },
    { id: 'pickup', category: 'other', quantity: '1', unitRate: '275' },
    { id: 'floor-carry', category: 'labor', quantity: '1', unitRate: '420' },
    { id: 'disposal', category: 'other', quantity: '1', unitRate: '350' },
  ],
  overheadPercent: '12',
  markupPercent: '25',
  marketClientPriceEvidence: [],
});
assert.equal(result.recommendedClientPrice, result.companyPrice);
```

Additional rules:
- `contractorCost = directCost`
- `companyPrice = calculateProject(...).finalPrice`
- recommended client price **never below Company Price**
- when compatible high-confidence **client-facing** market evidence has a higher typical value, recommended price may rise to that supported value
- wage/material-direct-cost evidence cannot be mistaken for client-facing market evidence
- no evidence -> no arbitrary risk percentage; explicit risk/site costs belong in cost lines

### Step 2: RED

```bash
node --experimental-strip-types --test packages/domain/test/pricing-recommendation.test.ts
```

### Step 3: implement pure deterministic function

```ts
export function calculatePricingRecommendation(input: PricingRecommendationInput): PricingRecommendationResult {
  const company = calculateProject({ lineItems: input.costLines, overheadPercent: input.overheadPercent, markupPercent: input.markupPercent });
  const supportedMarket = resolveSupportedClientMarketPrice(input.marketClientPriceEvidence);
  const recommended = supportedMarket == null ? company.finalPrice : Math.max(company.finalPrice, supportedMarket);
  return { contractorCost: company.directCost, companyPrice: company.finalPrice, recommendedClientPrice: recommended, ... };
}
```

Use the package's fixed-point helpers or decimal-string path; do not introduce floating-point money math for final totals.

### Step 4: GREEN

```bash
node --experimental-strip-types --test packages/domain/test/pricing-recommendation.test.ts
npm run test:domain
```

### Step 5: commit

```bash
git add packages/domain/src/pricing-recommendation.ts packages/domain/src/index.ts packages/domain/test/pricing-recommendation.test.ts
git commit -m "feat: calculate contractor company and recommended prices"
```

## Task 8 — durable pricing-run service and explicit per-line research

**Files**
- Add: `apps/api/src/pricing/service.ts`
- Add: `apps/api/test/pricing-service.test.ts`

### Step 1: RED service tests

Contract:

```ts
class PricingService {
  createRun(projectId: string, input: CreatePricingRunInput): Promise<PricingRun>;
  getRun(runId: string): Promise<PricingRunDetails>;
  researchLine(runId: string, runLineId: string, input?: { forceRefresh?: boolean }): Promise<PricingRunLineResult>;
}
```

Tests must prove:
- unresolved/missing pricing address -> createRun rejects before research
- input fingerprint includes line quantity/unit/item key + resolved address + confirmed Job Conditions + regional versions
- identical create request reuses same run
- Company/Regional resolved lines do not call live provider
- unresolved line gets `research_required`
- `researchLine` performs at most one provider request for that explicit action
- retry without `forceRefresh` reuses current persisted observation
- low-confidence research produces `manual_review_only`, no auto-prefill
- provider failure marks only that run line failed/needs review; no invented fallback
- cross-workspace run/line lookup rejected

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-service.test.ts
```

### Step 3: implement service orchestration

Creation should:
1. load and assert resolved pricing context
2. load confirmed Job Conditions
3. snapshot relevant regional entitlements/versions
4. persist input lines + explicit operational lines
5. resolve Company/Regional evidence synchronously
6. mark only unresolved lines as `research_required`

`researchLine` should:
1. verify membership/run ownership
2. return existing current live observation unless force refresh was explicitly requested
3. build narrow query
4. call exactly one provider attempt
5. validate/persist observations
6. resolve suggestion
7. never launch work after returning HTTP response

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-service.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/pricing/service.ts apps/api/test/pricing-service.test.ts
git commit -m "feat: orchestrate durable pricing runs"
```

## Task 9 — Pricing API: full run, line research, reprice, refresh

**Files**
- Modify: `apps/api/src/pricing/routes.ts`
- Modify: `apps/api/src/http/handler.ts`
- Add: `apps/api/test/pricing-run-routes.test.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED route tests

Endpoints:

```text
POST /api/projects/:projectId/pricing-runs
GET  /api/pricing-runs/:runId
POST /api/pricing-runs/:runId/lines/:lineId/research
POST /api/pricing-runs/:runId/lines/:lineId/reprice
POST /api/pricing-runs/:runId/refresh-affected
```

`POST /pricing-runs` does **not** automatically fan out provider calls. It creates the run and returns which lines need explicit live research.

`research` is one bounded provider attempt for one line.

`reprice` invalidates/re-evaluates only the selected line.

`refresh-affected` accepts the current changed input fingerprint and marks only impacted suggestions stale; it does not research until the user explicitly advances those lines.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-run-routes.test.ts
```

### Step 3: implement routes and web types

Add request timeout appropriate for one grounded research call, not for unbounded whole-estimate fanout.

Keep live provider credentials server-only.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-run-routes.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/pricing/routes.ts apps/api/src/http/handler.ts apps/api/test/pricing-run-routes.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: expose explicit pricing research workflow"
```

## Task 10 — final Workstream 04 verification

Fresh verification:

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Security/cost review:
- no client-side provider key
- no research while address conflict unresolved
- no live call when Company/Regional evidence suffices unless user explicitly requests refresh
- one explicit line research action -> max one provider call
- no automatic retry fanout
- no hard-coded hidden dollar fallback
- live sources have verified URL provenance
- >30-day material observation becomes stale
- wage is not converted into loaded/billable labor silently
- low confidence is not auto-applied
- recommended client price never falls below Company Price
- Job Condition costs appear as explicit lines

Manual preview test with synthetic/fake provider first. Do not enable real provider spend or apply `0038` in production under this plan.

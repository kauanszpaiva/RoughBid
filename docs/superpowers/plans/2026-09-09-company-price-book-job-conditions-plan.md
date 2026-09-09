# RoughBid Company Price Book + Job Conditions Implementation Plan

> **Goal:** Persist the contractor's own confirmed rates as the highest-priority pricing source and make site/logistics conditions explicit, reviewable inputs instead of hidden assumptions.
> **Depends on:** Workstream 01 pricing context.
> **Production DB:** NOT authorized by this plan.

## Architecture

Add two workspace-owned pricing resources:

1. **Company Price Book** — free, durable material/labor/equipment/other rates plus compact assembly rates. Confirmed company values are immutable in provenance terms: editing a value updates the active record with explicit `confirmed_by/confirmed_at`; later AI research may warn but never silently replace it.
2. **Job Conditions Check** — a deterministic catalog of conditions every pricing run considers. Stored rows only contain detected/confirmed/rejected facts; the API merges those rows with the full condition catalog so missing conditions always appear as `Needs confirmation`.

Plan extraction may contribute **condition candidates with page evidence**, but cannot assign money to them. The pricing engine in Workstream 04 will turn confirmed conditions into explicit cost suggestions.

## Task 1 — RED: durable Company Price Book schema

**Files**
- Add: `supabase/migrations/0036_company_price_book_job_conditions.sql`
- Add: `supabase/test/company-price-book-job-conditions.test.mjs`

### Step 1: write failing schema tests

Require these tables and constraints:

```sql
create table public.company_price_book_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  item_key text not null,
  name text not null,
  category text not null check (category in ('material','labor','equipment','other')),
  unit text not null,
  unit_rate numeric(14,6) not null check (unit_rate >= 0),
  supplier text,
  notes text,
  effective_at timestamptz not null default now(),
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, item_key)
);
```

And compact assemblies:

```sql
create table public.company_price_book_assemblies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  assembly_key text not null,
  name text not null,
  category text not null,
  unit text not null,
  material_rate numeric(14,6) not null default 0,
  labor_rate numeric(14,6) not null default 0,
  equipment_rate numeric(14,6) not null default 0,
  other_rate numeric(14,6) not null default 0,
  notes text,
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, assembly_key)
);
```

Use exact PostgreSQL `numeric`, not floating-point money.

RLS:
- admin/estimator/viewer may SELECT for their workspace
- admin/estimator may INSERT/UPDATE
- only admin may hard DELETE; estimator can set `active=false`
- all policies require `private.has_product_access()`

### Step 2: RED

```bash
node --test supabase/test/company-price-book-job-conditions.test.mjs
```

Expected: FAIL because `0036` does not exist.

### Step 3: implement migration + indexes

Add indexes on `(workspace_id, category, active)` and normalized keys. Keep tenant identity in every unique constraint.

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/company-price-book-job-conditions.test.mjs
```

Expected: PASS.

**Production safety:** create/test `0036`; do not blanket-apply pending migrations.

### Step 5: commit

```bash
git add supabase/migrations/0036_company_price_book_job_conditions.sql supabase/test/company-price-book-job-conditions.test.mjs
git commit -m "feat: add durable company price book schema"
```

## Task 2 — RED: Company Price Book service and precedence contract

**Files**
- Add: `apps/api/src/pricing/company-price-book.ts`
- Add: `apps/api/test/company-price-book.test.ts`

### Step 1: write failing unit tests

Public service contract:

```ts
export type CompanyPriceCategory = 'material' | 'labor' | 'equipment' | 'other';
export type CompanyPriceBookItem = {
  id: string;
  workspaceId: string;
  itemKey: string;
  name: string;
  category: CompanyPriceCategory;
  unit: string;
  unitRate: string;
  supplier: string | null;
  effectiveAt: string;
  confirmedBy: string;
  confirmedAt: string;
  active: boolean;
};
```

Tests must prove:
- item key is normalized deterministically (`drywall:5/8-type-x:sf`, not AI free text)
- unit is normalized upper-case
- negative/non-finite rate rejected
- write always stamps authenticated `confirmed_by`
- workspace scoping is mandatory
- inactive entries are excluded from automatic resolution
- exact company match is returned as `sourceType: 'company'` and marked `confirmed: true`

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/company-price-book.test.ts
```

Expected: FAIL because service does not exist.

### Step 3: implement focused service

Suggested methods:

```ts
class CompanyPriceBookService {
  list(): Promise<CompanyPriceBookItem[]>;
  create(input: CompanyPriceBookWriteInput): Promise<CompanyPriceBookItem>;
  update(id: string, input: CompanyPriceBookWriteInput): Promise<CompanyPriceBookItem>;
  deactivate(id: string): Promise<void>;
  findConfirmed(itemKey: string, category: CompanyPriceCategory, unit: string): Promise<CompanyPriceBookItem | null>;
}
```

Do not add AI research or regional fallback here. This module answers one question: “does this workspace have a contractor-confirmed matching value?”

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/company-price-book.test.ts
```

Expected: PASS.

### Step 5: commit

```bash
git add apps/api/src/pricing/company-price-book.ts apps/api/test/company-price-book.test.ts
git commit -m "feat: add company price book service"
```

## Task 3 — Company Price Book API + server-authoritative web client

**Files**
- Modify: `apps/api/src/pricing/routes.ts`
- Modify: `apps/api/src/http/handler.ts`
- Add: `apps/api/test/company-price-book-routes.test.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED route tests

Endpoints:

```text
GET    /api/pricing/company-price-book/items
POST   /api/pricing/company-price-book/items
PATCH  /api/pricing/company-price-book/items/:id
DELETE /api/pricing/company-price-book/items/:id
GET    /api/pricing/company-price-book/assemblies
POST   /api/pricing/company-price-book/assemblies
PATCH  /api/pricing/company-price-book/assemblies/:id
```

Every call requires `x-workspace-id` and authenticated membership.

Tests:
- viewer GET -> 200
- viewer write -> 403
- estimator create/update -> 200
- estimator DELETE -> 403; use deactivate path
- admin DELETE -> allowed if product wants hard delete
- cross-workspace ID -> not found without data leakage

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/company-price-book-routes.test.ts
```

### Step 3: implement routes and web client types

Add web functions such as:

```ts
listCompanyPriceBookItems(workspaceId)
createCompanyPriceBookItem(workspaceId, input)
updateCompanyPriceBookItem(workspaceId, id, input)
deactivateCompanyPriceBookItem(workspaceId, id)
```

Keep all backend fetches inside `apps/web/app/src/services/api.ts`.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/company-price-book-routes.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/pricing/routes.ts apps/api/src/http/handler.ts apps/api/test/company-price-book-routes.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: expose workspace company price book API"
```

## Task 4 — migrate Company Price Book UI off browser-local authority

**Files**
- Modify: `apps/web/app/src/pages/PriceListsPage.tsx`
- Modify: `apps/web/app/src/pages/MaterialsPage.tsx`
- Modify: `apps/web/app/src/types/index.ts`
- Add: `apps/web/test/company-price-book-ui.test.ts`

### Step 1: RED UI tests

Assert:
- page loads server price-book rows, not only `StorageService.getMaterials`
- confirmed rate shows supplier/effective date
- write actions are hidden/disabled for viewer
- rate is clearly `Company confirmed`
- CSV export uses the server-loaded rows
- local-only browser prices are not silently treated as authoritative server data

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/company-price-book-ui.test.ts
```

### Step 3: implement server-backed page

`PriceListsPage` should receive/load the current workspace and use API service calls. Keep `StorageService` only for legacy display/import during transition.

If remote list is empty and legacy browser items exist, show an explicit one-time action:

`Import existing browser prices`

Import must call the API item-by-item/batched and mark each imported value as human-confirmed only after the signed-in estimator/admin explicitly clicks the import action. Never auto-upload local values as confirmed pricing.

### Step 4: GREEN + build

```bash
node --experimental-strip-types --test apps/web/test/company-price-book-ui.test.ts
npm run test:web
npm run build:app
```

### Step 5: commit

```bash
git add apps/web/app/src/pages/PriceListsPage.tsx apps/web/app/src/pages/MaterialsPage.tsx apps/web/app/src/types/index.ts apps/web/test/company-price-book-ui.test.ts
git commit -m "feat: make company price book server authoritative"
```

## Task 5 — RED: Job Conditions schema and deterministic catalog

**Files**
- Modify: `supabase/migrations/0036_company_price_book_job_conditions.sql`
- Modify: `supabase/test/company-price-book-job-conditions.test.mjs`
- Add: `apps/api/src/pricing/job-conditions.ts`
- Add: `apps/api/test/job-conditions.test.ts`

### Step 1: add failing schema + catalog tests

Table:

```sql
create table public.project_job_conditions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  condition_type text not null,
  status text not null check (status in ('needs_confirmation','confirmed','rejected')),
  value jsonb not null default '{}'::jsonb,
  source text not null check (source in ('plan','project','user','ai')),
  confidence numeric(4,3),
  evidence_page integer,
  source_excerpt text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_id, condition_type)
);
```

Catalog must include at least:

```ts
[
  'floor_carry', 'elevator_access', 'carry_distance', 'difficult_access',
  'parking', 'material_pickup', 'delivery_restrictions', 'occupied_property',
  'protection_required', 'restricted_work_hours', 'dumpster_access',
  'manual_debris_carry', 'disposal_fees', 'final_cleanup',
  'lift_scaffold', 'travel_mobilization', 'permit_inspection'
]
```

Tests prove `getJobConditions()` returns every catalog entry even if the database has zero rows, each missing entry as `needs_confirmation`.

### Step 2: RED

```bash
node --test supabase/test/company-price-book-job-conditions.test.mjs
node --experimental-strip-types --test apps/api/test/job-conditions.test.ts
```

### Step 3: implement catalog and validation

Each condition definition should declare a typed value schema (boolean, number, enum, text) and a human-readable prompt. Examples:
- `floor_carry`: `{ floors: number }`
- `elevator_access`: `{ available: boolean, usableForMaterial?: boolean }`
- `material_pickup`: `{ required: boolean, trips?: number }`
- `disposal_fees`: `{ required: boolean, notes?: string }`

Reject unknown condition types and invalid values server-side.

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/company-price-book-job-conditions.test.mjs
node --experimental-strip-types --test apps/api/test/job-conditions.test.ts
```

### Step 5: commit

```bash
git add supabase/migrations/0036_company_price_book_job_conditions.sql supabase/test/company-price-book-job-conditions.test.mjs apps/api/src/pricing/job-conditions.ts apps/api/test/job-conditions.test.ts
git commit -m "feat: add job conditions catalog and persistence"
```

## Task 6 — plan-evidenced Job Condition candidates

**Files**
- Modify: `apps/api/src/ai-plan/types.ts`
- Modify: `apps/api/src/ai-plan/gemini.ts`
- Modify: `apps/api/src/ai-plan/service.ts`
- Modify: `apps/api/test/ai-plan-gemini.test.ts`
- Add: `apps/api/test/ai-plan-job-conditions.test.ts`

### Step 1: RED tests

Add an optional summary field:

```ts
export type PlanJobConditionEvidence = {
  condition_type: JobConditionType;
  value: Record<string, unknown>;
  page_number: number;
  source_excerpt: string;
  confidence: number;
};
```

Tests prove:
- visible title-block/note evidence may emit a condition candidate
- candidate without physical page + verbatim source is dropped
- model cannot mark a condition as human `confirmed`
- no cost/price field is accepted from plan output

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-job-conditions.test.ts
```

### Step 3: implement extraction and persistence

Prompt should request only conditions visibly supported in drawings/notes. For example, an elevation showing levels may support floor count; a note may state restricted hours or protection requirements. It must explicitly say “unknown is preferred to guessing.”

After a successful plan reading, upsert candidates into `project_job_conditions` as:
- `status='needs_confirmation'`
- `source='plan'`
- evidence page/excerpt/confidence

Never overwrite a row already `confirmed` or `rejected` by a human.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-job-conditions.test.ts apps/api/test/ai-plan-service.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/ai-plan/types.ts apps/api/src/ai-plan/gemini.ts apps/api/src/ai-plan/service.ts apps/api/test/ai-plan-gemini.test.ts apps/api/test/ai-plan-job-conditions.test.ts
git commit -m "feat: extract evidenced job condition candidates"
```

## Task 7 — Job Conditions API + Check UI

**Files**
- Modify: `apps/api/src/pricing/routes.ts`
- Add: `apps/api/test/job-conditions-routes.test.ts`
- Modify: `apps/web/app/src/services/api.ts`
- Add: `apps/web/app/src/components/JobConditionsCheck.tsx`
- Modify: `apps/web/app/src/pages/EstimatePage.tsx`
- Add: `apps/web/test/job-conditions-check.test.ts`

### Step 1: RED route/UI tests

Endpoints:

```text
GET   /api/projects/:projectId/job-conditions
PATCH /api/projects/:projectId/job-conditions/:conditionType
```

PATCH examples:

```json
{ "status": "confirmed", "value": { "floors": 3 } }
```

```json
{ "status": "rejected", "value": {} }
```

Tests prove:
- all conditions always appear
- AI/plan candidate is visibly distinguished from human confirmation
- viewer cannot confirm
- confirmed values record human identity/time
- condition check has a clear incomplete count before pricing

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/job-conditions-routes.test.ts apps/web/test/job-conditions-check.test.ts
```

### Step 3: implement focused UI

Add `JobConditionsCheck` rather than expanding `EstimatePage.tsx` with all condition controls. Show categories and concise inputs. Conditions such as trash removal, disposal, pickup, floor carry, access, parking, cleanup, lift/scaffold, and mobilization must be first-class visible rows.

The UI may allow `Unknown / Confirmed / Does not apply`, but it must not create a dollar amount yet; Workstream 04 prices confirmed conditions.

### Step 4: GREEN + build

```bash
node --experimental-strip-types --test apps/api/test/job-conditions-routes.test.ts apps/web/test/job-conditions-check.test.ts
npm run test:api
npm run test:web
npm run build:app
```

### Step 5: commit

```bash
git add apps/api/src/pricing/routes.ts apps/api/test/job-conditions-routes.test.ts apps/web/app/src/services/api.ts apps/web/app/src/components/JobConditionsCheck.tsx apps/web/app/src/pages/EstimatePage.tsx apps/web/test/job-conditions-check.test.ts
git commit -m "feat: add job conditions review workflow"
```

## Task 8 — final Workstream 02 verification

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Manual preview checks:
1. contractor can add material/labor/equipment/other company rate
2. rate survives device/browser change because it is server-side
3. viewer cannot modify price book
4. every Job Condition category appears even with no AI evidence
5. plan evidence is `Needs confirmation`, never auto-confirmed
6. human confirmed job condition survives a new plan reading
7. no live research, Regional Book access, or Stripe action exists yet

**Do not apply `0036` to production under this plan.**

# RoughBid Pricing Context + Plan Address Implementation Plan

> **Goal:** Make the construction-plan address a durable, evidenced pricing input and block pricing whenever the plan and project addresses conflict.
> **Depends on:** Approved Pricing Intelligence spec only.
> **Production DB:** NOT authorized by this plan. Create/test migration in repo; apply to production only under a later exact migration approval.

## Architecture

The existing plan reader remains an evidence extractor. Extend its structured summary with an optional `project_address` evidence object; do not let the model output pricing. A new `pricing/context.ts` module normalizes this evidence, compares it with `projects.address_text`, and persists one workspace-scoped `project_pricing_contexts` row. The row owns the pricing-address decision. All future pricing endpoints must call `assertPricingAddressResolved()` before external/local market research.

Use current RBAC helpers from `private.has_workspace_role(...)`. Admin/estimator may resolve an address conflict; viewers may read only.

## Task 1 — RED: define and sanitize plan-address evidence

**Files**
- Modify: `apps/api/src/ai-plan/types.ts`
- Modify: `apps/api/src/ai-plan/gemini.ts`
- Modify: `apps/api/test/ai-plan-gemini.test.ts`
- Add: `apps/api/test/ai-plan-address.test.ts`

### Step 1: write failing sanitizer tests

Add tests that prove:

```ts
const result = sanitizePlanReadingResult({
  summary: {
    sheet_count: 12,
    project_address: {
      project_name: 'Smith Renovation',
      street_address: '12 Main St',
      city: 'Needham',
      state: 'MA',
      postal_code: '02492',
      page_number: 1,
      source_excerpt: 'PROJECT ADDRESS: 12 MAIN ST, NEEDHAM MA 02492',
      confidence: 0.98,
    },
  },
  findings: [{
    page_number: 1, finding_type: 'scope_note', label: 'Project information',
    value_text: null, quantity: null, unit: null, confidence: 0.9,
    source_excerpt: 'PROJECT INFORMATION', geometry: {},
  }],
});
assert.equal(result.summary.project_address?.postal_code, '02492');
assert.equal(result.summary.project_address?.page_number, 1);
```

Also assert that address evidence is **dropped** when `page_number` or `source_excerpt` is missing, and that a limitation is recorded instead of inventing fields.

### Step 2: run RED

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-address.test.ts
```

Expected: FAIL because `project_address` is not in `PlanReadingSummary` / sanitizer output.

### Step 3: add the type

In `apps/api/src/ai-plan/types.ts` add:

```ts
export interface PlanProjectAddressEvidence {
  project_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  building_lot_unit: string | null;
  page_number: number;
  source_excerpt: string;
  confidence: number;
}
```

Add `project_address?: PlanProjectAddressEvidence` to `PlanReadingSummary`.

Implement a focused sanitizer that:
- requires a valid physical page within `sheet_count`
- requires a non-empty verbatim `source_excerpt`
- clips strings to safe lengths
- clamps confidence to `0.1..1`
- returns `undefined` rather than a partially fabricated address when evidence identity is invalid
- permits missing individual address components because some drawings omit ZIP/building/unit

### Step 4: extend the model schema, not its pricing responsibility

In `apps/api/src/ai-plan/gemini.ts`, extend the JSON shape in `systemPrompt` with `summary.project_address`. Add explicit instruction:

```text
Extract the project/site address from a cover sheet, title block, permit information, or project information when visibly supported. Include the physical page number and a verbatim source excerpt. Never infer or fabricate an address. This is evidence only; do not output prices, rates, or labor assumptions.
```

Preserve the existing hard invariant that the plan reader never outputs money/pricing.

### Step 5: GREEN

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-address.test.ts apps/api/test/ai-plan-gemini.test.ts
```

Expected: PASS.

### Step 6: commit

```bash
git add apps/api/src/ai-plan/types.ts apps/api/src/ai-plan/gemini.ts apps/api/test/ai-plan-address.test.ts apps/api/test/ai-plan-gemini.test.ts
git commit -m "feat: extract evidenced project address from plans"
```

## Task 2 — RED: durable pricing-context schema and RLS

**Files**
- Add: `supabase/migrations/0035_pricing_context.sql`
- Add: `supabase/test/pricing-context.test.mjs`

### Step 1: write schema/RLS tests first

The test should inspect the SQL and/or run against the project test database according to existing `supabase/test` conventions. Assert the migration defines:

- one pricing-context row per project
- workspace foreign key
- plan-address evidence JSON
- current project address snapshot
- resolved pricing address
- conflict status
- source decision
- plan file/job lineage
- resolver identity/time
- RLS for workspace reads and admin/estimator writes

Expected data contract:

```sql
create table public.project_pricing_contexts (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_address_text text,
  plan_address jsonb,
  pricing_address jsonb,
  address_source text check (address_source in ('plan','project','confirmed_override')),
  address_status text not null check (address_status in ('missing','clear','needs_resolution','resolved')),
  plan_file_id uuid references public.project_files(id) on delete set null,
  plan_job_id uuid references public.plan_reading_jobs(id) on delete set null,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_id)
);
```

Add a constraint that `resolved_by/resolved_at` are populated together and that `needs_resolution` cannot carry a trusted `pricing_address`.

### Step 2: RED

```bash
node --test supabase/test/pricing-context.test.mjs
```

Expected: FAIL because migration does not exist.

### Step 3: implement migration

Follow existing RBAC conventions:

```sql
alter table public.project_pricing_contexts enable row level security;

create policy project_pricing_contexts_select_member
on public.project_pricing_contexts for select to authenticated
using (private.has_workspace_role(workspace_id, array['admin','estimator','viewer']) and private.has_product_access());

create policy project_pricing_contexts_write_estimator
on public.project_pricing_contexts for all to authenticated
using (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access())
with check (private.has_workspace_role(workspace_id, array['admin','estimator']) and private.has_product_access());
```

Prefer separate insert/update/delete policies if the repository validation style rejects `for all`.

Grant only the columns/actions actually needed by authenticated users. Do not expose service-role-only plan lineage writes unnecessarily.

### Step 4: validate migration statically

```bash
npm run db:validate
node --test supabase/test/pricing-context.test.mjs
```

Expected: PASS.

**Production safety:** do not run a command that applies all pending migrations. `0023`-`0025` are unrelated/deferred. This task creates/tests `0035` only.

### Step 5: commit

```bash
git add supabase/migrations/0035_pricing_context.sql supabase/test/pricing-context.test.mjs
git commit -m "feat: add durable project pricing context"
```

## Task 3 — RED: address normalization, conflict detection, and fail-closed gate

**Files**
- Add: `apps/api/src/pricing/context.ts`
- Add: `apps/api/test/pricing-context.test.ts`

### Step 1: write domain-style tests

Required cases:

```ts
assert.equal(comparePricingAddresses(plan, null).status, 'clear');
assert.equal(comparePricingAddresses(null, '12 Main St, Needham, MA 02492').source, 'project');
assert.equal(comparePricingAddresses(planNeedham, '12 MAIN STREET, Needham MA 02492').status, 'clear');
assert.equal(comparePricingAddresses(planNeedham, '52 Main St, Needham, MA 02492').status, 'needs_resolution');
assert.equal(comparePricingAddresses(planNeedham, '12 Main St, Needham, MA 02108').status, 'needs_resolution');
assert.throws(() => assertPricingAddressResolved({ address_status: 'needs_resolution' } as any), /resolve/i);
```

Define fail-closed behavior precisely:
- plan address only -> use plan
- project address only -> use project
- neither -> `missing`
- both confidently normalize to same address -> `clear`
- both present but not provably the same -> `needs_resolution`

Do not use fuzzy AI matching as an authorization boundary.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-context.test.ts
```

Expected: FAIL because module does not exist.

### Step 3: implement pure functions

Public interfaces:

```ts
export type PricingAddressStatus = 'missing' | 'clear' | 'needs_resolution' | 'resolved';
export type PricingAddressSource = 'plan' | 'project' | 'confirmed_override';

export function normalizeAddressText(value: string): string;
export function comparePricingAddresses(plan: PlanProjectAddressEvidence | null, projectAddress: string | null): PricingAddressDecision;
export function assertPricingAddressResolved(context: { address_status: PricingAddressStatus; pricing_address?: unknown }): void;
```

Normalization may fold case, punctuation, repeated whitespace, and common `ST/STREET`, `RD/ROAD`, `AVE/AVENUE` tokens. Do not geocode in this function; external network lookup belongs in later research work.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-context.test.ts
```

Expected: PASS.

### Step 5: commit

```bash
git add apps/api/src/pricing/context.ts apps/api/test/pricing-context.test.ts
git commit -m "feat: add fail-closed pricing address resolution"
```

## Task 4 — persist plan address after a successful plan reading

**Files**
- Modify: `apps/api/src/ai-plan/service.ts`
- Modify: `apps/api/test/ai-plan-service.test.ts`
- Modify: `apps/api/src/pricing/context.ts`

### Step 1: write failing service test

Create a fake writer and project row such that a successful reading returns `summary.project_address`. Assert one upsert into `project_pricing_contexts` with:
- workspace/project/file/job IDs
- project `address_text`
- sanitized plan-address evidence
- conflict decision
- no resolved pricing address when conflict exists

Also prove a successful plan reading **does not fail** if no address was found; it persists `missing` or project-only context deterministically.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-service.test.ts --test-name-pattern="pricing address"
```

Expected: FAIL because plan-reading service does not persist pricing context.

### Step 3: implement a narrow persistence helper

In `pricing/context.ts` expose:

```ts
export async function persistPlanPricingContext(input: {
  writer: { from(table: string): any };
  workspaceId: string;
  projectId: string;
  projectAddressText: string | null;
  planAddress: PlanProjectAddressEvidence | null;
  fileId: string;
  jobId: string;
}): Promise<void>;
```

In `AiPlanReadingService.create`, fetch `projects.address_text` instead of only `id`, then call this helper **after** the real result is validated and before returning the terminal job. Do not move pricing calculations into the plan reader.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-service.test.ts apps/api/test/pricing-context.test.ts
```

Expected: PASS.

### Step 5: commit

```bash
git add apps/api/src/ai-plan/service.ts apps/api/src/pricing/context.ts apps/api/test/ai-plan-service.test.ts
git commit -m "feat: persist plan-derived pricing address context"
```

## Task 5 — project pricing-context read/resolve API

**Files**
- Add: `apps/api/src/pricing/routes.ts`
- Add: `apps/api/test/pricing-routes.test.ts`
- Modify: `apps/api/src/http/handler.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED route tests

Required endpoints:

```text
GET   /api/projects/:projectId/pricing-context
PATCH /api/projects/:projectId/pricing-context/address
```

PATCH body:

```json
{ "choice": "plan" }
```

or

```json
{ "choice": "project" }
```

Tests must prove:
- unauthenticated -> 401
- wrong workspace -> 404/403 without leaking existence
- viewer PATCH -> 403
- admin/estimator can resolve
- `choice=plan` fails when no evidenced plan address exists
- `choice=project` fails when project address is missing
- resolved row records `confirmed_override`, `resolved_by`, `resolved_at`

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-routes.test.ts
```

Expected: FAIL because route is not wired.

### Step 3: implement routes

Reuse request authentication/workspace pattern from `projects/routes.ts`. Route handler must always scope reads to both `workspace_id` and `project_id`.

Wire in `apps/api/src/http/handler.ts` before the generic project handler collision point:

```ts
if (/^\/api\/projects\/[^/]+\/pricing-context(?:\/address)?$/.test(pathname)) {
  return handlePricingContextRequest(request, client as unknown as SupabaseLike);
}
```

Add typed web client functions:

```ts
export function getPricingContext(workspaceId: string, projectId: string) { ... }
export function resolvePricingAddress(workspaceId: string, projectId: string, choice: 'plan'|'project') { ... }
```

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/pricing-routes.test.ts
npm run test:api
```

Expected: PASS.

### Step 5: commit

```bash
git add apps/api/src/pricing/routes.ts apps/api/src/http/handler.ts apps/api/test/pricing-routes.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: expose pricing address resolution API"
```

## Task 6 — address conflict UI

**Files**
- Add: `apps/web/app/src/components/PricingAddressCard.tsx`
- Modify: `apps/web/app/src/pages/PlansPage.tsx`
- Add: `apps/web/test/pricing-address-card.test.ts`

### Step 1: RED UI contract test

Test rendered/structural behavior following existing web-test style. Required states:
- clear -> shows pricing address + source
- conflict -> shows both addresses and warning
- conflict -> buttons `Use plan address`, `Keep project address`
- missing -> says pricing cannot start until an address is available
- viewer -> no resolve buttons

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-address-card.test.ts
```

Expected: FAIL because component does not exist.

### Step 3: implement focused component

Do not add more address logic to the already-large `PlansPage.tsx`. `PlansPage` should load/refresh context and pass props into `PricingAddressCard`.

Suggested interface:

```ts
type PricingAddressCardProps = {
  context: PricingContext | null;
  canWrite: boolean;
  onResolve: (choice: 'plan'|'project') => Promise<void>;
};
```

After resolving, refetch server context rather than mutating a local trust decision.

### Step 4: GREEN + build

```bash
node --experimental-strip-types --test apps/web/test/pricing-address-card.test.ts
npm run test:web
npm run build:app
```

Expected: PASS.

### Step 5: commit

```bash
git add apps/web/app/src/components/PricingAddressCard.tsx apps/web/app/src/pages/PlansPage.tsx apps/web/test/pricing-address-card.test.ts
git commit -m "feat: add pricing address conflict review UI"
```

## Task 7 — final verification for Workstream 01

Run fresh:

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Expected: all PASS.

Then manually verify on a non-production test/preview workspace:
1. plan address matches project -> context `clear`
2. plan address differs -> context `needs_resolution`
3. conflicting context cannot be used by `assertPricingAddressResolved`
4. resolving records human provenance
5. no price, labor rate, or client recommendation is generated in this workstream

**Do not apply `0035` to production under this plan.**

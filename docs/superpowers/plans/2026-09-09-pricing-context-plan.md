# RoughBid Pricing Context + Plan Address Implementation Plan

> **Goal:** Make the construction-plan address a durable, evidenced pricing input and block pricing whenever the plan and project addresses conflict.
> **Depends on:** Approved Pricing Intelligence spec only.
> **Production DB:** NOT authorized by this plan. Create/test migration in repo; apply to production only under a later exact migration approval.

## Architecture

The existing plan reader remains an evidence extractor. Extend its structured summary with an optional `project_address` evidence object; do not let the model output pricing. A new `pricing/context.ts` module normalizes this evidence, compares it with `projects.address_text`, and persists one workspace-scoped `project_pricing_contexts` row.

**Trust boundary:** authenticated users may read pricing context, but they must not directly mutate plan evidence, plan/job lineage, or conflict state. Plan evidence is written by the trusted server writer. Human conflict resolution goes through a narrow `SECURITY DEFINER` RPC that validates admin/estimator membership and changes only the resolution fields. Viewers are read-only.

Every later pricing/research service calls `assertPricingAddressResolved()` before any market lookup.

## Task 1 — RED: define and sanitize plan-address evidence

**Files**
- Modify: `apps/api/src/ai-plan/types.ts`
- Modify: `apps/api/src/ai-plan/gemini.ts`
- Modify: `apps/api/test/ai-plan-gemini.test.ts`
- Add: `apps/api/test/ai-plan-address.test.ts`

### Step 1: write failing sanitizer tests

Add:

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

Also assert address evidence is dropped when its page is invalid or `source_excerpt` is missing, with a limitation recorded rather than an invented value.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-address.test.ts
```

Expected: FAIL because `project_address` is not part of `PlanReadingSummary`.

### Step 3: implement the type/sanitizer

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

Add `project_address?: PlanProjectAddressEvidence` to `PlanReadingSummary`. Sanitization must:
- require physical page `1..sheet_count`
- require non-empty verbatim `source_excerpt`
- clamp confidence to `0.1..1`
- cap strings to safe lengths
- permit missing components such as ZIP/unit
- return `undefined` when evidence identity is invalid

### Step 4: extend Gemini output schema

Add prompt text:

```text
Extract the project/site address from a cover sheet, title block, permit information,
or project information when visibly supported. Include physical page number and a
verbatim source excerpt. Never infer or fabricate an address. This is evidence only;
do not output prices, rates, construction costs, margins, or invented labor.
```

Preserve the existing no-money invariant.

### Step 5: GREEN

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-address.test.ts apps/api/test/ai-plan-gemini.test.ts
```

### Step 6: commit

```bash
git add apps/api/src/ai-plan/types.ts apps/api/src/ai-plan/gemini.ts apps/api/test/ai-plan-address.test.ts apps/api/test/ai-plan-gemini.test.ts
git commit -m "feat: extract evidenced project address from plans"
```

## Task 2 — RED: durable pricing-context schema + protected resolution RPC

**Files**
- Add: `supabase/migrations/0035_pricing_context.sql`
- Add: `supabase/test/pricing-context.test.mjs`

### Step 1: write failing schema/security tests

Require:

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

Constraints:
- `resolved_by` and `resolved_at` are both null or both non-null
- `needs_resolution` must have `pricing_address is null`
- `resolved` requires `pricing_address`, `resolved_by`, and `resolved_at`

Security tests must prove:
- member SELECT allowed through RLS
- authenticated direct INSERT/UPDATE/DELETE is not granted
- plan evidence can only be written via service-role/trusted server path
- resolution RPC checks admin/estimator and project/workspace membership
- viewer cannot resolve
- RPC can update only `pricing_address`, `address_source`, `address_status`, `resolved_by`, `resolved_at`, `updated_at`; it cannot rewrite `plan_address`, `plan_file_id`, or `plan_job_id`

### Step 2: RED

```bash
node --test supabase/test/pricing-context.test.mjs
```

Expected: FAIL because `0035` does not exist.

### Step 3: implement RLS + narrow RPC

```sql
alter table public.project_pricing_contexts enable row level security;

create policy project_pricing_contexts_select_member
on public.project_pricing_contexts for select to authenticated
using (
  private.has_workspace_role(workspace_id, array['admin','estimator','viewer'])
  and private.has_product_access()
);

revoke insert, update, delete on public.project_pricing_contexts from authenticated, anon;
```

Create:

```sql
public.resolve_project_pricing_address(p_project_id uuid, p_choice text)
```

The `SECURITY DEFINER` RPC must:
1. require `auth.uid()`
2. lock the context row `FOR UPDATE`
3. derive its workspace from the row, never from a client-provided workspace
4. require `private.has_workspace_role(workspace_id, array['admin','estimator'])`
5. accept only `plan` or `project`
6. reject `plan` when no valid plan evidence exists
7. reject `project` when `project_address_text` is empty
8. update resolution fields only
9. stamp `auth.uid()` and `now()`

Revoke function execution from `public, anon`; grant to `authenticated`.

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/pricing-context.test.mjs
```

**Production safety:** this task creates/tests `0035` only. Do not run a blanket migration command; repo migrations `0023`-`0025` are unrelated/deferred.

### Step 5: commit

```bash
git add supabase/migrations/0035_pricing_context.sql supabase/test/pricing-context.test.mjs
git commit -m "feat: add protected project pricing context"
```

## Task 3 — RED: deterministic address comparison + fail-closed gate

**Files**
- Add: `apps/api/src/pricing/context.ts`
- Add: `apps/api/test/pricing-context.test.ts`

### Step 1: RED tests

```ts
assert.equal(comparePricingAddresses(plan, null).status, 'clear');
assert.equal(comparePricingAddresses(null, '12 Main St, Needham, MA 02492').source, 'project');
assert.equal(comparePricingAddresses(planNeedham, '12 MAIN STREET, Needham MA 02492').status, 'clear');
assert.equal(comparePricingAddresses(planNeedham, '52 Main St, Needham, MA 02492').status, 'needs_resolution');
assert.equal(comparePricingAddresses(planNeedham, '12 Main St, Needham, MA 02108').status, 'needs_resolution');
assert.throws(() => assertPricingAddressResolved({ address_status: 'needs_resolution' } as any), /resolve/i);
```

Fail-closed decisions:
- plan only -> plan is pricing address
- project only -> project is pricing address
- neither -> `missing`
- both provably same after deterministic normalization -> `clear`
- both present but not provably same -> `needs_resolution`

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-context.test.ts
```

### Step 3: implement pure functions

```ts
export type PricingAddressStatus = 'missing' | 'clear' | 'needs_resolution' | 'resolved';
export type PricingAddressSource = 'plan' | 'project' | 'confirmed_override';

export function normalizeAddressText(value: string): string;
export function comparePricingAddresses(plan: PlanProjectAddressEvidence | null, projectAddress: string | null): PricingAddressDecision;
export function assertPricingAddressResolved(context: { address_status: PricingAddressStatus; pricing_address?: unknown }): void;
```

Normalize case, punctuation, whitespace, and common street suffix tokens only. Do not call AI/geocoding to decide the authorization boundary.

### Step 4: GREEN + commit

```bash
node --experimental-strip-types --test apps/api/test/pricing-context.test.ts
git add apps/api/src/pricing/context.ts apps/api/test/pricing-context.test.ts
git commit -m "feat: add fail-closed pricing address resolution"
```

## Task 4 — persist trusted plan evidence after successful reading

**Files**
- Modify: `apps/api/src/ai-plan/service.ts`
- Modify: `apps/api/src/pricing/context.ts`
- Modify: `apps/api/test/ai-plan-service.test.ts`

### Step 1: RED service tests

A successful reading with `summary.project_address` must upsert via the existing trusted `findingsWriter`/service-role path and record:
- workspace/project/file/job IDs
- current `projects.address_text`
- sanitized plan evidence
- deterministic conflict decision
- `pricing_address=null` when `needs_resolution`

A successful reading with no plan address must still persist a deterministic project-only or missing context. A human-resolved context must not be silently overwritten back to plan/project on an unrelated reread unless a materially new conflicting plan address is observed; in that case mark `needs_resolution` and preserve audit lineage rather than trust stale resolution.

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-service.test.ts --test-name-pattern="pricing address"
```

### Step 3: implement helper

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

In `AiPlanReadingService.create`, fetch `projects.address_text` in the existing project lookup and call this helper only after the real reading result passes validation. Never add pricing calculations to the plan reader.

### Step 4: GREEN + commit

```bash
node --experimental-strip-types --test apps/api/test/ai-plan-service.test.ts apps/api/test/pricing-context.test.ts
git add apps/api/src/ai-plan/service.ts apps/api/src/pricing/context.ts apps/api/test/ai-plan-service.test.ts
git commit -m "feat: persist plan-derived pricing address context"
```

## Task 5 — pricing-context read/resolve API

**Files**
- Add: `apps/api/src/pricing/routes.ts`
- Add: `apps/api/test/pricing-routes.test.ts`
- Modify: `apps/api/src/http/handler.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED route tests

Endpoints:

```text
GET   /api/projects/:projectId/pricing-context
PATCH /api/projects/:projectId/pricing-context/address
```

PATCH body is only:

```json
{ "choice": "plan" }
```

or

```json
{ "choice": "project" }
```

Prove:
- unauthenticated -> 401
- wrong workspace -> 404/403 without existence leak
- viewer PATCH -> 403
- admin/estimator can resolve
- plan choice without evidenced plan address -> 409/400
- project choice without project address -> 409/400
- direct request cannot supply/overwrite arbitrary `pricing_address`, `plan_address`, job/file ID, resolver ID, or status
- returned resolved row is read back from DB after the RPC

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/pricing-routes.test.ts
```

### Step 3: implement routes

GET uses workspace-scoped SELECT. PATCH must call `resolve_project_pricing_address`; do **not** construct a generic client-controlled table update.

Wire before generic project handling:

```ts
if (/^\/api\/projects\/[^/]+\/pricing-context(?:\/address)?$/.test(pathname)) {
  return handlePricingContextRequest(request, client as unknown as SupabaseLike);
}
```

Web client:

```ts
getPricingContext(workspaceId, projectId)
resolvePricingAddress(workspaceId, projectId, choice: 'plan'|'project')
```

### Step 4: GREEN + commit

```bash
node --experimental-strip-types --test apps/api/test/pricing-routes.test.ts
npm run test:api
git add apps/api/src/pricing/routes.ts apps/api/src/http/handler.ts apps/api/test/pricing-routes.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: expose protected pricing address resolution API"
```

## Task 6 — address conflict UI

**Files**
- Add: `apps/web/app/src/components/PricingAddressCard.tsx`
- Modify: `apps/web/app/src/pages/PlansPage.tsx`
- Add: `apps/web/test/pricing-address-card.test.ts`

### Step 1: RED UI tests

Required states:
- clear -> pricing address + source
- conflict -> plan address and project address + warning
- conflict -> `Use plan address` and `Keep project address`
- missing -> pricing unavailable until address exists
- viewer -> no mutation controls

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/pricing-address-card.test.ts
```

### Step 3: implement focused component

```ts
type PricingAddressCardProps = {
  context: PricingContext | null;
  canWrite: boolean;
  onResolve: (choice: 'plan'|'project') => Promise<void>;
};
```

Keep address logic out of the already-large `PlansPage.tsx`. After a resolution call, refetch server context; never locally invent trusted status.

### Step 4: GREEN + commit

```bash
node --experimental-strip-types --test apps/web/test/pricing-address-card.test.ts
npm run test:web
npm run build:app
git add apps/web/app/src/components/PricingAddressCard.tsx apps/web/app/src/pages/PlansPage.tsx apps/web/test/pricing-address-card.test.ts
git commit -m "feat: add pricing address conflict review UI"
```

## Task 7 — final Workstream 01 verification

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Preview checks:
1. matching plan/project address -> `clear`
2. materially different addresses -> `needs_resolution`
3. unresolved context is rejected by `assertPricingAddressResolved`
4. resolution records human provenance via RPC
5. viewer cannot resolve
6. direct authenticated table mutation cannot rewrite plan evidence
7. no material/labor/client pricing is generated in this workstream

**Do not apply `0035` to production under this plan.**

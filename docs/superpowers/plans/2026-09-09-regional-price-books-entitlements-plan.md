# RoughBid Official Regional Price Books + Entitlements Implementation Plan

> **Goal:** Add official, versioned RoughBid regional price books and workspace-scoped access rules before any Stripe checkout exists.
> **Depends on:** Workstreams 01-02.
> **Billing:** This plan models entitlement states only. It does NOT create Stripe products/prices/checkouts.
> **Production DB:** NOT authorized by this plan.

## Architecture

Regional Price Books are proprietary RoughBid data. V1 has no third-party sellers. Store a catalog, immutable published versions, versioned items, workspace free-region settings, and workspace entitlements. Read access always passes through server-side entitlement resolution; the client never receives an entire locked book merely because it knows a book/version ID.

Free-region selection/change must be atomic in Postgres so two concurrent requests cannot grant multiple free regions.

## Task 1 — RED: regional catalog/version schema

**Files**
- Add: `supabase/migrations/0037_regional_price_books_entitlements.sql`
- Add: `supabase/test/regional-price-books-entitlements.test.mjs`

### Step 1: write failing schema tests

Require:

```sql
create table public.regional_price_books (
  id uuid primary key default gen_random_uuid(),
  region_code text not null unique,
  name text not null,
  description text,
  status text not null check (status in ('draft','active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.regional_price_book_versions (
  id uuid primary key default gen_random_uuid(),
  price_book_id uuid not null references public.regional_price_books(id) on delete restrict,
  version_label text not null,
  effective_at timestamptz not null,
  published_at timestamptz,
  status text not null check (status in ('draft','published','retired')),
  methodology_version text not null,
  created_at timestamptz not null default now(),
  unique (price_book_id, version_label)
);

create table public.regional_price_book_items (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.regional_price_book_versions(id) on delete restrict,
  item_key text not null,
  name text not null,
  category text not null check (category in ('material','labor','equipment','other')),
  unit text not null,
  low_rate numeric(14,6),
  typical_rate numeric(14,6) not null,
  high_rate numeric(14,6),
  confidence numeric(4,3) not null,
  source_lineage jsonb not null default '[]'::jsonb,
  unique (version_id, item_key, category, unit)
);
```

Constraints must ensure non-negative rates and `low <= typical <= high` when bounds exist.

RLS/security:
- authenticated customer users do **not** receive general SELECT rights to proprietary item tables
- catalog metadata for `active` books can be exposed through a server API
- service-role/admin publishing path owns writes

### Step 2: RED

```bash
node --test supabase/test/regional-price-books-entitlements.test.mjs
```

Expected: FAIL.

### Step 3: implement catalog schema

Do not seed fictional customer prices in this migration. Test fixtures may insert clearly labeled synthetic values inside tests only.

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/regional-price-books-entitlements.test.mjs
```

### Step 5: commit

```bash
git add supabase/migrations/0037_regional_price_books_entitlements.sql supabase/test/regional-price-books-entitlements.test.mjs
git commit -m "feat: add versioned regional price book catalog"
```

## Task 2 — RED: workspace free-region state and atomic selection RPC

**Files**
- Modify: `supabase/migrations/0037_regional_price_books_entitlements.sql`
- Modify: `supabase/test/regional-price-books-entitlements.test.mjs`

### Step 1: add failing tests for approved free-region rules

Schema:

```sql
create table public.workspace_regional_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  free_price_book_id uuid references public.regional_price_books(id) on delete restrict,
  free_selected_at timestamptz,
  free_change_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Entitlements:

```sql
create table public.workspace_regional_entitlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  price_book_id uuid not null references public.regional_price_books(id) on delete restrict,
  entitlement_type text not null check (entitlement_type in ('free','monthly','one_time')),
  status text not null check (status in ('active','canceled','expired','revoked')),
  starts_at timestamptz not null default now(),
  access_ends_at timestamptz,
  update_access_until timestamptz,
  retained_version_id uuid references public.regional_price_book_versions(id) on delete restrict,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Tests for RPC `public.select_free_regional_price_book(p_workspace_id, p_price_book_id)`:
1. admin first selection succeeds
2. estimator/viewer cannot select
3. same-book retry is idempotent
4. one change within 30 days succeeds and records `free_change_used_at`
5. second change fails
6. first change after 30 days fails
7. concurrent selection cannot leave two active `free` entitlements
8. locked/draft/retired catalog book cannot be selected

### Step 2: RED

```bash
node --test supabase/test/regional-price-books-entitlements.test.mjs
```

### Step 3: implement atomic RPC

Use row locking on `workspace_regional_settings` and validate `private.has_workspace_role(p_workspace_id, array['admin'])`.

Conceptual transaction logic:

```sql
select * into settings
from public.workspace_regional_settings
where workspace_id = p_workspace_id
for update;

-- first selection: create settings + active free entitlement
-- change: require now() <= free_selected_at + interval '30 days'
--         require free_change_used_at is null
--         deactivate old free entitlement, activate new free entitlement
-- same book: return current entitlement without consuming the change
```

Create a partial unique index preventing more than one active free entitlement:

```sql
create unique index one_active_free_region_per_workspace
on public.workspace_regional_entitlements(workspace_id)
where entitlement_type = 'free' and status = 'active';
```

### Step 4: GREEN

```bash
npm run db:validate
node --test supabase/test/regional-price-books-entitlements.test.mjs
```

### Step 5: commit

```bash
git add supabase/migrations/0037_regional_price_books_entitlements.sql supabase/test/regional-price-books-entitlements.test.mjs
git commit -m "feat: enforce one free regional price book"
```

## Task 3 — RED: monthly and one-time entitlement semantics without Stripe

**Files**
- Add: `apps/api/src/pricing/regional-entitlements.ts`
- Add: `apps/api/test/regional-entitlements.test.ts`

### Step 1: write failing pure/service tests

Public resolver:

```ts
export type RegionalEntitlement = {
  type: 'free' | 'monthly' | 'one_time';
  status: 'active' | 'canceled' | 'expired' | 'revoked';
  startsAt: Date;
  accessEndsAt: Date | null;
  updateAccessUntil: Date | null;
  retainedVersionId: string | null;
};

export function resolveRegionalVersionAccess(input: {
  entitlement: RegionalEntitlement;
  requestedVersion: RegionalBookVersion;
  latestPublishedVersion: RegionalBookVersion;
  at: Date;
}): { allowed: boolean; versionId: string | null; updatesAllowed: boolean };
```

Required tests:
- free active entitlement can use current published version
- monthly active can use current version while active
- canceled/expired monthly cannot use new requests after access end
- one-time purchase has permanent access
- one-time purchase receives newer versions only through `updateAccessUntil`
- after 12-month update window, it resolves to `retainedVersionId`
- estimates referencing an older historical version may still read their own snapshot even after entitlement expires (handled via snapshot API, not normal marketplace browsing)

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/regional-entitlements.test.ts
```

### Step 3: implement fail-closed resolver

No Stripe SDK import belongs in this module. `external_ref` is opaque future billing provenance only.

One-time rule:

```ts
if (entitlement.type === 'one_time') {
  if (at <= entitlement.updateAccessUntil!) return { allowed: true, versionId: latest.id, updatesAllowed: true };
  return { allowed: Boolean(entitlement.retainedVersionId), versionId: entitlement.retainedVersionId, updatesAllowed: false };
}
```

Validate missing timestamps rather than assuming access.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/regional-entitlements.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/regional-entitlements.ts apps/api/test/regional-entitlements.test.ts
git commit -m "feat: model regional book entitlement lifecycles"
```

## Task 4 — server-side proprietary-book reader

**Files**
- Add: `apps/api/src/pricing/regional-price-books.ts`
- Add: `apps/api/test/regional-price-books.test.ts`

### Step 1: RED tests

Service methods:

```ts
class RegionalPriceBookService {
  listCatalog(): Promise<RegionalBookCatalogEntry[]>;
  getWorkspaceAccess(): Promise<WorkspaceRegionalAccess[]>;
  selectFreeBook(priceBookId: string): Promise<WorkspaceRegionalAccess>;
  resolveItem(input: { priceBookId: string; itemKey: string; category: PriceCategory; unit: string }): Promise<RegionalPriceObservation | null>;
}
```

Tests prove:
- locked workspace cannot resolve items from a book just by guessing ID
- active entitlement resolves only its authorized version
- draft version never resolves to customer
- source lineage remains server/internal metadata
- returned observation includes region, version, effective date, confidence, but does not expose unrelated book rows

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/regional-price-books.test.ts
```

### Step 3: implement with explicit entitlement check

Always scope entitlement by `workspace_id + price_book_id`. Resolve entitlement **before** querying item rows.

Suggested observation:

```ts
export type RegionalPriceObservation = {
  sourceType: 'regional_book';
  priceBookId: string;
  versionId: string;
  regionCode: string;
  itemKey: string;
  category: PriceCategory;
  unit: string;
  lowRate: string | null;
  typicalRate: string;
  highRate: string | null;
  effectiveAt: string;
  confidence: number;
};
```

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/regional-price-books.test.ts apps/api/test/regional-entitlements.test.ts
```

### Step 5: commit

```bash
git add apps/api/src/pricing/regional-price-books.ts apps/api/test/regional-price-books.test.ts
git commit -m "feat: authorize regional price book reads"
```

## Task 5 — catalog/free-region API

**Files**
- Modify: `apps/api/src/pricing/routes.ts`
- Modify: `apps/api/src/http/handler.ts`
- Add: `apps/api/test/regional-price-book-routes.test.ts`
- Modify: `apps/web/app/src/services/api.ts`

### Step 1: RED route tests

Endpoints:

```text
GET  /api/pricing/regional-books
GET  /api/pricing/regional-books/access
POST /api/pricing/regional-books/free-selection
```

`GET /regional-books` returns catalog metadata + `locked/unlocked` summary but **not proprietary item tables**.

`POST /free-selection` body:

```json
{ "priceBookId": "..." }
```

Tests:
- admin can choose first free book
- estimator/viewer cannot change free selection
- estimator/viewer can see workspace access metadata
- one allowed 30-day change works
- second change returns 409/403 with stable message
- arbitrary item/book access is never leaked by catalog route

### Step 2: RED

```bash
node --experimental-strip-types --test apps/api/test/regional-price-book-routes.test.ts
```

### Step 3: implement routes and client functions

Web client functions:

```ts
listRegionalPriceBooks(workspaceId)
getRegionalBookAccess(workspaceId)
selectFreeRegionalPriceBook(workspaceId, priceBookId)
```

Do not add purchase/checkout endpoints in this workstream.

### Step 4: GREEN

```bash
node --experimental-strip-types --test apps/api/test/regional-price-book-routes.test.ts
npm run test:api
```

### Step 5: commit

```bash
git add apps/api/src/pricing/routes.ts apps/api/src/http/handler.ts apps/api/test/regional-price-book-routes.test.ts apps/web/app/src/services/api.ts
git commit -m "feat: expose regional price book catalog and free selection"
```

## Task 6 — Marketplace UI for official books only

**Files**
- Add or modify: `apps/web/app/src/pages/PriceMarketplacePage.tsx`
- Modify: `apps/web/app/src/App.tsx`
- Add: `apps/web/test/regional-price-marketplace.test.ts`

### Step 1: RED UI tests

Required rendering:
- official RoughBid badge/status only; no third-party seller controls
- current free region clearly marked `FREE / ACTIVE`
- locked regions show future `Monthly` and `One-time` access options as unavailable/coming after billing gate, not fake checkout buttons
- admin sees free-selection/change action
- estimator sees books but cannot alter free selection
- show whether the single free change is still available and its deadline
- one-time entitlement state shows `Updates through <date>` and retained version after expiry when test fixture provides it

### Step 2: RED

```bash
node --experimental-strip-types --test apps/web/test/regional-price-marketplace.test.ts
```

### Step 3: implement

Do not display exact paid prices yet; those are intentionally undecided. Use copy such as `Paid access not yet activated` rather than `$TBD`.

### Step 4: GREEN + build

```bash
node --experimental-strip-types --test apps/web/test/regional-price-marketplace.test.ts
npm run test:web
npm run build:app
```

### Step 5: commit

```bash
git add apps/web/app/src/pages/PriceMarketplacePage.tsx apps/web/app/src/App.tsx apps/web/test/regional-price-marketplace.test.ts
git commit -m "feat: add official regional price book marketplace UI"
```

## Task 7 — reconcile legacy marketplace docs

**Files**
- Modify: `docs/architecture/new-england-ml-price-marketplace.md`
- Modify: `docs/integrations/billing-marketplace.md`

Update legacy planning docs so they do not contradict the approved spec:
- V1 marketplace is RoughBid-official books only
- one free region per workspace + one change in 30 days
- both monthly and one-time access are planned
- one-time updates last 12 months
- exact paid prices are not approved yet
- old `$19/$29` regional/labor add-on proposals are not production pricing decisions

Commit:

```bash
git add docs/architecture/new-england-ml-price-marketplace.md docs/integrations/billing-marketplace.md
git commit -m "docs: align marketplace notes with approved regional book model"
```

## Task 8 — final Workstream 03 verification

```bash
npm run test:domain
npm run test:api
npm run test:web
npm run db:validate
npm run build
```

Manual preview verification with synthetic catalog fixtures:
1. admin selects exactly one free region
2. same-region retry is idempotent
3. one change inside 30 days succeeds
4. second change is rejected atomically
5. estimator can use but cannot administer workspace regional access
6. locked region contents cannot be fetched by ID guessing
7. one-time post-update-expiry state retains last entitled version
8. no Stripe checkout/product/price is created or called

**Do not apply `0037` to production under this plan.**

# RoughBid

RoughBid is a tenant-isolated estimating platform backed by Supabase. Authentication,
workspace RBAC, and secure 60-day Class Pass provisioning are documented in
[`docs/integrations/auth-access.md`](docs/integrations/auth-access.md).

## Layout

- `apps/web/` — static marketing landing page, plus the product app at `apps/web/app/` (served at `/app/`).
- `apps/api/` — backend logic (framework-neutral `Request` → `Response` handlers).
- `api/` — the Vercel Edge Function that actually mounts `apps/api` at `/api/*` in production (`api/[...path].ts` → `apps/api/src/http/handler.ts`).
- `packages/domain/` — shared, dependency-free business logic (estimate math, auth/workspace types) used by both `apps/api` and `apps/web/app`.
- `supabase/` — migrations, RLS policies, and Auth/Storage policies. Source of truth for the database shape.

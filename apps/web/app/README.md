# apps/web/app — RoughBid application

The full RoughBid product experience (dashboard, plans, quantities, estimate
editor, review, export) as a React + Vite SPA. It's served at `/app/`,
alongside the static marketing landing page that already lives at the root of
`apps/web/`.

Originally delivered by Bruno as `roughbid V2.zip` and merged into this
monorepo. Source of the deliverable: e-mail thread "ROUGHbid — visão do
produto e direção de frontend".

## Running locally

From the repo root:

```
npm install
npm run dev:app     # vite dev server for this app
npm run build:app   # builds into ../../../dist/app (also runs as part of `npm run build`)
```

## Auth: real, backend: real — most screens: still mock

Sign-in is real Supabase Auth (magic link, `src/services/supabaseClient.ts` +
`src/components/AuthModal.tsx`). When `VITE_SUPABASE_URL` /
`VITE_SUPABASE_PUBLISHABLE_KEY` aren't set (e.g. a fresh clone with no `.env`),
the app runs in a clearly-labeled demo mode instead of a broken login form —
no key or password is required to browse it.

Once signed in, `App.tsx` calls the real backend (`GET /api/auth/bootstrap`,
`GET`/`POST /api/workspaces`) to resolve or create the user's workspace. New
projects are also mirrored to the real backend (`POST /api/projects`) on a
best-effort basis. All of that goes through `/api/*`, which now actually
exists — see `/api/[...path].ts` at the repo root and
`apps/api/src/http/handler.ts`.

Every *screen* (plans, quantities, materials, estimate line items) still
reads and writes through `src/utils/storage.ts`, a deterministic
`localStorage`-backed mock. That's deliberate, not a shortcut: the real
`projects` table doesn't yet carry the full plans/quantities/estimate-items
shape this UI works with, so swapping it in now would either invent backend
fields that don't exist or break the working demo. `src/services/api.ts` is
the single place that talks to the backend — see the `TODO(joshua-backend)`
markers there and in `storage.ts` for exactly what widening the backend
contract would take.

The estimate math itself (`src/utils/calculations.ts`) already calls the same
fixed-point engine the backend exposes at `POST /api/estimates/recalculate`
(`packages/domain/src/calculation.ts`), so totals match the backend exactly.

## Not in scope here

Real payments and document upload/processing UI are
still unbuilt on the frontend even though their backend/DB pieces now exist
(see `supabase/migrations/`). `packages/domain/**` changes still need review
from both owners per `docs/OWNERSHIP.md`.

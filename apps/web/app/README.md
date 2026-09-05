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

## Auth: required; backend: partially live

Sign-in is real Supabase Auth (magic link, `src/services/supabaseClient.ts` +
`src/components/AuthGate.tsx`). `/app/` is not accessible without a session.
When `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` aren't set, the
login gate stays closed and tells the operator that auth must be configured.

Once signed in, `App.tsx` calls the real backend (`GET /api/auth/bootstrap`,
`GET`/`POST /api/workspaces`) to resolve or create the user's workspace. New
projects are also mirrored to the real backend (`POST /api/projects`) on a
best-effort basis. All of that goes through `/api/*`, which now actually
exists — see `/api/[...path].ts` at the repo root and
`apps/api/src/http/handler.ts`.

The UI-first estimating screens still keep some rich editable state in
`src/utils/storage.ts` after login while the backend contract is widened for
full plans, quantities, assemblies, and estimate line items. The app must not
claim server persistence for fields the API does not yet store. `src/services/api.ts`
is the single place that talks to the backend.

The estimate math itself (`src/utils/calculations.ts`) already calls the same
fixed-point engine the backend exposes at `POST /api/estimates/recalculate`
(`packages/domain/src/calculation.ts`), so totals match the backend exactly.

## Not in scope here

Real Stripe checkout prices remain disabled until approved live price IDs are
configured. `packages/domain/**` changes still need review from both owners
per `docs/OWNERSHIP.md`.

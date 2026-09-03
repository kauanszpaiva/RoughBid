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

## Data: mock today, real backend next

Every screen currently reads and writes through `src/utils/storage.ts`, a
deterministic `localStorage`-backed mock — there is no `.env`, key, or
password required to run this app locally, and it never pretends a save
reached a server that isn't wired up yet.

`src/services/api.ts` is the single place that will talk to the real backend
(`apps/api`) once this app carries a real Supabase session and workspace id.
It implements the agreed contract (`GET /api/health`, `GET`/`POST
/api/projects`, `GET`/`PATCH /api/projects/:id`, `POST
/api/estimates/recalculate`) behind `VITE_API_BASE_URL` — see the `.env.example`
at the repo root. When that variable is unset, every call throws
`ApiNotConfiguredError` so callers know to fall back to the mock instead of
faking success.

The estimate math itself (`src/utils/calculations.ts`) already calls the same
fixed-point engine the backend exposes at `POST /api/estimates/recalculate`
(`packages/domain/src/calculation.ts`), so totals match the backend exactly
ahead of that network call being wired up.

## Not in scope here

Per the brief this app shipped under: no changes to `apps/api/**`,
`supabase/**`, real authentication, Vercel, or the database. Those stay
Joshua's/backend's responsibility — see the `TODO(joshua-backend)` markers in
`src/utils/storage.ts` and `src/services/api.ts` for exactly where this app
is ready to be connected.

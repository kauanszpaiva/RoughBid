# Ownership and collision policy

## Bruno — Frontend
Primary paths: `apps/web/**`, `packages/ui/**`.
Bruno can move quickly on layout, UX, responsive states, content presentation and UI primitives without editing backend implementation.

## Kauan — Backend / data / platform
Primary paths: `apps/api/**`, `supabase/**`, deployment/runtime configuration and server-only integrations.

## Shared contract
`packages/domain/**` is the only intentional seam. Changes here must be treated as API-contract changes and reviewed before either side depends on them.

## Branch model
- Bruno: `feat/frontend-*`
- Kauan/backend: `feat/backend-*`, `feat/data-*`, `feat/platform-*`
- No direct feature work on `main`.
- Merge via PR after tests.

## Secret boundary
No service-role, Stripe secret, Resend API key, webhook secret or private runtime credential may exist under `apps/web/**` or be committed anywhere.

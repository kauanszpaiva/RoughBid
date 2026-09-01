# RoughBid Foundation Design

Status: approved working codename; final brand remains open.

## Goal
Build a KSP Ventures-owned construction-estimating SaaS as a monorepo that lets nontechnical users move from plans/PDFs to quantities, costs, overhead, markup, margin, estimate totals, and export. Prime Bid class participants receive a fixed 60-day Class Pass with no card. Paid users subscribe separately through Stripe.

## Ownership boundaries
- `apps/web/**`: Bruno — frontend, UX, responsive UI, public landing, authenticated UI.
- `apps/api/**`: Kauan — backend HTTP endpoints and server-only integrations.
- `supabase/**`: Kauan — schema, migrations, RLS, Auth policies, Storage policies, webhook state.
- `packages/domain/**`: shared contract surface. Changes require review from both owners.
- `packages/ui/**`: Bruno owns reusable presentational primitives.
- `.github/**`, root configs, deployment files: platform ownership; changes via PR.

## Initial vertical slice
1. Public landing page.
2. Supabase Auth foundation.
3. Project record + estimate draft model.
4. Class Pass entitlement independent of Stripe.
5. Stripe Billing architecture prepared for hosted Checkout + Customer Portal; no price created until approved.
6. Resend transactional template foundation.
7. AI excluded from critical path for v0.

## Monorepo architecture
Use npm workspaces with TypeScript. `apps/web` is a Next.js app deployable to Vercel. `apps/api` is a small server package for server-only endpoints and Stripe webhook logic. `packages/domain` contains schemas/types shared by UI and backend. Supabase migrations are source-of-truth for database shape and RLS.

## Data/security invariants
- Every business record is owned by a user or organization and protected by RLS.
- No service-role key reaches client code.
- No raw payment credentials are stored.
- Stripe subscription state is mirrored from signed webhooks, not trusted from client callbacks.
- Class Pass entitlement has explicit `starts_at` and `expires_at` and never auto-creates a Stripe subscription.
- Storage for plans is private by default.

## UX direction
Blue/white blueprint-inspired visual language, clean and instructional rather than AI-futuristic. Primary flow language should be plain English: Plans → Quantities → Estimate → Export.

## Landing page
The public landing communicates: construction estimating made understandable, classroom access for Prime Bid students, future paid subscription, and a coming AI-assist layer without claiming AI is active today.

## Deployment
- Supabase: separate project in us-east-1.
- Vercel: preview-first deployment of `apps/web`.
- Resend: use existing verified KSP sending domain until final product domain is approved.
- Stripe: official LIVE account architecture only; no charges, products, or prices until commercial approval.

## Acceptance criteria for foundation
- Monorepo installs and builds.
- Landing page renders on desktop/mobile without runtime errors.
- Ownership boundaries are encoded in CODEOWNERS.
- Domain tests cover the 60-day Class Pass and estimate math.
- Supabase migration enables RLS and policies for initial tables.
- No secrets committed.
- Stripe/Resend integrations are documented and staged without customer sends or charges.

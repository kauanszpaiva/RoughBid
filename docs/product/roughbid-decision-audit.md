# RoughBid Decision Audit

Last reviewed: 2026-09-04

This file tracks the product decisions from the owner conversation against the current codebase.

## Required Direction

- RoughBid is an independent SaaS, not PrimeBid and not tied to a class-pass or 60-day program.
- The public landing page is the first screen at `/`.
- The product app is under `/app/` and requires login before any workspace access.
- Client proposal links under `/proposal/:token` are public so a client can view and sign without creating an account.
- Each organization, user, project, estimate, file, proposal, credit ledger, and sensitive-data event must stay tenant/project scoped.
- Resend powers organization invite and proposal notification email flows from server-side credentials only.
- Supabase Auth is the login system. Supabase RLS protects workspace data.
- Stripe pricing is staged but checkout remains blocked until approved live price IDs are configured.
- The app must focus on simple construction estimating, especially plan reading for people without plan-reading experience.
- Plans should support zoom, drag/pan, beginner callouts, and clear explanations.
- The future remodel intake path for photo, video, and audio should remain prepared but visibly marked as future work until processing, consent, storage, privacy, and cost gates are complete.
- Mobile and tablet layouts must be usable, not just desktop layouts squeezed down.
- Legal/privacy/data-use/acceptable-use pages are operational drafts and require legal review before broad commercial use.

## Current Code Coverage

- Landing and app routing: `scripts/build.mjs`, `vercel.json`, `apps/web/index.html`, `apps/web/test/app-routing.test.ts`.
- Login gate: `apps/web/app/src/App.tsx`, `apps/web/app/src/components/AuthGate.tsx`, `apps/web/test/auth-gate.test.ts`.
- Organization invites: `apps/web/app/src/components/AuthModal.tsx`, `apps/api/src/workspaces/routes.ts`, `apps/api/src/email/resend.ts`.
- Client view and open/sign notifications: `apps/web/app/src/pages/ExportPage.tsx`, `apps/web/app/src/pages/ClientProposalPage.tsx`, `apps/api/src/proposals/routes.ts`, `supabase/migrations/0008_client_proposals.sql`, `supabase/migrations/0009_public_client_proposal_links.sql`.
- Tenant isolation and RLS: `supabase/migrations/0001_foundation.sql`, `supabase/migrations/0011_tenant_project_isolation.sql`, related tests under `supabase/test/`.
- Full project UI state persistence: `supabase/migrations/0013_project_app_state.sql`.
- Pricing and margin rules: `packages/domain/src/billing.ts`, `packages/domain/test/billing.test.ts`.
- AI plan-reading architecture: `docs/architecture/ai-plan-reading-pipeline.md`, `apps/api/src/ai-plan/`, `apps/web/app/src/components/BlueprintViewer.tsx`.
- Mobile/tablet layout protections: `apps/web/test/responsive-layout.test.ts`.

## Known Boundaries

- The frontend keeps rich editable estimate/project UI state locally after login while the backend schema is widened for full plan, quantity, assembly, and estimate-line persistence.
- AI plan reading requires configured runtime credentials, document storage, Redis/job infrastructure, and estimator review.
- Stripe products/prices must not be made chargeable without owner approval.
- Public policy pages are drafts, not legal advice.

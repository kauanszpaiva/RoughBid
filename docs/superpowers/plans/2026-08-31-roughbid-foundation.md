# RoughBid Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable RoughBid monorepo foundation with isolated frontend/backend ownership, a public landing page, deterministic estimating contracts, Supabase schema/RLS, and staged Resend/Stripe integration surfaces.

**Architecture:** npm workspaces. Next.js frontend in `apps/web`, server-only integration package in `apps/api`, shared business rules in `packages/domain`, Supabase migrations in `supabase/migrations`. Vercel deploys the web workspace; Stripe and Resend stay behind server-only boundaries.

**Tech Stack:** TypeScript, Next.js, React, Vitest, Zod, Supabase Postgres/Auth/Storage, Stripe Billing/Checkout, Resend.

**Spec:** `docs/superpowers/specs/2026-08-31-roughbid-foundation-design.md`

## Global Constraints
- Working codename: RoughBid; final brand remains open.
- Bruno owns `apps/web/**` and `packages/ui/**`.
- Kauan owns `apps/api/**` and `supabase/**`.
- Shared `packages/domain/**` requires cross-review.
- Workspace access grants are independent of Stripe and use configured access windows.
- No Stripe product/price/charge until commercial approval.
- No AI dependency in the initial critical path.
- No secrets committed.

---

### Task 1: Monorepo contracts and ownership
**Files:** root workspace files, `packages/domain/**`, `.github/CODEOWNERS`.
**Interfaces:** produces `calculateEstimate()` and `createAccessWindow()`.
- [ ] Write failing domain tests for estimate math and configurable workspace access.
- [ ] Run tests and observe missing implementation.
- [ ] Implement minimal typed domain functions.
- [ ] Add workspace/build scripts and ownership rules.
- [ ] Run tests and commit.

### Task 2: Landing page
**Files:** `apps/web/**`.
**Interfaces:** consumes no backend secrets; public marketing only.
- [ ] Write a smoke test for landing copy and core CTA.
- [ ] Run failing test.
- [ ] Implement responsive blueprint-inspired landing page.
- [ ] Run test, typecheck and build.
- [ ] Commit.

### Task 3: Supabase foundation
**Files:** `supabase/migrations/0001_foundation.sql`, `supabase/seed.sql`, docs.
**Interfaces:** projects, estimates, entitlements, private plans bucket metadata.
- [ ] Write SQL contract checks in documentation/test fixture.
- [ ] Apply migration to new Supabase project.
- [ ] Verify RLS/policies/advisors.
- [ ] Generate TypeScript types.
- [ ] Commit generated schema contract.

### Task 4: Stripe and Resend staging
**Files:** `apps/api/src/billing/*`, `apps/api/src/email/*`, `.env.example`.
**Interfaces:** server-only hosted Checkout/Portal/webhook adapter; Resend template references.
- [ ] Write failing adapter tests with dependency injection.
- [ ] Implement no-charge staging adapters.
- [ ] Create Resend draft workspace welcome template on verified KSP domain.
- [ ] Verify Stripe LIVE account architecture only; create no products/prices/charges.
- [ ] Commit.

### Task 5: Vercel preview and verification
**Files:** Vercel config if needed; no production promotion.
**Interfaces:** deploy `apps/web` preview.
- [ ] Build exact local commit.
- [ ] Deploy preview.
- [ ] Fetch preview and verify 200 + landing content.
- [ ] Record deployment evidence.
- [ ] Commit evidence note if source-controlled.

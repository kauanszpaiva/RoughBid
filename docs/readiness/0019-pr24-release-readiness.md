# PR24 Incremental Release Readiness Report

Date: 2026-09-07 / 2026-09-08
Status: **NO-GO for live production deployment; local gate PASS except build, which is environment-blocked**

This report documents the incremental release-readiness verification for PR24 (`claude/paid-reading-activation-guardrails`) and the isolated readiness branch `overnight/roughbid-pr24-readiness-20260907`.

## Commit & Branch Tracking

- **Current Main Base SHA**: `07475232ac48a300fa23c0050b89ccd174864426` (PR21 READY status)
- **PR24 Head SHA**: `36f4d0417e9e67cc5ae7b304776c43aa98483241` (verified current at rebuild time)
- **Incremental PR Branch**: `overnight/roughbid-pr24-readiness-20260907-10822814054404502726` (PR26)
- **Target Base**: `claude/paid-reading-activation-guardrails` (PR24)

### Branch Recovery Note

An earlier revision of this branch (`3d459ef1ae3146100cf03e9208accd4ef226a054`) was **not** an incremental
change on top of PR24. Its merge-base with PR24 was `5a477e075ebe92275ba817935beaff10cd15d620`, which
predates all four PR24 commits, leaving the branch diverged (ahead 3 / behind 4) and presenting 30 changed
files -- most of them PR24's own migrations, pilot controls and frontend work, duplicated into this PR.

The branch has been rebuilt directly on the verified PR24 head so that it is a true fast-forward descendant.
The prior history is preserved on the remote at `backup/pr26-jules-3d459ef`. The payment code and regression
test carried over byte-identically; only the base changed. The incremental surface is now three files, with
no frontend, PDF, or migration changes.

## Historical Schema Drift Revalidation

Issues #22 and #23 described historical schema drift and unproven paid activation. Revalidated repository evidence confirms:

1. **AI Processing Consent**:
   - `workspaces.ai_processing_consented_at` (Migration 0015 / 0018) is enforced in both application layer (`AiPlanReadingService.create`) and database layer (`reserve_project_reading`). Unconsented workspaces are rejected (HTTP 403).
2. **Labor Findings Constraint**:
   - `plan_reading_findings_finding_type_check` (Migration 0018) permits `'labor'` alongside existing finding types (`'measurement'`, `'symbol'`, `'room'`, `'scope_note'`, `'risk'`, `'question'`, `'material'`).
3. **Pilot Activation Controls**:
   - Migration 0019 installs private tables (`plan_reading_pilot_config`, `plan_reading_pilot_workspaces`, `plan_reading_pilot_usage`) with strict RLS and closed defaults. No model, rates, budget, or allowlisted workspace is enabled by default.

## Verification & Guardrail Hardening

Local synthetic verification using in-memory PGlite PostgreSQL and unit fixtures passed all 289 test cases
across the monorepo (independently re-run on the rebuilt branch):

- **Currency Normalization**:
  - `ProjectPayments.reconcile` lowercases `obj.currency` (`USD` -> `usd`) before passing to `confirm_project_reading_payment`.
- **Payment Reconciliation Guardrails**:
  - Amount mismatch, currency mismatch, mode mismatch, session mismatch, and livemode mismatch raise exceptions and prevent quote status transitions.
  - Refund (`charge.refunded`) and dispute (`charge.dispute.created`) events call `revoke_project_reading_payment` to revoke paid quote access. Zero-amount refunds are safely ignored.
- **Plan File SHA Integrity**:
  - `AiPlanReadingService` verifies `file_sha256` digest match upon plan retrieval. Any post-payment file change yields an HTTP 409 error and releases the hold as `no_provider`.
- **Idempotency & Cost Circuit Breaker**:
  - `confirm_project_reading_payment` and `record_plan_reading_usage` enforce atomic state transitions and prevent duplicate settlement. Measured cost overruns automatically disable the pilot (`enabled = false`).

## CI Stage Results

Local execution of release gate pipeline:

```sh
npm ci                         # PASS - 253 packages, 0 vulnerabilities
npm run typecheck              # PASS - 0 errors (root + apps/web/app projects)
npm test                       # PASS - 289/289 tests passed
npm run build                  # BLOCKED - see below; not a code regression
npm audit --audit-level=high   # PASS - 0 high/critical vulnerabilities
```

`npm run build` cannot complete in an isolated sandbox. `scripts/build-public-config.mjs` deliberately
refuses masked or absent values, failing with `VITE_SUPABASE_URL must be a real project URL`. This
guardrail is working as designed and is **pre-existing**: the unmodified PR24 head fails identically on
the same command. Supplying real project credentials was out of scope for this verification, so the build
stage must be re-run by an operator in an environment holding genuine publishable configuration.

Targeted regression evidence for the currency fix: reverting `.toLowerCase()` makes
`apps/api/test/project-payments.test.ts` fail with `expected 'usd', actual 'USD'`, and restoring it returns
the file to 13/13 passing. The test therefore constrains the intended behaviour rather than merely
exercising it.

## Named Activation Blockers (NO-GO for Live Production)

1. **Provider E2E Unavailable**: Real Stripe TEST webhook delivery and paid Gemini model calls are unavailable in automated/local sandbox environments. Synthetic transport/SQL mocks cannot certify live provider behavior.
2. **Explicit Operator Enablement Pending**: `private.plan_reading_pilot_config.enabled` remains `false` with budget zero. Enabling requires operator configuration of dedicated provider project credentials, model name, and budget limits.
3. **Hosted Migration & Advisor Checks Pending**: Migration 0019 application, Supabase security/performance advisor inspection, and PITR backup/restore drills remain pending on the hosted environment.
4. **Production Build Unverified**: The Vite production build stage has not been executed against real
   publishable Supabase configuration (see CI Stage Results). It must pass in an operator environment
   before any deployment decision.

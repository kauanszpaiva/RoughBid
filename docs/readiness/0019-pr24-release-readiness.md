# PR24 Incremental Release Readiness Report

Date: 2026-09-07 / 2026-09-08
Status: **NO-GO for live production deployment; Local Gate PASS**

This report documents the incremental release-readiness verification for PR24 (`claude/paid-reading-activation-guardrails`) and the isolated readiness branch `overnight/roughbid-pr24-readiness-20260907`.

## Commit & Branch Tracking

- **Current Main Base SHA**: `07475232ac48a300fa23c0050b89ccd174864426` (PR21 READY status)
- **PR24 Head SHA**: `36f4d0417e9e67cc5ae7b304776c43aa98483241`
- **Incremental PR Branch**: `overnight/roughbid-pr24-readiness-20260907`
- **Target Base**: `claude/paid-reading-activation-guardrails` (PR24)

## Historical Schema Drift Revalidation

Issues #22 and #23 described historical schema drift and unproven paid activation. Revalidated repository evidence confirms:

1. **AI Processing Consent**:
   - `workspaces.ai_processing_consented_at` (Migration 0015 / 0018) is enforced in both application layer (`AiPlanReadingService.create`) and database layer (`reserve_project_reading`). Unconsented workspaces are rejected (HTTP 403).
2. **Labor Findings Constraint**:
   - `plan_reading_findings_finding_type_check` (Migration 0018) permits `'labor'` alongside existing finding types (`'measurement'`, `'symbol'`, `'room'`, `'scope_note'`, `'risk'`, `'question'`, `'material'`).
3. **Pilot Activation Controls**:
   - Migration 0019 installs private tables (`plan_reading_pilot_config`, `plan_reading_pilot_workspaces`, `plan_reading_pilot_usage`) with strict RLS and closed defaults. No model, rates, budget, or allowlisted workspace is enabled by default.

## Verification & Guardrail Hardening

Local synthetic verification using in-memory PGlite PostgreSQL and unit fixtures passed all 289 test cases across the monorepo:

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
npm ci                         # PASS - 0 vulnerabilities
npm run typecheck              # PASS - 0 errors
npm test                       # PASS - 289/289 tests passed
npm run build                  # PASS - Vite production build successful
npm audit --audit-level=high   # PASS - 0 high/critical vulnerabilities
```

## Named Activation Blockers (NO-GO for Live Production)

1. **Provider E2E Unavailable**: Real Stripe TEST webhook delivery and paid Gemini model calls are unavailable in automated/local sandbox environments. Synthetic transport/SQL mocks cannot certify live provider behavior.
2. **Explicit Operator Enablement Pending**: `private.plan_reading_pilot_config.enabled` remains `false` with budget zero. Enabling requires operator configuration of dedicated provider project credentials, model name, and budget limits.
3. **Hosted Migration & Advisor Checks Pending**: Migration 0019 application, Supabase security/performance advisor inspection, and PITR backup/restore drills remain pending on the hosted environment.

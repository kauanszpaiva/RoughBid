# Migration 0018: isolated SQL evidence

Date: 2026-09-07. Result: **local SQL gate PASS; hosted staging and release gate still pending**.

The following command passed 10 tests (the 0018 suite and the existing 0017 suite):

```sh
node --test supabase/test/0018-reconciliation.test.mjs supabase/test/paid-project-readings.test.mjs
```

This command is included by `npm test` through `supabase/test/*.test.mjs`.
The release must rerun it on the exact final commit through CI. A passing result
from an earlier SHA or this working tree does not approve a later commit.

## What executed

`supabase/test/0018-reconciliation.test.mjs` uses an in-memory PGlite PostgreSQL
database. It executes the repository's 0007, 0017 and 0018 SQL, including their
real tables, constraints, policies, PL/pgSQL functions and grants. The workspace
access and role helpers are extracted from the existing foundation/RBAC SQL;
they query real fixture memberships rather than returning mocked booleans.
The final recovery integration check also applies 0019 and verifies that every
present public reservation entry point is paused and the pilot stays disabled
after grants are restored.

Infrastructure fixtures replace GoTrue with an `auth.uid()` function reading a
session claim, emulate Supabase's table default grants, and provide only the
foundation columns needed by these migrations. No Supabase database, cloud
branch, Stripe account or Gemini endpoint was called by this test.

| Gate | Observed local result |
| --- | --- |
| Drift before repair | Missing consent column fails reservation; old constraint rejects labor; a replayed 0015 review RPC accepts historical synthetic findings. |
| Repeat application | Apply 0018 twice; column, constraint, review/completion RPC definitions and ACLs remain identical; existing data is preserved. |
| Consent/payment | OFF blocks even a paid quote; ON plus unpaid blocks; ON plus paid creates one reservation/attempt. Denials consume zero attempts. |
| Persistence | The service-role completion RPC persists a labor finding with quantity/unit and `needs_review`. |
| Completion integrity | SQL NULL, JSON null, object, string, empty array and synthetic output are rejected. Invalid results leave jobs, findings, quotes and events unchanged. |
| Human review | The owning tenant's admin and estimator can change status only. Viewer, anonymous, absent identity and the other tenant's admin cannot. |
| Historical output | Neither admin nor estimator can accept synthetic historical findings after 0018. A different tenant is rejected before the synthetic metadata check. |
| RLS and privileges | Findings/jobs expose only the caller's workspace. Anonymous reads expose no findings. Authenticated users cannot directly mutate findings/jobs/payment state or execute service-only payment/reservation/completion RPCs. |
| Function isolation | Review, reservation and completion remain SECURITY DEFINER with `search_path=public, pg_temp`; caller-controlled search path/temp objects cannot redirect review. |
| Transaction recovery | Inject a constraint failure after migration DDL and a valid labor write, prove the transaction is aborted, then rollback. Column/constraint/RPC definitions, ACLs and data match the original fixture. |
| Committed-migration containment | Pause reservation and user review with the recovery SQL, verify both calls are denied and all data including consent/labor/payment history is unchanged. Controlled resume preserves prior work and role/synthetic guards. |
| 0019 recovery compatibility | After applying 0019, pause all present reservation entry points. Resume restores only grants; it never enables the pilot or changes its configuration. |

The existing 0017 SQL test additionally proves payment amount/mode matching,
duplicate-event idempotency, reuse, bounded retries, refund revocation and
atomic completion. It does not prove a real signed Stripe webhook or provider call.

## Defects corrected in 0018

1. Its review RPC replacement had removed 0017's historical synthetic-output
   rejection. The reconciled RPC preserves that guard and first authorizes the
   target workspace.
2. The inherited completion RPC accepted SQL NULL findings because SQL's
   three-valued boolean condition did not enter the error branch. The new test
   failed with “Missing expected rejection” before the correction. The
   reconciled RPC explicitly rejects a non-array type using `IS DISTINCT FROM`
   before checking array length and writing any results.

## Recovery procedure and limits

For a failed application before commit, run the migration in one transaction;
rollback preserves the original schema and data as exercised above. Obtain a
target-environment backup and validate its restore before any hosted rollout.

For an incident after commit:

1. Disable new AI requests in the application's kill switch and retain the
   incident/job/payment evidence. A DB grant change cannot cancel a provider
   request already in flight.
2. Run `supabase/recovery/0018_pause_ai_and_review.sql` in the approved target.
   This revokes new reservations and user review without dropping columns,
   narrowing the labor constraint, deleting findings, or rewriting paid quotes.
3. Diagnose and apply a reviewed forward repair. Reapplying 0018 restores its
   review grant, so do not treat a rerun as a continued pause.
4. Only after the exact target-SHA gate and environment approval, run
   `supabase/recovery/0018_resume_ai_and_review.sql`. The application kill switch
   is a separate control and must be reviewed before enabling requests.

This is local transaction rollback and fail-closed containment evidence. It is
**not** a hosted backup/PITR restore drill, a production lock-duration measurement,
or validation of already-running requests.

## Evidence still required before release

- Apply the final migration set to an approved isolated hosted Supabase target;
  record project/branch, applied migration hashes, catalog definitions and grants.
- Run hosted security/performance advisors after migration and review findings;
  this local test does not execute Supabase advisors, GoTrue, PostgREST, Storage,
  extensions, or the entire deployed schema and migration history.
- Verify cross-tenant requests through real authenticated API/JWT flows and the
  final activation controls, not only SQL session fixtures.
- Capture target backup/restore evidence, row/data checks and app/database
  recovery steps with a verified recovery owner.
- Bind repository, exact SHA, CI, preview, isolated Supabase, Stripe TEST, fixed
  Gemini pilot model, E2E evidence and rollback evidence in the final gate.

Stripe live and Gemini production remain disabled pending the remaining gates
and the user's approval of the final SHA/environment.

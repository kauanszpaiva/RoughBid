# RoughBid Takeoff V2 - normal-chat continuation

Date: 2026-09-10. Request: continue the Work session's RoughBid changes before its credits expire.

## Exact continuity boundary

- Repository: `kauanszpaiva/RoughBid`.
- Work PR: #61, `codex/takeoff-v2-foundation`.
- Inspected base for this continuation: `26997bf4576d628db8d0957f4f86cf2488ba04e0`.
- Isolated continuation branch: `chat/takeoff-v2-safe-continuation-20260910`.
- Original-head CI run `34542518950` and Durable AI Plan Gate run `34542518995` were completed/success at inspection. These are baseline evidence, not evidence for the new patch.
- No access to the other session's uncommitted filesystem is implied. Its branch was not modified. PR #61 contains the coordination notice.

## Reproduced defects and patch

The previous checkpoint implementation performed a read followed by UPSERT. Twenty simultaneous synthetic starts all received `run`, despite one logical checkpoint. Repeating a processing/failed attempt also returned `run`. A late failure could overwrite a completed checkpoint. Raw database and provider exception messages were exposed through errors or persisted summaries.

This patch:

1. Uses INSERT and the existing `(takeoff_run_id, plan_sheet_id, pass_type, attempt)` and `(takeoff_run_id, idempotency_key)` unique constraints to elect a single caller. A unique-conflict loser re-reads and reuses only a matching terminal result; it otherwise receives HTTP 409.
2. Rejects cross-run requests before database access and scopes checkpoint reads/writes to run, workspace, project, sheet, pass, attempt and idempotency identity as applicable.
3. Allows completion/failure updates only while the exact checkpoint is `processing`, requires an acknowledged returned row, and refuses to overwrite terminal results.
4. Retains classification and pass identity but replaces untrusted exception messages with fixed diagnostics. Database errors from the V2 service no longer expose raw database detail.
5. Adds 19 focused regression tests, including concurrent claims, terminal reuse, uncertain-outcome denial, identity conflicts, compare-and-set completion, and Error/SyntaxError/non-Error redaction.

## Deliberate recovery boundary

This is at-most-one dispatch permission for a checkpoint attempt, not an exactly-once provider guarantee. Failed, processing, queued and unknown outcomes are not blindly replayed. There is no new lease-expiry reset, automatic retry, cost settlement or operator reconciliation endpoint. Such a workflow must prove the previous provider outcome and preserve billing evidence before granting a new attempt.

Successful/blocked checkpoint reuse remains supported. An unfinished operation may require reconciliation rather than automatic resumption. Keep Full V2 closed until the provider, worker, budget and recovery workflow is verified. Run-level status transitions and preservation of reviewed sheet metadata in `prepare()` remain separate lifecycle review items; this patch does not claim to harden every run or sheet transition.

## Verification record

The local container had Node 22.16.0 but no network access to GitHub/package installation and no full dependency checkout. The exact checkpoint class and result helper were mechanically extracted from the fetched source into an offline harness, with the same ProjectApiError boundary. The orchestrator was tested directly. This is focused executable evidence, not a claim that the complete repository built locally.

- Before patch: 19 tests, 3 passed, 16 failed. Concurrency assertion reproduced `20 !== 1`.
- After patch: 19 tests, 19 passed, 0 failed. No provider or network calls.
- New repository test: `apps/api/test/takeoff-v2-execution-safety.test.ts` imports the actual production service, not the offline harness.
- The synthetic writer models the existing unique constraints and stale reads; it is not a live PostgreSQL concurrency test.
- Exact-head repository CI, typechecks, full suite, build and applicable Durable browser gates must pass before integration. Record their final IDs/results on the continuation PR; baseline checks must not be substituted.

Reproduce in a normal complete checkout:

```sh
npm ci
node --experimental-strip-types --test apps/api/test/takeoff-v2-execution-safety.test.ts
npx tsc --noEmit
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm test
npm run build
```

## Unchanged production and launch gates

No changes to main, production deployment, database migrations, environment variables, Stripe mode, DNS, budget, dependency manifests, lockfiles or CI workflows. No billed provider invocation or resource provisioning was performed by this continuation.

The foundational Work PR remains a launch-gated draft. Its dedicated Full V2 provider is not wired. Its reported real-plan reconciliation, development-database verification, deployed TEST Stripe lifecycle, domain consistency and preview acceptance gates remain open until separately evidenced. A green patch CI does not mean the Full V2 product is production-ready.

## Integration and rollback

Review this as a stacked PR into the Work branch, not as a competing replacement. Re-read the current Work head and compare shared paths before integration. Preserve unrelated agent changes. Run all gates again on the combined exact SHA before any authorized promotion. Revert this isolated patch if necessary; no schema rollback is required. Do not reopen uncertain attempts or enable the provider as a workaround.

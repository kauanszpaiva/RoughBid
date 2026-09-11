# RoughBid Takeoff V2 - normal-chat continuation

Date: 2026-09-10. Request: continue the Work session's RoughBid changes before its credits expire.

## Exact continuity boundary

- Repository: `kauanszpaiva/RoughBid`.
- Work PR: #61, `codex/takeoff-v2-foundation`.
- Original inspected base: `26997bf4576d628db8d0957f4f86cf2488ba04e0`.
- Isolated continuation branch: `chat/takeoff-v2-safe-continuation-20260910`, PR #62.
- Original-head CI `34542518950` and Durable gate `34542518995` passed; these are baseline evidence, not evidence for this patch.
- Work advanced to `0ead52b311315c3a8c4b12fc1a11c3ca4cef5e98`, adding the Claude provider in disjoint files. Those five files are preserved unchanged in this integrated candidate.
- CI `34543394691` tested merge `033eaaa805c08882a3b8e180f7b9c602ed2e63a7` and exposed TS2353: Claude returned a provider field missing from DeepPassResult. This continuation adds the optional contract field, bounded metadata validation and persistence, with five additional regression tests.
- No access to the other session's uncommitted filesystem is implied. Its branch was not modified. PR #61 contains coordination notices.

## Reproduced defects and patch

The previous checkpoint implementation performed a read followed by UPSERT. Twenty simultaneous synthetic starts all received run, despite one logical checkpoint. Repeating a processing/failed attempt also returned run. A late failure could overwrite a completed checkpoint. Raw database and provider exception messages were exposed through errors or persisted summaries.

This patch:

1. Uses INSERT and the existing checkpoint unique constraints to elect a single caller. A unique-conflict loser re-reads and reuses only a matching terminal result; it otherwise receives HTTP 409.
2. Rejects cross-run requests before database access and scopes reads/writes to the exact checkpoint and tenant.
3. Allows completion/failure updates only while the exact checkpoint is processing, requires an acknowledged returned row, and refuses to overwrite terminal results.
4. Replaces untrusted exception messages with fixed diagnostics while retaining classification and pass identity.
5. Accepts, validates and persists provider identity alongside model/token metadata, reconciling the new Claude provider contract.
6. Adds 24 focused tests covering these boundaries. No network or billed calls are used.

## Deliberate recovery boundary

This is at-most-one dispatch permission per checkpoint attempt, not an exactly-once external-provider guarantee. Failed, processing, queued and unknown outcomes are not blindly replayed. There is no lease-expiry reset, automatic retry, cost settlement or operator reconciliation endpoint. A recovery workflow must prove the previous provider outcome and preserve billing evidence before granting a new attempt.

Successful/blocked checkpoint reuse remains supported. An unfinished operation may require reconciliation rather than automatic resumption. Keep Full V2 closed until provider, worker, budget and recovery behavior is verified. Run-level transitions and preservation of reviewed sheet metadata in prepare() remain separate lifecycle review items; this patch does not claim to harden every run or sheet transition.

## Verification record

The local container had Node 22.16.0 but no network access to GitHub/package installation and no full dependency checkout. The exact checkpoint class/result helper were mechanically extracted into an offline harness with the same ProjectApiError boundary. The orchestrator was tested directly. This is focused executable evidence, not a claim that the complete repository built locally.

- Initial RED: 19 tests, 3 passed, 16 failed; concurrency reproduced 20 versus 1 expected.
- Initial GREEN: 19/19 passed.
- Provider metadata RED: 24 tests, 19 passed, 5 failed.
- Provider metadata GREEN: 24/24 passed.
- Committed test imports the actual production service, not the offline harness.
- The synthetic writer models existing unique constraints/stale reads; it is not a live PostgreSQL concurrency test.
- Exact integrated-head repository CI, typechecks, full suite, build and applicable Durable/browser gates must pass before integration. Record final IDs/results on PR #62. A failed earlier run must not be treated as passed.

Complete-checkout verification:

```sh
npm ci
node --experimental-strip-types --test apps/api/test/takeoff-v2-execution-safety.test.ts
npx tsc --noEmit
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm test
npm run build
```

## Unchanged production and launch gates

No changes to main, production deployment, migrations, live environment values, Stripe mode, DNS, budget, dependency manifests, lockfiles or CI workflows. The Work branch's environment example additions were preserved, not activated. No billed provider invocation or resource provisioning was performed by this continuation.

The foundational Work PR remains a launch-gated draft. Having a Claude provider implementation does not wire or authorize the production service. Real-plan reconciliation, development-database verification, deployed TEST Stripe lifecycle, domain consistency and preview acceptance remain open until separately evidenced. Green patch CI is not a Full V2 production release.

## Integration and rollback

Review PR #62 into the Work branch, not as a competing replacement. Re-read the current Work head and compare shared paths before integration. Preserve unrelated agent changes. Rerun gates on the combined exact SHA before authorized promotion. The merge-style continuation commit preserves both parents without changing the Work branch. Revert this isolated patch if necessary; no schema rollback is required. Never reopen uncertain attempts or enable the provider as a workaround.

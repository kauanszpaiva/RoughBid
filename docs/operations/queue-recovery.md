# Queue recovery without replaying uncertain provider work

A successful Railway/Vercel deployment is not proof of reading readiness. The
worker intentionally parks after a recognized Redis monthly-quota error. It does
not automatically resume after quota restoration and must not be restarted in a
loop while quota is exhausted.

## Before restoring processing

1. Read the existing Redis database's usage and billing plan. Verify the actual
   reset date or restored allowance in that account; do not infer a calendar date
   from the words "monthly quota". Any paid upgrade requires an approved spending
   limit. Do not create replacement databases, credentials, or migrate job data as
   an implicit recovery step.
2. Review durable SQL runs, provider checkpoints, leases, saved budget holds, and
   uncertain dispatches. A failed or stale job is not authority to repeat a paid
   provider call. Preserve evidence and reconcile uncertain outcomes first.
3. Obtain authorization for the chosen production change/restart. When capacity
   is restored, restart once, then verify both fresh SQL worker heartbeats and an
   actual compatible queue consumer. The founder entitlement endpoint must use
   both signals, like the run reservation endpoint.
4. Inspect idle command usage before calling the queue sustainable. BullMQ
   consumers, stalled checks, and presence leases consume commands even when no
   new user plans are being processed. Do not promise that a free command cap
   can support a continuously running multi-queue deployment without measuring.
5. Run one explicitly approved synthetic end-to-end plan/photo reading with a
   bounded provider budget. Confirm saved terminal state, source/page identity,
   reviewed quantities, sourced prices, and material/labor breakdowns. Interrupted
   or repeated requests must recover the same run, not start another paid call.

## Upload retry contract

PDF and photo intake remember the server identity after a successful byte
transfer. If the completion response is lost, retry the completion endpoint with
that identity without reserving or uploading another copy. Clear that local
identity when switching project/workspace; discard stale asynchronous results.
This is in-page recovery, not a claim of cross-browser or post-reload resumability.
PDF completion is also idempotent while optional page rendering is in progress.
No upload or recovery action itself authorizes AI processing.

## Validation

- `npm test`
- `npx tsc --noEmit`
- `npx tsc --noEmit -p apps/web/app/tsconfig.json`
- Production compile with explicitly nonfunctional CI public configuration
- `node scripts/test-simple-estimate-browser.mjs`, using the documented isolated
  Playwright setup. Includes lost PDF/photo completion responses and confirms a
  single reservation/transfer, two completion requests, and zero analysis calls.

The browser suite uses local fixtures and does not replace an authorized live
acceptance test. Report it as unrun when the executor cannot launch its browser.

## Product acceptance boundary

Accepted photo and plan measurements feed the construction-budget panel, where
source prices, service composition, labor and equipment applicability are still
required. Missing values remain pending. The older manual estimate/export flow
has a separate saved-PDF requirement and is not equivalent to a reviewed complete
construction-budget snapshot. Never describe a model observation, partial
budget, or green build as a certified final estimate.

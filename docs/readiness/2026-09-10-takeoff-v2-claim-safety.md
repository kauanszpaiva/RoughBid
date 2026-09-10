# Full Takeoff V2 claim safety and failure redaction — 2026-09-10

This continues the Takeoff V2 vertical slice at `26997bf4576d628db8d0957f4f86cf2488ba04e0`
and closes the two boundaries that were named as open on that work: the
checkpoint claim under simultaneous starts or unknown-outcome replay, and
untrusted provider exception text reaching returned and persisted failures.

Nothing here promotes Full V2. The production provider factory stays unwired,
the V2 migration stays unapplied on live Supabase, and the capability gates stay
closed by default.

## Why the previous behavior was unsafe

- `prepare` reset any existing run for a plan set back to `processing`. Two
  simultaneous starts therefore shared one run row and orchestrated the same
  sheets twice.
- `begin` read the checkpoint status and then upserted `processing` regardless
  of what it found. A pass another run was executing, or a pass whose outcome a
  crash left unrecorded, was re-run and its checkpoint overwritten. Both cases
  bill a high-reasoning provider call twice for one unit of work.
- A provider or transport exception message was pushed into the run summary
  returned to the caller and into the persisted `checkpoint.error`. That text is
  attacker- and vendor-controlled and can echo request or response bodies.

## What changed

- **Run claim.** Only the caller that inserted the run row owns it outright.
  Any other caller must win a compare-and-set on the row's `status` and
  `updated_at`, and is refused with HTTP 409 while the run's lease is live. A
  run abandoned for longer than the lease is resumable. The insert now stamps
  `updated_at` explicitly so the claim never depends on a column default.
- **Pass claim.** A missing checkpoint is claimed by insert, and the migration's
  unique key on run, sheet, pass type and attempt is the arbiter: a duplicate-key
  loss returns `already_claimed` instead of running the pass. An existing
  checkpoint is claimed by compare-and-set on its status, and for a `processing`
  row also on its `started_at`. A `processing` claim inside the lease is treated
  as an unknown outcome that belongs to another run and is never replayed.
- **Lease.** 15 minutes, long enough that a live high-reasoning pass cannot lose
  its own claim. Absent or unparsable timestamps are treated as expired.
- **Orchestrator.** `already_claimed` stops that sheet, counts in a new
  `claimed` summary field, and is reported as a blocker. It is not a failure of
  this run and writes no failure checkpoint. A run that only lost passes to
  another claim returns `processing` and leaves the run row's terminal status to
  the run that owns it.
- **Redaction.** Only this module's own validation text survives a failure. It
  is raised as `DeepPassOutputError` and classified `invalid_output`. Every
  other exception is classified `provider_or_pipeline_failure` with a fixed
  message, so no provider text is returned to the caller or persisted.

## Verification

- Full monorepo suite: 554/554 passed, including nine new regressions in
  `apps/api/test/takeoff-v2-claim-safety.test.ts`.
- Backend and web TypeScript no-emit typechecks passed.
- Production build passed.

The new regressions cover: a refused second simultaneous start, a resumable
abandoned run, an unbilled live pass claim, reclaim only after lease expiry, a
settled pass never re-run, a claimed pass stopping its sheet without a provider
call, a claim-only run writing no terminal status, and provider exception text
absent from both the summary and the persisted checkpoint.

## Still open, unchanged by this work

1. Provision a Supabase development branch, apply the V2 migration, rerun
   advisors, then promote through an approved migration window.
2. Configure and validate the dedicated Full V2 provider/worker before enabling
   the three closed-by-default capability gates.
3. Reconcile at least three representative Massachusetts plan sets against
   estimator ground truth.
4. Execute the live-deployment Stripe TEST payment, replay, failed/unpaid, and
   refund/dispute evidence.
5. Fix apex DNS and `APP_URL` consistency.
6. Run preview browser, API and data verification, define rollback thresholds,
   then promote.

A durable worker will also need the lease renewed while a pass is genuinely
running; today the lease is a fixed window measured from the claim.

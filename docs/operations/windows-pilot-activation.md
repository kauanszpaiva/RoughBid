# RoughBid Windows pilot activation

The production Supabase project `piasgpciojstjalaqazu` received the reviewed 17-file bundle on 2026-10-03 01:52–01:54 UTC. Each migration was applied separately after the 162-check read-only preflight passed, portable SQL SHA-256 checks passed, and the existing structural catalog/function definitions were saved to a protected recovery directory. Remote history uses names `pilot_activation_01_...` through `pilot_activation_17_...`; 44 prior entries were preserved, for 61 entries. Commercial migration `20260910190303` was not reapplied.

Postflight verified the Full stage schema RPC, RLS on the new execution tables, service-only writer permissions, and an empty owner-free allowlist. Existing reading counts were unchanged (30 needs_review, 15 failed, 5 processing); the five processing records predate this activation and were not retried or cancelled.

## Host and credentials

Use `scripts/windows-pilot-worker.ps1` with a protected JSON configuration created for the host. The current-user logon task starts a hidden supervisor only when its enabled marker exists. It restarts worker crashes, writes redacted logs and supports Start, Stop, Restart, Status and Uninstall. The PC must remain awake, connected and signed into the configured Windows account. This is a pilot host, not a 24/7 availability claim.

`scripts/windows-pilot-setup.ps1` accepts a protected credentials file or secure interactive input. Never use a tracked example environment file for secrets. Normal Vercel production exports return sensitive credentials as `[SENSITIVE]`; these are rejected. Do not export protected secrets through a deployed endpoint. Store the actual existing keys only in a locally protected, ignored process configuration.

Minimal Full model profile: Supabase service key + Gemini API key. OpenAI, Anthropic, Kimi, DeepSeek, Kamai and APS credentials can be supplied together for their respective profiles; possession of keys does not establish account/model access, provider billing units, Kamai terminal status, or an APS source binding. Redis and Blob credentials are independent. No key rotation is needed.

The setup validates the target Supabase schema with a read-only RPC and Gemini exact-model visibility with a metadata GET. This is not a live inference benchmark. No setup step submits a document or generates content.

## Spend and readiness

Both `ROUGH_BID_LIVE_TESTS_ENABLED` and `ROUGH_BID_LIVE_TEST_SPEND_APPROVED` remain false. Legacy paid/free/pilot readers remain disabled during this activation; Full requires its own explicit per-job approval. The new UI starts with blank limits and an unchecked confirmation. Its immutable saved approval binds the actor, file, models, configuration and provider limits. Resume never grants a new budget.

Set `TAKEOFF_V2_CALL_RESERVATION_USD=2.5` consistently with the existing company policy. This is a conservative reservation, not a charge, balance or spending authorization. Server policy ceilings only bound what the user may approve; they do not authorize a job. Missing heartbeat/configuration keeps intake closed.

The first activated Gemini profile runs the new durable Full engine with Gemini 3.8 Flash across seven model stages. Metadata access for that exact model passed; no inference was submitted. Automatic Kamai currently remains blocked by the model-only approval profile; it requires a child-provider approval profile and verified commercial/status configuration before activation. APS requires an existing source object and reviewed binding. Optional providers remain gated rather than silently substituting models.

## Verification and rollback

The activation suite passed 1,243 tests with one paid/live test skipped. API/web/strict worker types and the compile-only build passed. After repairing isolated fixtures, PDF, AI review and paid-return checks passed in Chromium and WebKit; physical-page review passed at desktop and mobile sizes. The extended metadata probe passed nine isolated tests. Gemini REST enum serialization and current tariff validity were corrected using official schemas and tests.

On 2026-10-03, the installed Windows task started the actual PDF and Full worker. A real stop/restart exited gracefully and restored the SQL heartbeat and both Redis consumers (one each), with zero jobs. Redis authenticated PONG and TLS certificate validation passed. Upstash consumer-list visibility proved intermittently incomplete even after startup, so Full readiness uses a dedicated consumer-presence lease instead of CLIENT LIST. Only the running, unpaused Full consumer with both Redis clients ready renews its own versioned member every 15 seconds. Redis time and a 45-second expiry bound stale presence; shutdown removes only that instance's member. The existing SQL heartbeat and schema gates remain mandatory. No provider inference, real-document upload to vendors, customer charge or paid resource creation was performed. Host-specific evidence and the operator runbook are kept outside the repository with protected credentials excluded.

Rollback starts by closing intake and stopping/draining the compatible worker. Preserve jobs, receipts, uncertain reservations and ledger rows. Promote the prior Vercel deployment if needed, and review the saved original functions before any targeted restoration. Do not drop execution/audit tables, replay all historic migrations or refund uncertain calls. A code rollback does not itself reverse shared SQL function changes.

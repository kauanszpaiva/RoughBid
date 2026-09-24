# RoughBid AI Plan Reading Pipeline

RoughBid's AI plan reader should behave like an estimating assistant, not a final authority. Every extracted quantity, note, symbol, and risk needs source evidence and human review before it can affect an estimate.

## Production Flow

1. **Upload gate**
   - Accept only PDF plans through private object storage.
   - Verify file type, size, object presence, and tenant ownership before processing.
   - Store uploads under `workspace/project/file` paths.

2. **Page rendering (viewer only)**
   - Convert each PDF page to JPEG using the existing Poppler worker (`scripts/worker.ts` / `Dockerfile.worker`), so the in-app blueprint viewer has page images.
   - This is independent of AI reading below — Gemini reads the PDF directly and does not wait on it.

3. **Paid quote gate**
   - The user selects a finished PDF, scope, and trades.
   - The API downloads the private PDF through the server, verifies the tenant-scoped storage path, file signature, page count, file hash, and request bounds.
   - RoughBid calculates a project-reading charge from measured cost settings, Stripe card fee settings, and the active membership margin target. If the cost policy is missing, checkout stays disabled.
   - Stripe Checkout collects payment. Only a signed Stripe webhook can mark the quote paid.

4. **AI reading job**
   - `AiPlanReadingService.create()` refuses to run without the paid quote id, matching file hash, matching scope, matching trades, workspace AI consent, and a permitted workspace role.
   - The paid quote reserves or reuses one `plan_reading_jobs` row through a service-role RPC and runs the read synchronously, inline in the same API request. There is no separate worker process for AI reading.
   - The model (Gemini, via `apps/api/src/ai-plan/gemini.ts`) receives the uploaded PDF inline (base64), so this only needs the upload itself to have finished.

5. **Extraction targets**
   - Measurements and dimensions.
   - Rooms/areas and sheet/page references.
   - Materials and fixture/symbol counts, each with a quantity and unit (`material` findings).
   - Labor/service scope implied by the drawings — demolition, framing, install labor, trade rough-ins — each with its own quantity and unit (`labor` findings), priced independently of the material it goes with.
   - Scope notes and exclusions.
   - Ambiguous items that require estimator review.
   - Risk flags such as missing scale, conflicting revisions, unreadable pages, or incomplete schedules.

6. **Vector linework and drawing geometry (local, deterministic)**
   - Before any provider call, `apps/api/src/ai-plan/drawing-linework.ts` walks the plan's own PDF content streams with PDF.js and measures what is actually drawn: straight line runs by direction (horizontal / vertical / diagonal), thick long "wall-like" strokes, closed axis-aligned outlines (rooms/areas), filled shapes, curved segments measured as chords, and page rotation.
   - Nothing leaves the process and no provider is billed for this step. It is the only part of the pipeline that reads *lines and shapes* rather than text and pixels.
   - Every reader receives a bounded `DETERMINISTIC VECTOR LINEWORK` digest in its prompt (Gemini/Claude as an extra content part, OpenAI-compatible providers as prompt text, OpenRouter as `linework_digest`), so the model can locate walls, outlines and rooms against measured geometry instead of guessing.
   - The largest closed outlines are also appended to the reading as `measurement` findings carrying normalized `geometry.bbox` and a deterministic source excerpt. Their quantity and unit stay `null`: a vector outline is a location, not a takeoff, and it is never priced. Every addition is disclosed in `summary.limitations`.
   - Control: `AI_PLAN_VECTOR_LINEWORK_ENABLED` (default on; set `false` to skip local geometry) and `AI_PLAN_LINEWORK_MAX_PAGES` (100, max 200 — the product accepts at most 100 physical pages, so the default covers a whole supported set). The limit is bounded so one oversized set cannot monopolize a request, and when it is reached the digest not only tells the model which sheets it does not describe, it also writes that limit into `summary.limitations` so a partial drawing never reads as a complete one. A page review reads linework only for the single physical page it sends.
   - The same pass transcribes the sheet's **printed text layer** (`apps/api/src/ai-plan/sheet-text.ts`): notes, keynotes, tags, schedule lines, heading candidates, the title-block sheet number and the printed scale, page by page, inside a per-page and per-set character budget.
   - It is attached to every reader as a `NATIVE SHEET TEXT` block, so a model citing a note quotes the printed characters instead of paraphrasing them, and small printed detail is not lost to a page skim. A sheet with an image and no text layer is reported as having little or no text layer rather than as an empty sheet, and a page review transcribes only the page it sends.
   - Control: `AI_PLAN_SHEET_TEXT_ENABLED` (default on), `AI_PLAN_SHEET_TEXT_MAX_PAGES` (80), `AI_PLAN_SHEET_TEXT_MAX_CHARS` (30000), `AI_PLAN_SHEET_TEXT_MAX_CHARS_PER_PAGE` (1500). A transcript that stops at the page limit is disclosed in `summary.limitations`, so later sheets are never implied to have been checked.

7. **Whole-set reading (one request per window)**
   - A 60-sheet set cannot be read honestly in one request: the model skims it, the output ceiling truncates the tail, and nothing records which sheets were examined. `apps/api/src/ai-plan/plan-batches.ts` splits a set into ordered windows of physical pages, and `OpenAiCompatibleVisionPlanReader` sweeps them for the PDF-native OpenAI route, one metered provider request per window.
   - Each window is a standalone PDF (`pdf-lib` copies only its pages), so the provider is told to cite page `1..n` **local to that request** and the reader restores the original physical numbering deterministically. A finding that cites a page outside its own window is dropped and counted in `summary.limitations`.
   - Every window is reserved against the company spend breaker separately, so one oversized set cannot slip past the cap unnoticed.
   - Nothing invents coverage: a failed batch, a window the request cap never reached, and a whole-set findings cap are each named in `summary.limitations`. A sweep that produces no findings at all rethrows the provider failure so the multi-provider orchestrator can try the next reader.
   - Controls: `AI_PLAN_OPENAI_BATCH_PAGES` (8, max 50), `AI_PLAN_OPENAI_MAX_BATCHES` (25, max 60), `AI_PLAN_MAX_TOTAL_FINDINGS` (400, max 1000), `AI_PLAN_OPENAI_TIMEOUT_MS` (120000, max 300000), `AI_PLAN_OPENAI_SWEEP=false` to send the whole set in one request. The image-native providers never sweep: they read exactly the rendered pages they were given.

8. **Evidence and review**
   - Save every extracted item as a `plan_reading_findings` row.
   - Include confidence, page number, geometry/source excerpt, and review status.
   - Default every finding to `needs_review`.
   - Allow accepted findings to generate draft takeoff quantities; rejected findings never affect estimate math.
   - Authenticated users have no direct table privilege on `plan_reading_findings` (only the worker's service-role connection does) — review goes through `public.set_plan_reading_finding_status(finding_id, new_status)` (`supabase/migrations/0015_...`), a narrow RPC that checks the caller's workspace role and only ever changes `status`. `PATCH /api/ai-plan-readings/findings/:id` and the AI Estimator modal's Add/Ignore buttons call it.

9. **Pricing and model behavior**
   - Gemini is the production reader. The request handler uses one configured `GEMINI_MODEL` and disables SDK retries so one paid attempt does not silently fan out into provider retries.
   - If Gemini is missing, unavailable, or returns no usable source-backed quantity, the job is marked failed and no substitute quantities are stored.
   - Every reader output goes through `apps/api/src/ai-plan/types.ts`'s `sanitizePlanReadingResult`: a quantity without a source page and source excerpt, or a unit outside SF/LF/EA/CY/SY/HR/LS, is dropped and disclosed in `summary.limitations` rather than trusted.
   - `apps/api/src/ai-plan/pricing.ts` prices findings with `calculateProject` (the same fixed-point engine `packages/domain` uses for estimates): every `material` finding produces a material line at its quantity plus a companion install-labor line, and every `labor` finding produces its own labor line. Rates are seeded from a New England (CT/MA/ME/NH/RI/VT) benchmark — see "New England ML Method" below — split into material/labor shares, with a generic unit-based fallback for anything unmatched.
   - The priced detail per finding is stored in that finding's `geometry.pricing`; the job's `output_summary.pricing` carries the material/labor/direct cost totals and how many findings were priced vs. left for manual pricing.
   - `AiPlanReadingService.create()` refuses to run at all unless the workspace has `ai_processing_consented_at` set (see Security Rules) and enforces a per-workspace daily cap (`AI_PLAN_DAILY_JOB_LIMIT`, default 25).
   - Every Gemini generation separately reserves against the database-atomic company-wide `provider_spend_policy`. Failed or missing telemetry retains the full reservation instead of being treated as $0.
   - Findings are written through a service-role Supabase connection constructed inline in the request handler (`apps/api/src/http/handler.ts`), the same way the billing endpoint already builds a service-role repository per-request — never a separate always-on process, and never a key sent to the browser.

10. **Estimate integration**
   - Accepted measurements map into RoughBid quantity groups.
   - Accepted material and labor findings carry a priced suggestion (see Pricing above) an estimator can accept, adjust, or reject before it becomes a real estimate line.
   - Proposal/export remains blocked until plan, quantity, estimate, and review gates are complete.

## Required Runtime Configuration

- `GEMINI_API_KEY`: server-only key for multimodal plan extraction. Missing or invalid configuration disables AI output instead of producing a simulated takeoff.
- `GEMINI_MODEL`: default `gemini-3.8-flash`.
- `CLAUDE_PLAN_READING_ENABLED` + `ANTHROPIC_API_KEY` + `CLAUDE_PLAN_MODEL`: Claude as a first-class paid plan reader (sends the PDF as an Anthropic document block, metered through the same company spend breaker). Default model `claude-sonnet-4-5`; the route stays closed unless the flag is `true` and the model matches an exact `claude-<family>-...` name.
- `OPENAI_PLAN_READING_ENABLED` + `OPENAI_API_KEY` + `OPENAI_MODEL` (+ optional host-pinned `OPENAI_BASE_URL`): OpenAI as a paid plan reader. It attaches the plan PDF directly (`data:application/pdf;base64,...`), so it needs no server-side page renderer, and prefers rendered page images when they exist. Default model `gpt-4.1`.
- `AI_PLAN_PROVIDER_ORDER`: default `gemini,claude,openai,kimi,deepseek`. Unknown or unconfigured names are skipped; a reader is only built when its own gate passes.
- `AI_PLAN_VECTOR_LINEWORK_ENABLED`: default on. Set `false` to skip local PDF vector-linework reading and its geometry findings.
- `AI_PLAN_SHEET_TEXT_ENABLED` / `AI_PLAN_SHEET_TEXT_MAX_PAGES` / `AI_PLAN_SHEET_TEXT_MAX_CHARS` / `AI_PLAN_SHEET_TEXT_MAX_CHARS_PER_PAGE`: local printed-text transcript and its bounds.
- `AI_PLAN_OPENAI_BATCH_PAGES` / `AI_PLAN_OPENAI_MAX_BATCHES` / `AI_PLAN_OPENAI_SWEEP`: whole-set sweep window size, request cap and off switch for the OpenAI reader.
- `AI_PLAN_MAX_TOTAL_FINDINGS`: ceiling on findings kept from a whole-set sweep.
- `AI_PLAN_OPENAI_TIMEOUT_MS`: per-request ceiling for the OpenAI-compatible reader (default 120000, max 300000). Multi-page PDF requests are slower than single images.
- `provider_spend_policy.call_reservation_usd`: the company breaker reserves this much per provider request and releases it once real telemetry is captured, so a reading is admitted only while `used + reservation <= spend_cap_usd`. The shipped default (2.50 of 25.00) allows about nine requests per 24 h; a measured four-sheet reading on gpt-4o-mini costs roughly $0.0016, so a lower reservation admits far more readings inside the same real budget. `reserve_provider_spend` accepts only providers that migration 20260924134500 approves (gemini, deepseek, kimi, openai, claude); anything else fails closed before a request is made.
- `SUPABASE_SERVICE_ROLE_KEY`: used inline for paid quote creation, webhook reconciliation, job reservation, and inserting `plan_reading_findings`.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: required before project-reading checkout can charge or grant a paid quote.
- `PROJECT_PRICING_VERSION`, `PROJECT_COST_BASE_CENTS`, `PROJECT_COST_PAGE_CENTS`, `PROJECT_COST_TRADE_CENTS`, `PROJECT_PAYMENT_FIXED_CENTS`, `PROJECT_PAYMENT_FEE_BPS`: required measured cost policy for dynamic per-project charges.
- `STRIPE_PRICE_PLAN_STARTER`, `STRIPE_PRICE_PLAN_PRO`, `STRIPE_PRICE_PLAN_TEAM`, `STRIPE_PRICE_PLAN_ENTERPRISE`: optional membership price ids; subscription checkout remains off unless `BILLING_MEMBERSHIPS_ENABLED=true`.
- Private object storage credentials (`OBJECT_STORAGE_*` or `BLOB_READ_WRITE_TOKEN`) for the uploaded plan PDF this reads and the rendered page images the blueprint viewer shows.
- `REDIS_URL`: only needed for the Poppler page-rendering queue (viewer thumbnails) — AI plan reading does not use it.
- `AI_PLAN_DAILY_JOB_LIMIT`: optional per-workspace daily cap on AI plan-reading jobs, default 25.

## Security Rules

- Do not send plan files to AI unless the workspace has accepted the data/AI policy and the project-reading quote is paid by signed Stripe webhook.
- Keep all plan objects private and tenant-scoped.
- Never expose service-role, storage, Stripe, Resend, or AI keys to the web app.
- Store model output as reviewable findings, not silently trusted estimate data.
- Log job status and errors without storing raw secrets or unnecessary personal data.

## Low-Cost Multi-Provider Routing

RoughBid keeps one evidence contract regardless of provider: every quantity must survive the same
`sanitizePlanReadingResult` checks, preserve source-page evidence, and remain human-reviewable.

Safe default paid-provider order:

1. **Gemini** — current PDF-native production reader; paid-service data is not used for product/model improvement under Google's published terms.
2. **Claude** — PDF-native reader with the same evidence contract, metered per call against the company spend policy.
3. **OpenAI** — PDF-native or page-image reader, useful when Gemini/Claude are unavailable or rate limited.
4. **Kimi K2.6** — optional image-native fallback; Kimi's API policy states API inputs/outputs are not used for model training.
5. **DeepSeek Flash** — cost-optimized optional route, but private/customer plan processing stays behind a separate explicit privacy gate until the applicable data-use/opt-out posture is accepted.

For synthetic, public, or otherwise authorized non-confidential benchmark sets, DeepSeek can be moved earlier in `AI_PLAN_PROVIDER_ORDER` after the privacy gate is intentionally enabled.

Controls:

- `AI_PLAN_PROVIDER_ORDER` controls routing order.
- DeepSeek and Kimi are independently disabled by default and require server-only credentials.
- DeepSeek additionally requires `DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED=true`; the key and enable flag alone cannot open private-plan processing.
- DeepSeek/Kimi fail before a network request when `pageImages` are absent; this preserves the existing Gemini PDF path and prevents surprise spend.
- Kimi requires an explicit region-matched base URL because international and China Open Platform credentials are separate.
- All paid providers pass through the same database company-spend breaker before generation.
- Unknown cost telemetry is conservative: the spend reservation remains counted rather than being treated as zero cost.
- Do not activate a new provider until real construction-plan benchmarks verify extraction quality, cost, and evidence integrity.

### Page-image prerequisite

DeepSeek and Kimi consume images rather than RoughBid's raw construction PDF. One of these paths must
be verified before either provider is enabled:

- the existing Poppler document worker writes private `project_file_pages` assets; or
- an approved on-demand renderer produces bounded page images without adding a new external API.

Do not make low-cost vision depend on a public image URL. Page assets remain private and are sent to a
provider only after the workspace AI-processing consent and existing tenant/payment/entitlement gates pass.

## Tavily Status

Tavily is intended for current market/context research around construction terminology and estimating best practices, not for reading private customer plans. The connector still returned a reauthentication error on 2026-09-04, so this pipeline document is implementation-driven and not represented as Tavily-verified research.

## New England ML Method

`apps/api/src/ai-plan/pricing.ts` already seeds its rate table from a New England (CT/MA/ME/NH/RI/VT) benchmark — 48" frost-line concrete, IECC zone 5/6 thermal envelopes, cold-climate MEP, and prevailing Northeast trade labor scales — rather than invented numbers. It's still an estimating benchmark, not a licensed, jurisdiction-sourced price book; the rest of this section's guidance (a proper source library, RAG lookups, per-workspace corrections) is the path to replacing it with one.

Do not start by fine-tuning on uncontrolled plan files. The safer production path is:

- Build a licensed source library for CT, MA, ME, NH, RI, and VT codes, amendments, public guidance, and approved price references.
- Store source snapshots with jurisdiction, date, URL/license basis, and effective period.
- Use retrieval-augmented generation for code and specification lookups.
- Use cheap extraction models for page reading and object detection.
- Use stronger models only for ambiguous plan sections, code reasoning, and final review.
- Save reviewed estimator corrections as training examples inside the originating workspace.
- Use cross-workspace learning only after explicit opt-in, anonymization, and legal approval.

RoughBid should first learn from reviewed outcomes: accepted quantities, rejected findings, user corrections, final winning price, and proposal acceptance. That creates a high-quality dataset without pretending that public internet plans are enough for reliable construction estimation.

## Future Photo, Video, And Audio Intake

RoughBid should leave the pipeline ready for remodel jobs where the contractor has media instead of a clean plan set.

Planned sequence:

1. Accept site photos, walkthrough videos, audio notes, and typed notes.
2. Store media privately under the same workspace/project boundary as plan PDFs.
3. Transcribe audio and video.
4. Detect visible rooms, fixtures, damage, finishes, measurements, and uncertainty.
5. Ask the estimator simple follow-up questions instead of inventing missing scope.
6. Convert approved observations into scope lines, quantity placeholders, and estimate assumptions.
7. Use the same cost ledger and AI provider caps as plan reading.

This feature remains "soon" until media storage, consent, retention, provider processing, and cost limits are fully implemented.

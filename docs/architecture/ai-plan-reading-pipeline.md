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
   - The drawing itself: line work, wall and partition lines, openings, fixtures, symbols and icons, hatch patterns/poché, graphic scale bars, north arrows, grid references, keynotes/tags, callouts, details, sections, elevations, schedules and title blocks. A sheet with few printed words is still evidence and is never treated as blank or unreadable.
   - Measurements and dimensions.
   - Rooms/areas and sheet/page references, each located with normalized page geometry.
   - Graphic elements with no printed sentence of their own (an icon, a hatch, a line type, a legend symbol): recorded as a `symbol`/`room`/`scope_note` finding with a null quantity plus `geometry.visual`, so an estimator can verify and count them. Graphic evidence never becomes a trusted quantity by itself.
   - Materials and fixture/symbol counts, each with a quantity and unit (`material` findings).
   - Labor/service scope implied by the drawings — demolition, framing, install labor, trade rough-ins — each with its own quantity and unit (`labor` findings), priced independently of the material it goes with.
   - Scope notes and exclusions.
   - Ambiguous items that require estimator review.
   - Risk flags such as missing scale, conflicting revisions, unreadable pages, or incomplete schedules.

6. **Evidence and review**
   - Save every extracted item as a `plan_reading_findings` row.
   - Include confidence, page number, geometry/source excerpt, and review status.
   - `geometry` carries normalized page coordinates (`bbox` and/or `point`), the printed `area`/`room`, and optional `element`, `legend_mark`, `sheet_reference`, `grid_reference`, `scale_note`. A located element may rest on printed text OR on validated graphic evidence — never on neither.
   - `geometry.visual` is the graphic-evidence channel: `{ kind, description, legend_mark?, confidence }` with `kind` restricted to `symbol`, `icon`, `hatch_pattern`, `line_work`, `dimension_string`, `graphic_scale_bar`, `north_arrow`, `grid_reference`, `legend_mark`, `callout`, `detail`, `title_block`, `schedule_table`. It is bounded, allow-listed and stripped of anything else.
   - A quantity still requires a physical page, a verbatim source excerpt and an allowed imperial unit (`SF`, `LF`, `EA`, `CY`, `SY`, `HR`, `LS`). Graphic evidence can name and place an element; it can never invent its amount, and an icon count with no printed dimension or legend mark is dropped and disclosed instead of trusted.
   - Default every finding to `needs_review`.
   - The job's `output_summary.reading_mode` records what the provider actually inspected: `visual_pdf`, `visual_page_images`, `text_only` or `unknown`. It is assigned by the server from the reader's declared capability, never by model output, and `output_summary.visual_evidence_count` counts the findings that rest on graphic evidence.
   - Allow accepted findings to generate draft takeoff quantities; rejected findings never affect estimate math.
   - Authenticated users have no direct table privilege on `plan_reading_findings` (only the worker's service-role connection does) — review goes through `public.set_plan_reading_finding_status(finding_id, new_status)` (`supabase/migrations/0015_...`), a narrow RPC that checks the caller's workspace role and only ever changes `status`. `PATCH /api/ai-plan-readings/findings/:id` and the AI Estimator modal's Add/Ignore buttons call it.

7. **Pricing and model behavior**
   - Gemini is the production reader. The request handler uses one configured `GEMINI_MODEL` and disables SDK retries so one paid attempt does not silently fan out into provider retries.
   - If Gemini is missing, unavailable, or returns no usable source-backed quantity, the job is marked failed and no substitute quantities are stored.
   - Every reader output goes through `apps/api/src/ai-plan/types.ts`'s `sanitizePlanReadingResult`: a quantity without a source page and source excerpt, or a unit outside SF/LF/EA/CY/SY/HR/LS, is dropped and disclosed in `summary.limitations` rather than trusted.
   - `apps/api/src/ai-plan/pricing.ts` prices findings with `calculateProject` (the same fixed-point engine `packages/domain` uses for estimates): every `material` finding produces a material line at its quantity plus a companion install-labor line, and every `labor` finding produces its own labor line. Rates are seeded from a New England (CT/MA/ME/NH/RI/VT) benchmark — see "New England ML Method" below — split into material/labor shares, with a generic unit-based fallback for anything unmatched.
   - The priced detail per finding is stored in that finding's `geometry.pricing`; the job's `output_summary.pricing` carries the material/labor/direct cost totals and how many findings were priced vs. left for manual pricing.
   - `AiPlanReadingService.create()` refuses to run at all unless the workspace has `ai_processing_consented_at` set (see Security Rules) and enforces a per-workspace daily cap (`AI_PLAN_DAILY_JOB_LIMIT`, default 25).
   - Every Gemini generation separately reserves against the database-atomic company-wide `provider_spend_policy`. Failed or missing telemetry retains the full reservation instead of being treated as $0.
   - Findings are written through a service-role Supabase connection constructed inline in the request handler (`apps/api/src/http/handler.ts`), the same way the billing endpoint already builds a service-role repository per-request — never a separate always-on process, and never a key sent to the browser.

8. **Estimate integration**
   - Accepted measurements map into RoughBid quantity groups.
   - Accepted material and labor findings carry a priced suggestion (see Pricing above) an estimator can accept, adjust, or reject before it becomes a real estimate line.
   - Proposal/export remains blocked until plan, quantity, estimate, and review gates are complete.

## Required Runtime Configuration

- `GEMINI_API_KEY`: server-only key for multimodal plan extraction. Missing or invalid configuration disables AI output instead of producing a simulated takeoff.
- `GEMINI_MODEL`: default `gemini-3.8-flash`.
- `SUPABASE_SERVICE_ROLE_KEY`: used inline for paid quote creation, webhook reconciliation, job reservation, and inserting `plan_reading_findings`.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: required before project-reading checkout can charge or grant a paid quote.
- `PROJECT_PRICING_VERSION`, `PROJECT_COST_BASE_CENTS`, `PROJECT_COST_PAGE_CENTS`, `PROJECT_COST_TRADE_CENTS`, `PROJECT_PAYMENT_FIXED_CENTS`, `PROJECT_PAYMENT_FEE_BPS`: required measured cost policy for dynamic per-project charges. The charge itself is cost-plus: measured cost (base + pages + trades + fixed card fee), plus 30%, then the membership factor (2.00 without a membership, 1.85 Starter, 1.70 Pro, 1.60 Team), never below that membership's minimum-margin floor.
- `STRIPE_PRICE_PLAN_STARTER`, `STRIPE_PRICE_PLAN_PRO`, `STRIPE_PRICE_PLAN_TEAM`, `STRIPE_PRICE_PLAN_ENTERPRISE`: optional membership price ids; subscription checkout remains off unless `BILLING_MEMBERSHIPS_ENABLED=true`.
- Private object storage credentials (`OBJECT_STORAGE_*` or `BLOB_READ_WRITE_TOKEN`) for the uploaded plan PDF this reads and the rendered page images the blueprint viewer shows.
- `REDIS_URL`: only needed for the Poppler page-rendering queue (viewer thumbnails) — AI plan reading does not use it.
- `AI_PLAN_DAILY_JOB_LIMIT`: optional per-workspace daily cap on AI plan-reading jobs, default 25.
- `AI_PLAN_ALLOW_TEXT_ONLY_READING`: must stay unset. It is the only override that lets a text-extraction reader (which never inspects the drawing) serve a plan reading, and it exists solely for an explicitly disclosed text-only benchmark.
- `LOW_COST_VISION_MAX_PAGES`: optional page-image count per request for image-native providers, 1–16, default 8.

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
2. **Kimi K2.6** — optional image-native fallback; Kimi's API policy states API inputs/outputs are not used for model training.
3. **DeepSeek Flash** — cost-optimized optional route, but private/customer plan processing stays behind a separate explicit privacy gate until the applicable data-use/opt-out posture is accepted.

For synthetic, public, or otherwise authorized non-confidential benchmark sets, DeepSeek can be moved earlier in `AI_PLAN_PROVIDER_ORDER` after the privacy gate is intentionally enabled.

Controls:

- `AI_PLAN_PROVIDER_ORDER` controls routing order.
- DeepSeek and Kimi are independently disabled by default and require server-only credentials.
- DeepSeek additionally requires `DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED=true`; the key and enable flag alone cannot open private-plan processing.
- DeepSeek/Kimi resolve their page images lazily from RoughBid's own private rendered pages and fail before a network request when none are available; this preserves the existing Gemini PDF path and prevents surprise spend.
- Kimi requires an explicit region-matched base URL because international and China Open Platform credentials are separate.
- All paid providers pass through the same database company-spend breaker before generation.
- Unknown cost telemetry is conservative: the spend reservation remains counted rather than being treated as zero cost.
- Do not activate a new provider until real construction-plan benchmarks verify extraction quality, cost, and evidence integrity.

### Reading the drawing itself

Every plan reader declares a server-side `visualCapability`:

- `pdf_native` — the construction PDF is sent whole and the provider reads the drawing (paid Gemini, pilot Gemini, owner-free Gemini, optional Claude).
- `page_images` — server-rendered raster pages of the drawing (DeepSeek, Kimi).
- `text_only` — PDF text extraction only, no drawing inspection (the OpenRouter free adapter).

`assertReaderInspectsDrawing` refuses a `text_only` reader before any reservation, download or provider call, and `MultiProviderPlanReader` excludes `text_only` readers from the chain and refuses to be constructed from them alone. The stored `output_summary.reading_mode` then tells every reviewer and every downstream consumer whether the drawing itself was inspected.

### Page-image prerequisite (implemented)

Image-native providers cannot read a construction PDF, so they receive RoughBid's own private
rendered page images instead of a public image URL:

- the Poppler document worker writes `project_file_pages` JPEGs (2000px) for the in-app viewer; and
- `apps/api/src/ai-plan/plan-page-images.ts` resolves those same private objects for a provider, bounded (8 pages / 12 MB per page / 24 MB total by default), tenant-scoped by the
  `workspace/project/file/pages/` storage prefix, and loaded lazily so the PDF-native path never pays for a render it will not use.

The loader is best-effort: if pages are missing or unreadable, the image-native provider fails closed
on its own (`503`, no request sent) instead of the whole reading crashing. Page assets stay private and
are sent to a provider only after the workspace AI-processing consent and the existing tenant/payment/
entitlement gates pass.

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

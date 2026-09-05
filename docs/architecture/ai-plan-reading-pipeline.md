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

3. **AI reading job**
   - Create a `plan_reading_jobs` row and run the read **synchronously, inline in the same API request** (`AiPlanReadingService.create()`) — there is no queue and no separate worker process for this step. An earlier BullMQ-queued design needed exactly that kind of separately-deployed worker and never actually had one running in production; sending the PDF straight to the model in the request handler is what shipped and worked.
   - The model (Gemini, via `apps/api/src/ai-plan/gemini.ts`) receives the uploaded PDF inline (base64), so this only needs the upload itself to have finished — not the page-rendering step above.

4. **Extraction targets**
   - Measurements and dimensions.
   - Rooms/areas and sheet/page references.
   - Materials and fixture/symbol counts, each with a quantity and unit (`material` findings).
   - Labor/service scope implied by the drawings — demolition, framing, install labor, trade rough-ins — each with its own quantity and unit (`labor` findings), priced independently of the material it goes with.
   - Scope notes and exclusions.
   - Ambiguous items that require estimator review.
   - Risk flags such as missing scale, conflicting revisions, unreadable pages, or incomplete schedules.

5. **Evidence and review**
   - Save every extracted item as a `plan_reading_findings` row.
   - Include confidence, page number, geometry/source excerpt, and review status.
   - Default every finding to `needs_review`.
   - Allow accepted findings to generate draft takeoff quantities; rejected findings never affect estimate math.
   - Authenticated users have no direct table privilege on `plan_reading_findings` (only the worker's service-role connection does) — review goes through `public.set_plan_reading_finding_status(finding_id, new_status)` (`supabase/migrations/0015_...`), a narrow RPC that checks the caller's workspace role and only ever changes `status`. `PATCH /api/ai-plan-readings/findings/:id` and the AI Estimator modal's Add/Ignore buttons call it.

6. **Pricing**
   - `apps/api/src/ai-plan/gemini.ts` (`GeminiPlanReader`) sends the plan inline to Gemini, tries each candidate model in `GEMINI_MODEL`'s fallback list, and — if every attempt fails or no `GEMINI_API_KEY` is configured — falls back to a clearly-labeled synthetic takeoff (`generateDeterministicTakeoff`) so the estimator always has a starting checklist instead of a hard error. `apps/api/src/ai-plan/types.ts`'s `sanitizePlanReadingResult` validates every finding the same way regardless of source: a quantity without a verbatim `source_excerpt`, or a unit outside SF/LF/EA/CY/SY/HR/LS, is dropped and disclosed in `summary.limitations` rather than trusted.
   - `apps/api/src/ai-plan/pricing.ts` prices findings with `calculateProject` (the same fixed-point engine `packages/domain` uses for estimates): every `material` finding produces a material line at its quantity plus a companion install-labor line, and every `labor` finding produces its own labor line. Rates are seeded from a New England (CT/MA/ME/NH/RI/VT) benchmark — see "New England ML Method" below — split into material/labor shares, with a generic unit-based fallback for anything unmatched.
   - The priced detail per finding is stored in that finding's `geometry.pricing`; the job's `output_summary.pricing` carries the material/labor/direct cost totals and how many findings were priced vs. left for manual pricing.
   - `AiPlanReadingService.create()` refuses to run at all unless the workspace has `ai_processing_consented_at` set (see Security Rules) and enforces a basic per-workspace daily cap (`AI_PLAN_DAILY_JOB_LIMIT`, default 25) so a bug or abuse can't run away with AI spend.
   - Findings are written through a service-role Supabase connection constructed inline in the request handler (`apps/api/src/http/handler.ts`), the same way the billing endpoint already builds a service-role repository per-request — never a separate always-on process, and never a key sent to the browser.

7. **Estimate integration**
   - Accepted measurements map into RoughBid quantity groups.
   - Accepted material and labor findings carry a priced suggestion (see Pricing above) an estimator can accept, adjust, or reject before it becomes a real estimate line.
   - Proposal/export remains blocked until plan, quantity, estimate, and review gates are complete.

## Required Runtime Configuration

- `GEMINI_API_KEY`: server-only key for multimodal plan extraction. Optional — its absence degrades to a synthetic placeholder takeoff rather than disabling the feature.
- `GEMINI_MODEL`: default `gemini-3.8-flash`, with `gemini-3.6-flash` as an automatic fallback.
- `SUPABASE_SERVICE_ROLE_KEY`: used inline (never in a separate worker) for the one write authenticated users can't make directly — inserting `plan_reading_findings`.
- Private object storage credentials (`OBJECT_STORAGE_*` or `BLOB_READ_WRITE_TOKEN`) for the uploaded plan PDF this reads and the rendered page images the blueprint viewer shows.
- `REDIS_URL`: only needed for the Poppler page-rendering queue (viewer thumbnails) — AI plan reading does not use it.
- `AI_PLAN_DAILY_JOB_LIMIT`: optional per-workspace daily cap on AI plan-reading jobs, default 25.

## Security Rules

- Do not send plan files to AI unless the workspace has accepted the data/AI policy — enforced in code: `workspaces.ai_processing_consented_at` must be set (an owner grants this once via `POST /api/workspaces/:id/ai-consent`, surfaced as an approval prompt on the Plans page) before `AiPlanReadingService.create()` will queue a job.
- Keep all plan objects private and tenant-scoped.
- Never expose service-role, storage, Stripe, Resend, or AI keys to the web app.
- Store model output as reviewable findings, not silently trusted estimate data.
- Log job status and errors without storing raw secrets or unnecessary personal data.

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

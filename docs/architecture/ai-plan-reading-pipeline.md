# RoughBid AI Plan Reading Pipeline

RoughBid's AI plan reader should behave like an estimating assistant, not a final authority. Every extracted quantity, note, symbol, and risk needs source evidence and human review before it can affect an estimate.

## Production Flow

1. **Upload gate**
   - Accept only PDF plans through private object storage.
   - Verify file type, size, object presence, and tenant ownership before processing.
   - Store uploads under `workspace/project/file` paths.

2. **Page rendering**
   - Convert each PDF page to JPEG using the existing Poppler worker.
   - Store page images in private storage.
   - Record page count and metadata in `project_files` and `project_file_pages`.

3. **AI reading job**
   - Create a `plan_reading_jobs` row for a processed file.
   - Queue a `read-plan` job only after the file is `ready`.
   - Run the model with page images, OCR text when available, project scope, and explicit extraction schema.

4. **Extraction targets**
   - Measurements and dimensions.
   - Rooms/areas and sheet/page references.
   - Materials and fixture/symbol counts.
   - Scope notes and exclusions.
   - Ambiguous items that require estimator review.
   - Risk flags such as missing scale, conflicting revisions, unreadable pages, or incomplete schedules.

5. **Evidence and review**
   - Save every extracted item as a `plan_reading_findings` row.
   - Include confidence, page number, geometry/source excerpt, and review status.
   - Default every finding to `needs_review`.
   - Allow accepted findings to generate draft takeoff quantities; rejected findings never affect estimate math.

6. **Estimate integration**
   - Accepted measurements map into RoughBid quantity groups.
   - Accepted material findings can suggest assemblies or price-book items.
   - Proposal/export remains blocked until plan, quantity, estimate, and review gates are complete.

## Required Runtime Configuration

- `OPENAI_API_KEY`: server-only key for multimodal plan extraction.
- `OPENAI_MODEL`: default `gpt-4.1` unless a project-specific model is approved.
- `REDIS_URL`: queue transport for PDF and AI processing.
- `SUPABASE_SERVICE_ROLE_KEY`: worker-only writes for findings, never exposed to the browser.
- Private storage credentials for plan source PDFs and page images.

## Security Rules

- Do not send plan files to AI unless the workspace has accepted the data/AI policy.
- Keep all plan objects private and tenant-scoped.
- Never expose service-role, storage, Stripe, Resend, or AI keys to the web app.
- Store model output as reviewable findings, not silently trusted estimate data.
- Log job status and errors without storing raw secrets or unnecessary personal data.

## Tavily Status

Tavily is intended for current market/context research around construction terminology and estimating best practices, not for reading private customer plans. The connector still returned a reauthentication error on 2026-09-04, so this pipeline document is implementation-driven and not represented as Tavily-verified research.

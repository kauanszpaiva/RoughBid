# Gemini plan reading

Second provider: [OpenRouter Free integration and activation status](openrouter-free-plan-reading.md).

Updated 2026-09-04 (America/New_York). Based on deployed branch `review/bruno-v2`
at `d272fe9`, not the older main branch or the original Bruno ZIP.

## Working flow

1. Confirm email and create a workspace. Workspace insertion and read-back use separate
   requests so the owner-membership trigger finishes before the SELECT policy runs.
2. Upload a private PDF, up to 12 MB and 60 pages. Validate actual byte count, PDF content,
   encryption, and page count. No Redis, Poppler, rendered-page worker, or paid OpenAI call.
3. Select areas/trades and click **Read with Gemini**. The app discloses transmission to
   Google and free-tier data handling. Only authorized documents should be submitted.
4. Gemini 3.5 Flash-Lite reads the original PDF. Unknown quantities remain null. Invalid
   output, missing numeric evidence, truncated responses and quota failures fail visibly.
5. Results remain `needs_review`; display page, source excerpt, confidence and coverage.
   Accept/reject decisions persist with reviewer and timestamp. Only explicit acceptance
   adds a quantity. Prices and final money math remain estimator-controlled.

The browser CSP permits only the specific Vercel Blob upload endpoint plus private
Blob download hosts. Signed-in identity replaces legacy demonstration profile data.
PDF.js renders original pages locally with page navigation, zoom and responsive width;
the former browser PDF embed and sample-blueprint fallback are removed.

## Server configuration

- `GEMINI_API_KEY`: server-only Google AI Studio credential. Use a Google project on the
  **Free tier**, without paid billing. Model choice alone cannot impose a billing cap on
  a Google project whose owner later enables billing.
- `SUPABASE_PLAN_FUNCTION=roughbid-plans`: run the shared handlers in the project's
  Supabase Edge Function. Its built-in service-role key never leaves Supabase.
- Existing `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `BLOB_READ_WRITE_TOKEN`.
- Alternatively, direct Node execution accepts `SUPABASE_SECRET_KEY` or
  `SUPABASE_SERVICE_ROLE_KEY` on the server.

Vercel forwards the authenticated user's JWT and server credentials over HTTPS to the
same project's function. The gateway verifies JWTs; handlers verify the user, workspace
role and project visibility with the caller's RLS client before administrative writes.
Credentials are neither returned to clients nor logged. Download URLs remain temporary.

Build function: `node scripts/build-plan-function.mjs`. Deploy `index.ts` and `deno.json`
from `supabase/functions/roughbid-plans/`, with `verify_jwt=true` and explicit import-map
path `deno.json`. Rebuild/redeploy it whenever its shared backend sources change.

Apply `20260905003140_free_plan_access_consistency.sql`: the existing free-trial trigger
issued `access_grant`, while the access predicate still checked obsolete `class_pass`.
The correction retains user, start-date, expiry and revocation checks.

## Validation

- 148 automated tests; API and frontend TypeScript checks; production build and browser
  bundle secret scan.
- Real confirmed-email login, workspace/project creation, private Blob upload and PDF
  page validation against live Supabase, including the public production API at
  https://roughbid.vercel.app/app/.
- Real Gemini extraction from a clearly labeled synthetic PDF: explicit 120 SF and two
  doors, with missing scale identified. Reading, findings, review and quantity read back
  from the database. Repeated processing reuses the completed job.
- Production browser: confirmed-email login, private PDF upload, real Gemini reading,
  saved findings and explicit acceptance of two doors into the Quantities table.
- Unit negatives: invalid PDFs, 61 pages, oversized downloads without Content-Length,
  truncated AI output, evidence outside the PDF, quota failures, viewer/cross-workspace
  access, and competing claims. The workspace daily check is a best-effort abuse limit;
  the Google Free tier is the provider cost boundary.
- Reusable live smoke: `scripts/smoke-plan-reading.mjs`, with a real test-session token in
  `ROUGH_TEST_ACCESS_TOKEN`. Set `ROUGH_TEST_BASE_URL` to check the deployed API. Test
  documents and generated evidence are clearly labeled and excluded from source control.

## Still required before paid launch

- Approved pricing/Stripe offers and full payment-webhook acceptance tests.
- Approved proposal/legal templates and public policy text (current documents are drafts).
- Atomic usage reservations and durable per-account cost caps before enabling paid AI.
- Large/scanned/multi-trade plan evaluation: this live smoke proves one synthetic page,
  not quantity accuracy for arbitrary 60-page construction sets.
- Restore/import drills, monitoring alerts, and workspace administration follow-ups.
- Broader mobile and estimator-flow acceptance beyond this synthetic upload/read/review.
- Existing high-severity npm advisories in the Prisma development-tool dependency chain;
  changing that chain needs a separate database-tool compatibility check.

References: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing),
[PDF input](https://ai.google.dev/gemini-api/docs/document-processing),
[structured output](https://ai.google.dev/gemini-api/docs/structured-output),
[Supabase internal secrets](https://supabase.com/docs/guides/functions/secrets).

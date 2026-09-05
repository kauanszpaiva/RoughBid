# OpenRouter Free plan reading

The Plans screen now offers **OpenRouter Free** and **Gemini**. The choice is stored
with the job; cached Gemini results do not substitute for an OpenRouter request.
There is no automatic fallback between providers.

## Free API boundary

- Fixed `openrouter/free` router, with maximum prompt, completion, request and image
  prices set to zero. No user-supplied model or paid router can replace it.
- Explicit `file-parser` / `cloudflare-ai` PDF conversion, documented as free.
  Do not omit this setting: OpenRouter's default OCR can be paid.
- Quota, authentication, payment and unavailable-provider errors stop processing.
  RoughBid does not buy credits, upgrade plans or retry with a paid model.
- Free capacity has daily limits and availability constraints; this is not unlimited
  hosting or a guarantee that third-party pricing will never change.

This route converts the PDF to text/markdown. It always reports partial coverage;
drawings, symbols, scale and unlabeled measurements still require original-page review.
Findings require page/source evidence and explicit user acceptance before quantity use.
The chosen downstream model and reported cost are retained in the saved result when
the API returns them. The UI discloses OpenRouter, Cloudflare and provider data handling.

## Activation

Set `OPENROUTER_API_KEY` only in Vercel server environment variables and redeploy.
Create it at https://openrouter.ai/settings/keys without purchasing credits.
Gemini's existing key remains independent. Neither provider key is needed just to
upload or view a private PDF. `GET /api/ai-plan-providers` requires a signed-in user
and exposes configuration booleans, never credentials.

Rebuild/deploy the shared Supabase function with `node scripts/build-plan-function.mjs`
as described in [the deployment guide](gemini-free-plan-reading.md).

## Validation and current limitation

155 automated tests pass, including fixed zero prices/free parser, inline PDF data,
missing credentials, quota/payment failures, malformed output, provider-specific
caching and dispatch. API and frontend TypeScript checks pass.

At implementation time no OpenRouter credential was configured. A successful live
OpenRouter PDF extraction is **not yet verified**. The app shows the missing connection
and keeps the read button disabled for that provider until a key is configured.

Sources: [free router](https://openrouter.ai/openrouter/free),
[PDF conversion](https://openrouter.ai/docs/guides/overview/multimodal/pdfs),
[maximum prices](https://openrouter.ai/docs/guides/routing/provider-selection#max-price),
[free limits](https://openrouter.ai/docs/faq).

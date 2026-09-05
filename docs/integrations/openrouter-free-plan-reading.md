# OpenRouter Free plan reading

The Plans screen now offers **OpenRouter Free Pool** and **Gemini**. The choice is stored
with the job; cached Gemini results do not substitute for an OpenRouter request.
OpenRouter's free router can rotate across currently available free models while the
request remains capped at zero price.

## Free API boundary

- Fixed `openrouter/free` router, with maximum prompt, completion, request and image
  prices set to zero. No user-supplied model or paid router can replace it.
- Explicit `file-parser` / `cloudflare-ai` PDF conversion, documented as free.
  Do not omit this setting: OpenRouter's default OCR can be paid.
- RoughBid no longer applies its own daily AI-reading limit; free-provider rate limits
  are still enforced by the outside provider account.
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

## Validation and current limitations

156 automated tests pass, including fixed zero prices/free parser, inline PDF data,
missing credentials, quota/payment failures, malformed output, provider-specific
caching and dispatch. API and frontend TypeScript checks pass.

On 2026-09-05 the user authorized signup and server-key configuration. The dedicated
key is on the free tier, with a $0 total credit limit and no payment method or credits
purchased. It is configured as a sensitive Vercel production variable.

Live production browser validation in `OpenRouter Free validation`: private synthetic
one-page PDF uploaded and read through the Supabase function. Job
`a689ec27-8d28-407f-9a0a-af7a7ef99f3a` persisted five findings, including the explicit
120 SF and 2 EA doors. The saved result reports `dots-studio/dots-3-note-preview:free`,
`cloudflare-ai`, cost 0, partial coverage and mandatory human review. Independent direct
API extraction also succeeded through a free NVIDIA model with cost 0.

Initial live calls exposed inconsistent JSON formatting from the free router. Requests
now require strict JSON Schema; the reader accepts a complete JSON Markdown wrapper
while still rejecting malformed, truncated or mixed-prose output. The prompt states
the actual page count to prevent confusing provider constraints with uploaded pages.
Free capacity and model quality still vary. Failures remain visible and never trigger
paid fallback. This synthetic text PDF does not establish accuracy on scanned plans,
visual symbols or large commercial sets.

Sources: [free router](https://openrouter.ai/openrouter/free),
[PDF conversion](https://openrouter.ai/docs/guides/overview/multimodal/pdfs),
[maximum prices](https://openrouter.ai/docs/guides/routing/provider-selection#max-price),
[structured output](https://openrouter.ai/docs/guides/features/structured-outputs),
[free limits](https://openrouter.ai/docs/faq).

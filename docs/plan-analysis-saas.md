# Project plan analysis

The plan reader extracts rooms, quantities, source pages, callouts and review questions. It does not set construction rates, material costs, labor costs or the RoughBid service fee. Estimates continue to use contractor-entered costs and deterministic calculations.

## Customer flow

1. Create a workspace project and upload its PDF revision.
2. Select trade scope and request the project processing price.
3. The server inspects physical PDF pages, hashes the file and calculates an immutable quote from the configured cost policy, payment fees and active membership.
4. Stripe checkout collects that exact amount. Only the signed webhook confirms payment.
5. The server reserves a paid attempt for the matching workspace, project and file. A changed PDF cannot consume the authorized reading.
6. Review rooms and findings against the original PDF. Search and filter results, select a finding to open its page and toggle evidenced location boxes.
7. Accept supported quantities into the estimate. Enter construction costs separately.

## Visual evidence

PDF-native Gemini reading is required for this workflow. Text-only extraction cannot promise visual room separation and is not a fallback for paid visual analysis. Geometry uses normalized top-left PDF coordinates, `[x, y, width, height]`. Invalid, unsupported or out-of-page locations are rejected; missing locations remain explicitly unmapped. Boxes are review aids, not surveyed boundaries or independent measurements.

## Activation

Production must have a working Gemini model and credential, `PAID_PLAN_READINGS_ENABLED=true`, a configured project cost policy, and matching Stripe secret/webhook credentials and mode. Price policy uses `PROJECT_COST_BASE_CENTS`, `PROJECT_COST_PAGE_CENTS`, `PROJECT_COST_TRADE_CENTS`, `PROJECT_PAYMENT_FIXED_CENTS`, `PROJECT_PAYMENT_FEE_BPS`, and `PROJECT_PRICING_VERSION`. No speculative price defaults are used. The quote is based on pages and trade scope; charging by detected room area would require a different preflight strategy because that area is not known before inference.

On 2026-09-07 the Vercel production environment did not list Stripe secret/webhook credentials, a Gemini model, or the paid-reading enable flag. Actual paid provider execution and a live checkout/webhook lifecycle remain unverified. UI tests used an explicitly labeled two-page PDF fixture, not a claimed customer AI result.

Validation: 241 automated tests, frontend TypeScript check, and desktop/390px/320px browser review of PDF rendering, room selection, page navigation, search and highlights.

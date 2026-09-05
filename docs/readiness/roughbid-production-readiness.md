# RoughBid release review — 2026-09-05

This release prioritizes a usable manual estimating flow with no AI API dependency. A PDF, quantities and actual entered costs lead to review and proposal export. Optional paid AI is disabled unless an operator explicitly enables and configures it.

## What changed

- Workspace bootstrap has loading, error and retry states. Projects do not become editable before server creation succeeds.
- Account/workspace caches are isolated; saves run in order, failed saves stay visible and drafts can be retried. Persisted PDF references never contain temporary browser blob URLs.
- PDF pages render in-browser with navigation and zoom. Review notes belong to a user-chosen position on a particular page and are saved with the project.
- New quantities have no invented prices. Costs are entered as line totals; changing takeoff quantity preserves the entered unit cost. Changing units requires pricing again.
- Proposal readiness requires a saved plan, valid quantities and actual priced lines. Library pages no longer claim external price feeds or supplier quotes.
- Original PDF upload/preview/download do not require Redis. Optional page processing requires PDF_PAGE_PROCESSING_ENABLED=true.
- Paid AI requires PAID_PLAN_READINGS_ENABLED=true, valid Gemini configuration, payment configuration, workspace consent and a confirmed paid quote. Configured flags do not certify model quota or provider operation.

## Validation

Automated and authenticated browser release checks are in progress. Do not interpret this document as completed user acceptance until the delivery tracker records the production checks.

## Remaining product boundaries

- AI provider quota and paid Stripe checkout are not certified; no paid model or live checkout was run in this release.
- Material/assembly libraries and profile preferences are stored in this browser, isolated by account/workspace; projects and PDF notes are synced to the server.
- Human review of plan measurements, prices, scope and proposal terms is still required.
- Third-party price feeds, automatic code-compliance claims, and support-ticket submission are not connected.

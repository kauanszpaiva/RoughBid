# Simple estimate intake

The primary product flow is: add photos, PDF plans, or both; choose services; approve processing; generate an estimate. Client and location details are optional at draft creation and can be supplied when needed for pricing or project applicability.

## Implemented behavior

- One mixed picker routes PDFs to the existing signed document upload and photos to the existing photo pipeline. Camera capture is available on mobile. Validate the complete selection before uploading; preserve failed selections for retry.
- Quick drafts persist absent client/location/date values as null rather than invented defaults. Detailed project creation retains its required fields. Workspace authorization, project limits and storage isolation are unchanged; no schema migration is required.
- Service selection persists in project state. Scoped quick readings send exact service labels and canonical trades. Full V2 reads the full document; its existing budget panel filters services afterward.
- Included plan and photo access is determined by authenticated project entitlements. Full V2 processing uses the server-issued provider policy with explicit per-PDF limits shown before consent. Missing limits stop processing. Paid access still requires the existing fee/payment confirmation.
- A saved PDF can start reading while the viewer rendering queue is pending. PDF viewer rendering is separate from the analysis acknowledgement.
- Repeated Generate clicks reuse acknowledged jobs with the same source/scope. Job status comes from saved server progress; an acknowledgement does not imply complete quantities or prices.
- Results link to existing measures, estimate and export screens. Missing measured quantities or priced items are shown as pending. Photos without dimensional references cannot establish reliable real-world measurements. The construction budget keeps partial coverage and human-review requirements.

## Verification

`npm test`, backend/web TypeScript checks and the production build cover the existing endpoints and contracts. `scripts/test-simple-estimate-browser.mjs` exercises actual product components against isolated local API/storage mocks: PDF-only, photo-only, mixed, upload retry, Full V2 spend approval, repeated clicks, mobile layout and read-only workspaces. It does not call providers or charge users.

Run `node scripts/test-simple-estimate-browser.mjs` with Playwright installed in `.browser-tests`; the script starts and stops its isolated fixture server. The Durable AI Plan Gate runs this check on pull requests. Optional `ROUGH_BID_PLAYWRIGHT_MODULE` and `ROUGH_BID_CHROMIUM_EXECUTABLE` select an existing browser runtime.

## Production completion criteria

Verify upload and a synthetic signed reading in the intended workspace after deployment. Paid reading and Stripe availability are runtime configuration, not implied by this UI change. Source price coverage, calibration and independent review must complete before a final construction price can be offered. Never label a partial budget as a final quote.

The [product/API blueprint](RoughBid_API_Blueprint.md) records the requested target; the behavior above is the current implementation boundary.

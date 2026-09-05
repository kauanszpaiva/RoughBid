# RoughBid Production Readiness

RoughBid is an independent construction estimating SaaS. Its primary product goal is to make plan upload, AI-assisted plan review, takeoff, estimate math, and proposal export simple enough for nontechnical construction users.

## Agent Review Team

- Product/UX: audited Bruno V2, simplified language, app-first flow, empty states, logo, favicon, and nontechnical estimator workflows.
- Auth/Organization: audited Supabase Auth, workspace bootstrap, role model, and invite links.
- Integrations: audited Vercel, Supabase, GitHub, Stripe, Resend, Tavily, storage, and document-processing surfaces.
- Security/Legal: audited RLS, token handling, billing webhook exposure, headers, legal pages, export claims, and production blockers.

## Ready Now

- App opens at `/`; landing page remains at `/landing`.
- RoughBid copy is independent from any training-program brand.
- Legacy course access was replaced by configurable RoughBid access grants.
- Organization invite links are generated server-side, token-hashed, email-bound, single-use, and expire after 14 days.
- Magic-link login preserves pending invite tokens through the auth redirect.
- Static operational drafts exist for Terms, Privacy, Data Use and AI, and Acceptable Use.
- Favicon and in-app mark use a generated RoughBid logo image.
- Export and review screens no longer claim readiness when a project has no plan, quantities, or priced estimate lines.
- AI plan reading now requires a paid project-reading quote before Gemini receives a plan. The API prices the read from measured cost settings, applies the configured membership margin, opens Stripe Checkout, waits for the signed Stripe webhook, then reserves a reading job with the paid quote. Missing payment, changed files, unapproved workspace AI consent, or missing cost configuration stop the read before any model call.
- Gemini is the configured production reader. If Gemini is not configured, fails, or returns no usable source-backed quantities, RoughBid stores no substitute takeoff and asks the estimator to retry with a valid paid quote. Historical simulated readings are blocked from approval.
- A workspace must explicitly approve AI plan reading (`workspaces.ai_processing_consented_at`) before any of its files are sent to a model; an owner grants this once from the Plans page.
- Every AI-suggested quantity requires estimator approval before it affects a bid: findings stay `needs_review` until an estimator calls `set_plan_reading_finding_status` (accept/reject) through the app.
- Production security headers are configured in Vercel.
- Product, tenanting, pricing, AI routing, data, marketplace, and legal gates are consolidated in `docs/product/roughbid-operating-model.md`.

## Must Finish Before Paid Launch

- Connect real plan upload from the frontend to private storage, document processing, and page preview records.
- Set real `SUPABASE_SERVICE_ROLE_KEY`, Stripe secrets, Stripe webhook secret, object storage credentials, and measured project cost settings in production. `GEMINI_API_KEY` is already staged as a Vercel production secret for the next deployment; keep it server-only.
- Replace the New England benchmark rate table in `apps/api/src/ai-plan/pricing.ts` with a real, licensed, workspace-specific price book (see "New England ML Method" in the architecture doc).
- Apply the paid-reading Supabase migration together with the API deploy, then validate Stripe Checkout and webhook flow end-to-end before switching to live paid reads.
- Create and publish the Resend workspace welcome/invite templates after final copy approval.
- Approve membership monthly prices before enabling subscription checkout. Project reads can be charged dynamically from measured costs; membership discounts only apply after the user's Stripe subscription is active.
- Replace proposal legal terms with jurisdiction/company-approved templates before real client delivery.
- Add audit logs for invite creation, invite acceptance, export creation, and AI-assisted item approval.
- Add rate limits for auth, invite creation, invite acceptance, upload URL creation, and estimate recalculation. Paid AI plan reading has a payment gate, two-attempt quote cap, and a database hard cap of 25 jobs per workspace per day.
- Add admin controls for revoking pending invites and removing members.
- Add workspace settings for company logo, address, license details, default overhead, markup, tax, and proposal footer.
- Add onboarding states for first project, first plan upload, first quantity, first estimate, and first export.
- Add backup/export import restore testing for RoughBid JSON packages.
- Add monitoring alerts for API 5xx, auth failures, Stripe webhook failures, document worker failures, and Resend bounces.

## External App Status

- Vercel: production project is connected; runtime errors must be rechecked after each deploy.
- Supabase: RLS-backed tables are active; workspace invites and legacy access cleanup are applied.
- GitHub: PR #14 carries the RoughBid readiness work.
- Stripe: project-reading Checkout is implemented behind measured cost settings and webhooks. Membership checkout remains disabled until monthly Stripe prices are approved and configured.
- Resend: approval template draft `6db15836-91a2-4b31-b08f-abcd2355d135` exists; publish/send only after sender and copy approval.
- Tavily: useful for research and benchmarking; connector still returned reauthentication errors on 2026-09-04 and is not connected to the app runtime today.
- DocuSign: not needed for current RoughBid scope unless signed contracts/proposals become a product requirement.
- Operating model: the SaaS boundaries are user, organization/workspace, project, client proposal, and marketplace feed.

## User Acceptance Checklist

- New visitor understands RoughBid is for construction estimating within 10 seconds.
- Nontechnical estimator can sign in without password.
- Admin can create a workspace invite link and send it to the intended email.
- Invited user can sign in and accept access only with the matching email address.
- Viewer cannot edit estimates or invite users.
- Estimator can create project, upload plan, add quantities, build estimate, review, and export.
- Empty project never shows fake plan pages, fake AI takeoff, or fake readiness.
- Exported proposal clearly separates client-facing price from internal margin math.
- Legal/policy links are visible from inside the app.
- No secrets are exposed in browser code, repo files, logs, exported packages, or client PDFs.

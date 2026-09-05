# RoughBid Production Readiness

**2026-09-04 update:** See [Gemini integration and current verification](../integrations/gemini-free-plan-reading.md).
The historical AI/upload blockers below are superseded by direct PDF reading with Gemini.
The sections below retain the earlier audit as a historical baseline; use the linked
integration report for current routes, provider configuration, and validation results.

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
- AI plan assistant is clearly marked as a plan-reading workflow preview until the live document AI pipeline is connected.
- Production security headers are configured in Vercel.
- Product, tenanting, pricing, AI routing, data, marketplace, and legal gates are consolidated in `docs/product/roughbid-operating-model.md`.

## Must Finish Before Paid Launch

- Connect real plan upload from the frontend to private storage, document processing, and page preview records.
- Configure `OPENAI_API_KEY`, `REDIS_URL`, and the AI worker runtime so the mounted plan-reading endpoint can process jobs.
- Require estimator approval before any AI-suggested quantity affects a bid.
- Mount and validate Stripe Checkout, Portal, and webhook routes end-to-end before setting a live price.
- Create and publish the Resend workspace welcome/invite templates after final copy approval.
- Add account billing screens once Stripe pricing, limits, refund policy, and plan tiers are approved.
- Replace proposal legal terms with jurisdiction/company-approved templates before real client delivery.
- Add audit logs for invite creation, invite acceptance, export creation, and AI-assisted item approval.
- Add rate limits for auth, invite creation, invite acceptance, upload URL creation, and estimate recalculation.
- Add admin controls for revoking pending invites and removing members.
- Add workspace settings for company logo, address, license details, default overhead, markup, tax, and proposal footer.
- Add onboarding states for first project, first plan upload, first quantity, first estimate, and first export.
- Add backup/export import restore testing for RoughBid JSON packages.
- Add monitoring alerts for API 5xx, auth failures, Stripe webhook failures, document worker failures, and Resend bounces.

## External App Status

- Vercel: production project is connected; runtime errors must be rechecked after each deploy.
- Supabase: RLS-backed tables are active; workspace invites and legacy access cleanup are applied.
- GitHub: PR #14 carries the RoughBid readiness work.
- Stripe: live and test accounts are connected; TEST product `prod_VCHSqTxw7RucUe` exists; no price or live charge should be created without commercial approval.
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

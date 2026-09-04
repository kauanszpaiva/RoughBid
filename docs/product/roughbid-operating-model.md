# RoughBid Operating Model

Status: implementation guide. Owner approval is required before live Stripe prices, public pricing claims, final legal text, or new third-party AI processors go live.

Last reviewed: 2026-09-04.

## Product Goal

RoughBid is an independent construction estimating SaaS. It is built for contractors, estimators, and small construction teams who need a simple way to understand plans, produce quantities, price work, send proposals, and track client acceptance.

The first product screen after login should be the app, not marketing content. The user should see projects, plans, estimates, proposal status, and the next action.

## Separation Model

Every boundary is explicit:

- User: Supabase Auth identity. One user can join multiple organizations.
- Organization/workspace: tenant boundary. Billing, credits, invites, marketplace feeds, and data access belong here.
- Project: construction job boundary. Plans, takeoff findings, estimates, proposal links, and client events belong here.
- Client proposal: public token boundary. A client can open and sign without creating a RoughBid account, but only sees a safe proposal snapshot.
- Marketplace feed: paid data boundary. Code references, regional material tables, labor benchmarks, and supplier imports are separate entitlements.

Browser state is never the source of permission. Supabase RLS and server-side checks decide access.

## Roles

| Role | Workspace access | Project access |
| --- | --- | --- |
| Admin | Billing, members, invites, projects, estimates, files, proposals, audit | Full project access |
| Estimator | Projects, plans, quantities, estimates, client proposals | Create/edit assigned work |
| Viewer | Read-only project data | No mutation |
| Client | Public proposal only | No app account required |

Workspace access and optional project membership must remain separated so a larger contractor can restrict sensitive jobs inside the same organization.

## Login And Invite Flow

1. User enters email.
2. Supabase sends magic-link email.
3. New user profile is created by the private auth trigger.
4. User receives the RoughBid free trial entitlement.
5. User creates an organization or accepts an invite.
6. Invite acceptance must match the invited email.
7. Organization role is created.
8. Project access can be assigned separately when needed.

Resend sends product transactional emails for welcome, organization invites, proposal opened, and proposal signed notifications. Supabase Auth email should use Resend SMTP once the domain is verified in Supabase.

## Business And Pricing

RoughBid sells projects, not tokens.

Recommended customer prices:

| Item | Price | Intended buyer |
| --- | ---: | --- |
| 1 project credit | $7 one time | First paid job |
| 5 project credits | $25 one time | Small contractor |
| 20 project credits | $80 one time | Active estimator |
| Starter | $19/month | Individual contractor |
| Pro | $49/month | Small estimating team |
| Team | $149/month | Multi-seat operation |

Subscriptions make each project cheaper, but every plan must keep at least 50% gross margin after AI, storage, email, data, and Stripe card fees.

## Trial Limits

Trial should be no-card to reduce friction.

- 14 days.
- 2 project credits.
- 2 active projects.
- 25 MB PDF limit per project.
- 3 AI generations per project.
- Verified email required before AI spend.
- No batch processing.
- No team seats.
- Hard stop before $1.00 provider cost per user.
- Soft target at or below $0.80 provider cost per user.

When the trial limit is reached, RoughBid should keep the user's project visible but block new AI-heavy actions until a paid plan or credit pack is active.

## Payment Method

Use Stripe-hosted Checkout for subscriptions, credit packs, and marketplace add-ons.

Source of truth:

- Frontend redirect success is only a UX signal.
- Signed Stripe webhook is the only event that grants credits, subscription status, or marketplace entitlement.
- Stripe Customer Portal handles card updates, invoices, cancellations, and payment method changes.

No live prices should be created until the owner approves the exact public offer, refund/expiration policy, and plan limits.

## Credit And Usage Accounting

RoughBid credits are workspace-scoped.

- Reserve 1 credit when AI estimation starts.
- Capture the credit when the first useful estimate is saved.
- Release the credit if provider failure, validation failure, or user cancellation happens before useful output.
- Keep usage records by provider, model, operation, project, user, estimated cost, actual cost, and sensitive payload flag.
- Use idempotency keys for every financial ledger write.
- Purchased credits expire after 12 months unless legal/owner approval changes that policy.
- Subscription credits reset monthly and do not roll over by default.

## AI Plan Reading

The AI reads plans as an estimating assistant, not as an engineer, architect, inspector, or code official.

Pipeline:

1. Upload PDF to private storage.
2. Verify workspace/project/file ownership.
3. Render pages into private page images.
4. Run OCR and sheet classification.
5. Detect scale, symbols, dimensions, schedules, notes, assemblies, and unclear zones.
6. Create clickable findings with page, geometry, explanation, confidence, and review status.
7. Human accepts/rejects findings.
8. Accepted findings create quantities and estimate suggestions.
9. Deterministic RoughBid math calculates totals, margin, markup, overhead, taxes, and proposal output.

The viewer must stay simple: zoom, fit, pan, beginner labels, clickable dots, and plain-language balloons.

## AI Provider Routing

Use cheap models first and expensive models only where they matter.

Default route:

- Cheap OCR/extraction/classification for page structure and obvious quantities.
- Cached extraction by file hash.
- Stronger model for ambiguous regions, code reasoning, conflicting notes, or final validation.
- Deterministic code performs final money calculations.
- Premium model can audit assumptions, but it cannot become the accounting source of truth.

Provider selection must respect data policy. Private customer plans, addresses, signatures, and client names should not go to a new low-trust provider until the processor is approved.

Official pricing references checked on 2026-09-04:

- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- DeepSeek API pricing: https://api-docs.deepseek.com/quick_start/pricing/
- Alibaba/Qwen pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing

## New England Data Strategy

Do not train on random private construction plans without rights. Build a licensed/versioned data pipeline:

- Public building code references by state where license allows indexing.
- State amendments for CT, MA, ME, NH, RI, and VT.
- Municipality-level notes where public and reusable.
- User-uploaded plan patterns only inside that workspace unless explicit opt-in exists.
- Marketplace price data from licensed tables, supplier imports, public indexes, and user-owned spreadsheets.
- Version every code/feed snapshot by date, source, region, and license basis.

The first ML system should be RAG plus deterministic estimators, not uncontrolled fine-tuning. Fine-tuning can come later after enough approved, reviewed, anonymized examples exist.

## Marketplace

Marketplace add-ons are separate paid feeds:

- New England Code Assistant.
- Regional Material Price Tables.
- Local Labor Benchmarks.
- Supplier Price Import.

Each estimate must show whether a price came from user data, RoughBid defaults, marketplace data, or manual override.

## Legal And Policies

Customer-facing legal copy must make these boundaries clear:

- RoughBid is estimating software, not legal, tax, engineering, architectural, inspection, or permit advice.
- Users remain responsible for verifying plans, codes, quantities, local requirements, contract language, taxes, and final prices.
- AI output requires human review.
- Marketplace data may be incomplete, delayed, or region-limited.
- Sensitive construction and client data is processed according to the privacy/data-use policy.
- Proposal signatures and client acceptance need legal review before being represented as binding e-signatures in every jurisdiction.

Required public documents:

- Terms of Use.
- Privacy Policy.
- Data Use and AI Policy.
- Acceptable Use Policy.
- Security contact.
- Subprocessor list before broader launch.
- Refund/credit expiration policy before paid launch.

## Operational Readiness

Before broad launch:

- Confirm login works on `https://roughbid.vercel.app`.
- Confirm Supabase Auth email redirects to the app domain.
- Confirm Resend transactional sends work from verified sender.
- Confirm invite acceptance creates correct organization role.
- Confirm separate users cannot see each other's organizations.
- Confirm separate organizations cannot mix project IDs, files, estimates, or proposal events.
- Confirm viewers cannot mutate data.
- Confirm Stripe test checkout grants credits only after webhook.
- Confirm trial AI stops before $1.00 provider cost.
- Confirm public proposal opens trigger owner notification.
- Confirm signature flow stores a safe audit event.
- Confirm no secret keys are exposed in the browser bundle.
- Confirm all production legal copy has owner/legal approval.

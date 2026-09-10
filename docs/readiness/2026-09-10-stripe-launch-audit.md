# RoughBid Stripe launch audit — 10 September 2026

Initial inventory verified directly through the Stripe connector at approximately
16:09 UTC; later controlled TEST evidence is recorded below. Account:
`acct_1O0CDnDg0iNecPWH`, dashboard name `Nauakk`; the existing RoughBid product metadata
identifies KSP. The separate BEZ Member Hub sandbox was not used.

## Result

Commercial billing is **not certified for launch**. The existing RoughBid TEST
webhook was repaired and read back successfully. No real charge, LIVE write,
catalog price or subscription was created. The initial inventory below predates
the controlled TEST Checkout documented later in this audit.

| Surface | Directly verified state |
| --- | --- |
| TEST product | `prod_VCHSqTxw7RucUe`, name RoughBid, active, no default price |
| LIVE product | `prod_VB3s2SIgOAxwRR`, name RoughBid, active, no default price; metadata `commercial_pricing=pending_approval` |
| Product prices | Zero in TEST and zero in LIVE for the corresponding RoughBid product IDs; both lists complete |
| TEST webhook | `we_1UDOBDDg0iNecPWHj3MQZbPN`, enabled, API version `2025-02-24.acacia`, `https://roughbid.vercel.app/api/webhooks/stripe` |
| LIVE webhook | No RoughBid endpoint in the complete LIVE endpoint list |
| TEST portal configuration | Zero configurations in the complete list |
| LIVE portal configuration | An account-wide default exists; its compatibility with RoughBid terms and products was not certified |
| TEST checkout history | The complete list contained one unrelated KSP Autopilot checkout and zero RoughBid checkouts |

The initial production database audit in the same release session found nine
`project_reading_quotes`, all with `livemode=false` and `status=quoted`; zero
`project_payment_events`; zero `stripe_events`; and zero `billing_customers`.
These database counts agree with the absence of a completed RoughBid payment
lifecycle in Stripe. An existing quoted row is not paid access.

Missing catalog prices block subscriptions. Per-project reading checkout uses
server-generated `price_data` from its immutable quote, so a missing catalog
price alone does not prove that per-project checkout is disabled. It still needs
an approved measured cost policy, correct runtime credentials/mode, a matching
webhook, and a verified payment-to-entitlement lifecycle.

## TEST webhook repair

The existing endpoint initially subscribed to these seven events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`
- `charge.dispute.created`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Added the five events already handled by `apps/api/src/billing/stripe.ts` and
`apps/api/src/billing/endpoints.ts`:

- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`

Stripe returned all 12 events, `livemode=false` and `status=enabled` after the
update. A separate GET of the endpoint confirmed the saved configuration. The
endpoint ID, URL, API version and description were preserved. Its signing secret
was neither retrieved nor rotated. No application code changed for this webhook
repair; the later checkout diagnostic change is described separately below.

## Remaining gates

1. Exercise a RoughBid per-project Checkout in TEST with an authenticated,
   authorized non-owner account outside the sponsored pilot, a real uploaded
   project plan and the server's valid immutable quote. Verify Stripe payment,
   signed delivery, durable quote entitlement and duplicate delivery behavior.
   Owner and active-pilot checkout blocks must remain intact.
2. Verify refund/dispute revocation and the unpaid/failed-payment path using TEST
   records. A saved webhook configuration does not prove successful delivery.
3. Decide and record monthly amounts, limits and customer terms before creating
   membership prices. The current authoritative business plan leaves monthly
   prices and several limits as TBD. Older draft $9/$29/$79 figures are not
   evidence of an approved current commercial contract.
4. Configure and exercise a suitable TEST customer portal and membership purchase,
   renewal, payment failure, cancellation and project discount reconciliation.
5. After TEST certification and approved commercial inputs, configure the intended
   LIVE prices/credentials, RoughBid webhook and portal, then verify the production
   payment lifecycle under explicit charge authorization.

Presence of Vercel environment names, masked `[SENSITIVE]` exports, product
existence, a successful build, `billing:true` or `billingPortal:true` do not prove
correct credentials, approved prices, portal functionality or paid entitlement.
Actual runtime configuration must be checked without exposing secret values.

## TEST payment procedure

The release owner subsequently authenticated the existing non-owner QA account.
The normal API workflow progressed through upload and quote; checkout creation
failed as documented below. The remaining steps do not require creating catalog
prices or changing commercial flags.

1. In the QA account, verify the correct workspace/project, write permission and
   absence of active sponsored-pilot entitlement. Keep the owner exempt.
2. Use its real uploaded PDF and call the application's `reading-quote` route.
   If a saved TEST quote remains valid, it may be reused; otherwise generate a
   fresh quote through the normal API. Do not fabricate rows or revive expired
   quotes. Capture quote ID, amount/currency, `livemode=false` and expiry as QA
   evidence, without presenting the test amount as approved commercial pricing.
3. Open `POST /api/projects/:id/reading-checkout` with that quote ID through the
   authenticated application. Before any payment submission, retrieve the
   resulting `cs_test_...` in the verified KSP TEST account and verify
   `livemode=false`, the expected quote/workspace/project metadata, amount,
   currency and callback URL.
4. Complete Stripe-hosted Checkout with Stripe's documented TEST card
   `4242 4242 4242 4242`, a future expiry and test CVC. Stripe states that test
   transactions do not move funds. Use no real payment instrument.
   [Stripe testing documentation](https://docs.stripe.com/testing).
5. Verify the resulting session is paid and the signed webhook creates durable
   `project_payment_events`, `stripe_events` and the corresponding paid quote.
   Do not write paid state manually. Reopening the project must reflect that
   entitlement without relying on a success-redirect parameter.
6. Verify a duplicate delivery does not duplicate the grant. Refund that same
   TEST payment, confirm the signed refund event revokes the quote, and preserve
   the audit records. Do not start a provider call as part of this payment-only
   test; any AI runtime validation is a separately controlled release step.

## Authenticated TEST attempt at 16:25–16:29 UTC

Normal RoughBid APIs confirmed the existing QA account is not a platform owner
and has no sponsored pilot enrollment. They created a clearly named billing QA
workspace and project. No authentication, entitlement or paid-state database
writes were bypassed.

| Object | Verified identity/state |
| --- | --- |
| QA user | `5d315e9d-59d6-4bb9-b901-ac9a9383ca1a`, `projects@kspdominion.group`, `isPlatformAdmin=false`, pilot `active=false,status=none` |
| Workspace | `048abb46-627d-4afc-b12e-6adae37384a9`, RoughBid Billing QA 2026-09-10, QA role admin |
| Project | `3f31f962-fc58-4436-8455-b34d8d4647c0`, TEST payment lifecycle — real plan 2026-09-10 |
| Completed file | `b1b11061-bed2-4e87-a3f7-9c96eea358d0`, ready, 4,853,211 bytes; first ten pages of the actual supplied PDF |
| File SHA-256 | `ef1be96d0b021534615adb29c33743bdc5ad97606563a950d8366e1ffef0fb05` |
| Normal API quote | `31f065c5-b178-4752-9950-c135abbb7bca`, 1,274 USD cents, 10 pages, Framing, status quoted, 0 attempts, no job |
| Mode/expiry | Supabase read confirmed `livemode=false`, matching file SHA; expires `2026-09-10T17:26:49.874432Z` |

Upload used the signed `PUT https://vercel.com/api/blob/` returned by the normal
upload-url endpoint, followed by normal completion. The project revision was
saved through the normal project PATCH so the real PDF remains accessible in
the QA project's UI. A first upload reservation (`a9631f46-6816-4597-84a0-896b56e532d0`)
remains in uploading state because the local QA URL guard initially rejected
the legitimate trailing slash; it received no bytes and is not the quoted file.

`POST /api/projects/3f31f962-fc58-4436-8455-b34d8d4647c0/reading-checkout`
returned **HTTP 502**, `Could not open secure checkout. Please try again.` The
subsequent complete Stripe TEST session list still contained no RoughBid session.
No test card was submitted and no AI call was started. The test amount is the
runtime quote's output, not evidence of approved commercial pricing.

The failing code discarded Stripe's reason. A small server-only diagnostic patch
logs HTTP status, request ID, error type/code/parameter and quote ID, while
keeping the key, full response body and freeform provider message out of logs.
The focused payment suite passed 11/11, including rejection without payment-state
mutation or sensitive-message leakage.

## Confirmed credential rejection at 16:42:27 UTC

After deployment `dpl_EMRQhktfL43zduRqygWAuDoES4vL` (merged commit
`aadd0234f85fb8922dc50a03306224b57fb0efaa`) became production, the same normal TEST
checkout was retried. It returned HTTP 502 again. Vercel runtime logs, scoped to
that deployment and the preceding five minutes, captured:

```text
Stripe project checkout creation failed
quoteId: 31f065c5-b178-4752-9950-c135abbb7bca
status: 401
requestId: null
type: invalid_request_error
code: null
param: null
```

The upstream failure is therefore Stripe authentication rejection. The current
deployment's `STRIPE_SECRET_KEY` must be replaced or corrected with a valid
credential for the intended KSP TEST account before another checkout attempt.
The diagnostic does not establish whether the configured key is invalid,
revoked, expired or otherwise mismatched; no secret value was exposed. Repeated
checkout attempts before repairing the credential would not complete this gate.

The source request otherwise matches the official Checkout contract: a single
inline `price_data` with product name, 1,274 USD cents, card, quantity one and a
valid 30-minute-to-24-hour expiration window at both attempts. Catalog prices are
not required for this inline price path.
[Stripe Checkout API reference](https://docs.stripe.com/api/checkout/sessions/create).

## Credential correction prepared for the next deployment

An authenticated, dedicated Chrome tab confirmed the exact account
`acct_1O0CDnDg0iNecPWH`, Nauakk, in TEST mode. Its existing TEST secret was reused;
no new key, rotation, revocation or access-policy change was made. A separate
authenticated Vercel tab showed the RoughBid project's `STRIPE_SECRET_KEY` as a
write-only Secret variable scoped only to Production, with an existing note
identifying Nauakk TEST and forbidding live payments.

Only that variable's value was replaced directly from the visible Stripe UI via
an in-memory value. Vercel confirmed **Updated just now**. The Secret type,
Production-only environment, existing note, `STRIPE_MODE`, webhook secret and
all other values were preserved. There was no existing preview key to update.
No credential was saved in a file or repository. Both dedicated tabs were closed.

This change requires a new deployment. No deployment was triggered by the billing
agent, and the payment lifecycle remains uncertified until the normal TEST
Checkout succeeds and its signed webhook grants durable entitlement.

## Hosted TEST payment and signing-secret correction

Production `cfc33dd208b1522fe9b12eceff67592ab469abbe`, deployment
`dpl_BjnLWNBJ9HqTUBikMwrSd56GViij`, picked up the corrected TEST API credential.
A fresh normal API quote, `9612d7ae-752a-47f2-85aa-e77af052458c`, uses the same
QA project and real file above: 1,274 USD cents, ten pages, Framing and explicit
payment-lifecycle-only scope. Stripe independently confirmed TEST mode and the
matching quote/workspace/project metadata before submission of its documented
4242 test card. No real card or funds were used.

- Checkout: `cs_test_a1nQRW8FKQU5VrOTfaMTBWZmaySdFkdayiLpx9Tmp8qMwA8eC5HG6r1jPz`, complete/paid.
- PaymentIntent: `pi_3UEBXODg0iNecPWH45pASfFC`, succeeded, 1,274 USD cents received in TEST.
- Charge: `ch_3UEBXODg0iNecPWH4dezlTg0`.
- Signed event: `evt_1UEBXQDg0iNecPWHrPjf7dB4`, `checkout.session.completed`, `livemode=false`.

The browser returned to `/app/?payment=returned` in the correct QA session. The
initial signed deliveries at 17:13:28 and 17:13:45 UTC failed with HTTP400.
The quote consequently remained quoted, with zero attempts and no AI job.
Stripe payment alone was not treated as application entitlement.

The existing TEST endpoint's signing secret was copied directly through private
in-memory UI state into the existing Production `STRIPE_WEBHOOK_SECRET`. Its
Secret type, note, environment scope and all other settings were preserved.
The endpoint was not recreated or rotated; no secret was written to repository,
scripts or deliverables. The new deployment must consume this corrected value.

The accompanying application fix restores the saved scoped quote on reload
without calculating a new price or starting AI. Payment refresh and AI start
are separate explicit actions. After deployment, resend the original event
from Stripe, verify durable payment and duplicate idempotence, then refund this
same TEST payment and verify signed revocation. Record actual responses and
database/UI evidence; do not write financial state directly.

## Production signature failure isolated to the Node request adapter

PR53 merged as `6f3e830dba473f09889aab0bff352a898f33256f`, production deployment
`dpl_Bf1Cs4XjJFnSyyqnrexFcmzX9nYZ`, with both exact-head CI workflows green
(476 tests and all three Chromium/WebKit gates). The actual browser recovered
the original $12.74 quote, Framing selection and saved payment-only scope after
reload, without starting AI. The pilot also reopened its saved PDF, completed
reading and accepted 1,270 SF quantity on this production version.

The original Stripe event was resent at 17:39:55 UTC. Delivery still returned
HTTP400, with the new server diagnostic identifying `stage: signature`. The
database remained unpaid with zero attempts and no job.

The existing Node bridge reads Vercel's lazy `request.body` helper, which parses
JSON, and then calls `JSON.stringify`. This cannot preserve the exact request
bytes signed by Stripe. The follow-up uses a native Web Request handler only for
the Stripe route, preserving raw bytes and the size bound before forwarding to
the unchanged authentication/reconciliation handler. Other API routes retain
their existing Node adapter. Signature verification is not weakened or bypassed.

Primary references: [Vercel request body helpers](https://vercel.com/docs/functions/runtimes/node-js#request-body),
[Vercel raw body guide](https://vercel.com/kb/guide/how-do-i-get-the-raw-body-of-a-serverless-function),
[Stripe raw-body requirement](https://github.com/stripe/stripe-node#webhook-signing).
The regression reproduces signed JSON with whitespace/Unicode and rejects
changed bytes; actual Stripe delivery must still be verified after deployment.

## Evidence sources

- Stripe `list_available_accounts_or_orgs`; `GetAccountsAccount` confirmed account
  identity. The dedicated account-info tool returned an unsupported-tool error,
  so no conclusion relies on that failed call.
- Stripe `GetProducts`, restricted to each RoughBid product ID in the respective
  mode; `GetPrices` restricted to those product IDs, `has_more=false`.
- Stripe `GetWebhookEndpoints` in TEST and LIVE, both `has_more=false`;
  `PostWebhookEndpointsWebhookEndpoint` followed by
  `GetWebhookEndpointsWebhookEndpoint` in TEST.
- Stripe `GetBillingPortalConfigurations` in both modes, `has_more=false`;
  `GetCheckoutSessions` in TEST, `has_more=false`.
- Repository contracts: `docs/business-finance-pricing.md`,
  `docs/integrations/stripe.md`, `docs/readiness/2026-09-08-billing-audit.md`,
  `apps/api/src/billing/{stripe,endpoints,adapters,project-payments}.ts`.

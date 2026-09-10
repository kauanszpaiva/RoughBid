# RoughBid Stripe launch audit — 10 September 2026

Verified directly through the Stripe connector at approximately 16:09 UTC. Account:
`acct_1O0CDnDg0iNecPWH`, dashboard name `Nauakk`; the existing RoughBid product metadata
identifies KSP. The separate BEZ Member Hub sandbox was not used.

## Result

Commercial billing is **not certified for launch**. The existing RoughBid TEST
webhook was repaired and read back successfully. No real charge, LIVE write,
price, subscription, customer, or checkout was created during this audit.

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
now logs HTTP status, request ID, error type/code/parameter and quote ID, while
keeping the key, full response body and freeform provider message out of logs.
The focused payment suite passed 11/11, including rejection without payment-state
mutation or sensitive-message leakage. Deployment and a controlled retry are
required to learn the actual provider rejection; no cause is presumed yet.

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

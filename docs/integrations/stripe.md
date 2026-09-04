# Stripe integration status

- Account surface: official LIVE Stripe account connected to KSP.
- Product: `RoughBid` exists in LIVE mode.
- Product ID: `prod_VB3s2SIgOAxwRR`.
- Test product: `RoughBid` exists in TEST mode.
- Test product ID: `prod_VCHSqTxw7RucUe`.
- Price: intentionally absent until commercial pricing and limits are approved.
- Charges: none created by foundation work.
- Recommended collection surface: Stripe-hosted Checkout for subscriptions.
- Customer lifecycle: use Stripe Customer Portal once a paid plan exists.
- Workspace access grants are not represented as paid Stripe trials. They are application entitlements with configured windows and no card requirement.
- Webhook state: mirror subscription state only after signature verification; persist Stripe event IDs for idempotency.

## Server contract

- `POST /api/billing/checkout` and `POST /api/billing/portal` require server authentication and return only a Stripe-hosted URL.
- Checkout returns `503` while `STRIPE_PRICE_ID` is unset; the server must construct `BillingConfig` from that environment variable.
- `POST /api/webhooks/stripe` reads the raw body, verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`, and treats subscription webhooks as the sole authority for billing status.
- The service-role-only `process_stripe_event` database function claims the Stripe event ID and updates `billing_customers` in the same transaction, making retries safe.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the Supabase service-role key are server-only credentials.

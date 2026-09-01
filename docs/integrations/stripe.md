# Stripe integration status

- Account surface: official LIVE Stripe account connected to KSP.
- Product: `RoughBid` exists in LIVE mode.
- Product ID: `prod_VB3s2SIgOAxwRR`.
- Price: intentionally absent until commercial pricing and limits are approved.
- Charges: none created by foundation work.
- Recommended collection surface: Stripe-hosted Checkout for subscriptions.
- Customer lifecycle: use Stripe Customer Portal once a paid plan exists.
- Class Pass: never represented as a paid Stripe trial. It is an application entitlement with a fixed 60-day window and no card requirement.
- Webhook state: mirror subscription state only after signature verification; persist Stripe event IDs for idempotency.

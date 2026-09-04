# Client View Proposals

Status: data foundation added; API and UI workflow next.

## Goal

A contractor can send a RoughBid estimate to a client. The client opens a public link without creating an account, views a client-safe proposal, and signs from that page. The contractor receives open/sign events.

## Security Model

- Public links use random tokens.
- Database stores only token hashes.
- Anonymous users receive no direct table access.
- Public access must go through API/RPC methods that return only client-safe fields.
- Internal direct costs, margin, markup, supplier costs, and estimator notes stay private.

## Events

Track:
- `opened`
- `downloaded`
- `signed`
- `email_sent`

Every event stores proposal, workspace, timestamp, and bounded metadata. IP addresses should be hashed before storage when needed for fraud/audit.

## Next API Endpoints

- `POST /api/estimates/:id/client-proposal-links`
  - Authenticated estimator/admin creates link.
  - Sends email through Resend when configured.
- `GET /api/client-proposals/:token`
  - Public client-safe proposal view.
  - Records `opened` once and inserts open event.
- `POST /api/client-proposals/:token/sign`
  - Public signature acceptance.
  - Records signed event and notifies contractor.

## Notification

Initial notification path:
- Resend transactional email to estimator on first open and on signature.

Later:
- In-app notification center.
- Webhook integration for CRM/accounting systems.

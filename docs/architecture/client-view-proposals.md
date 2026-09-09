# Client View Proposals

Status: shipped. Database, API and UI are implemented and covered by tests.
Contractors create a link from the Export page; clients open `/proposal/:token`
(rewritten to the app in `vercel.json`) and sign there. Open and signature
notification emails go out through Resend when it is configured.

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

## Implemented API Endpoints

- `POST /api/projects/:projectId/client-proposals` (`apps/api/src/proposals/routes.ts`)
  - Authenticated estimator/admin creates link.
  - Sends email through Resend when configured.
- `GET /api/client-proposals/:token`
  - Public client-safe proposal view.
  - Records `opened` once and inserts open event.
- `POST /api/client-proposals/:token/sign`
  - Public signature acceptance.
  - Records signed event and notifies contractor.

## Notification

Implemented:
- Resend transactional email to the estimator on first open and on signature.

Not built yet:
- In-app notification center.
- Webhook integration for CRM/accounting systems.

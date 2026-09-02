# Export and integration platform

## Proposal worker

`ProposalService` accepts only finalized estimates, renders the branded HTML through a
Playwright/Puppeteer-compatible adapter, and stores the resulting PDF beneath a
workspace-scoped private path. A queue consumer calls `process`; the API can poll the
job status and request a five-minute signed download URL. Deployments should provide a
real durable job repository and object-storage implementation in place of the included
in-memory job registry.

## Integration REST API

All requests are authenticated and resolved to a workspace by the host application.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/integrations` | List workspace connections |
| `POST` | `/api/integrations/authorize` | Start provider OAuth |
| `POST` | `/api/integrations/callback` | Exchange an OAuth code server-side |
| `POST` | `/api/integrations/:connectionId/exports` | Export a finalized estimate |
| `DELETE` | `/api/integrations/:connectionId` | Revoke a connection and delete credentials |

Provider-specific behavior lives behind `IntegrationAdapter`. Implementations for
QuickBooks, Xero, and Procore can therefore map RoughBid's canonical estimate without
changing the public API. Credentials belong in an encrypted `CredentialVault`, never
in API responses. OAuth state values are single-use, workspace-bound, and expire after
ten minutes. Exports use `connectionId:estimateId` as their idempotency key.

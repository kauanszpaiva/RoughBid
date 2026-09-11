# Definition-of-done traceability matrix

This document is the release evidence index. A status may change to `accepted`
only when every required evidence link is present and the named reviewers have
approved the real workflow. Code, tests, previews, deployments, and AI output are
supporting evidence; none is a substitute for real-project acceptance.

Status values: `missing`, `partial`, `implemented`, `verified-real`, `accepted`.

| ID | Requirement | Current status | Implementation evidence | Automated evidence | Real-project evidence | Professional approval |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | Canonical tenant project and authorized collaboration | partial | Projects/workspaces exist; working estimate still includes generic app state | Tenant/RBAC tests | Required | Required |
| A-02 | Multiple versioned plans and supporting media | partial | Versioned PDF flow exists; broader evidence/media registry required | Upload/PDF tests | Required | Required |
| A-03 | Reviewed, complete, evidenced quantities | partial | Quick/pilot reading and gated Takeoff V2 foundation exist | Takeoff and review tests | Required | Estimator |
| A-04 | Six-state New England jurisdiction context | partial | Massachusetts domain rules exist; complete state integration required | Massachusetts unit tests | Required per state | Code/jurisdiction reviewer |
| A-05 | Detailed estimate with waste and logistics | partial | Active estimate plus inactive V2 cost model | Calculation/V2 tests | Required | Estimator |
| A-06 | Versioned price and assumption provenance | partial | V2 price-source schema exists; active workflow integration required | V2 schema/domain tests | Required | Estimator/procurement |
| A-07 | Same canonical inputs produce identical values for two users | missing | Server-canonical workflow required | Golden replay test required | Two-account replay required | Estimator |
| A-08 | Web/mobile estimate and exports | partial | Responsive app and PDF/CSV exports exist | Responsive/export tests | Mobile field run required | Estimator |
| B-01 | Approved baseline, planning, schedule, and responsibility | missing | Required | Required | Required | PM/superintendent |
| B-02 | Procurement, commitments, deliveries, and invoices | missing | Required | Required | Required | Procurement/accounting |
| B-03 | Change order linked across scope, estimate, execution, and cost | missing | Required | Required | Required real change | PM/estimator/client authority |
| B-04 | Field logs, inspections, RFIs, submittals, and punch/closeout | missing | Required | Required | Required | Superintendent/inspector |
| B-05 | Actual costs and variance reconciliation | missing | Required | Required | Required | PM/accounting |
| C-01 | Device registry, installation, firmware, and calibration | missing | Required | Required | Independent devices required | Hardware/field reviewer |
| C-02 | Declared and validated coverage | missing | Required | Required | Independent sites required | Hardware/field reviewer |
| C-03 | Secure typed telemetry and health monitoring | missing | Required | Required | Independent conditions required | Security/hardware reviewer |
| C-04 | Measurable alert and incident lifecycle | missing | Required | Required | Alert-to-resolution run required | Operations reviewer |

## Evidence rules

For each row moving beyond `partial`, replace `Required` with durable links to:

1. the implementing issue and pull request;
2. tests tied to explicit acceptance criteria;
3. the exact deployed commit and environment;
4. a sanitized real-project evidence record under `docs/acceptance/evidence/`;
5. reviewer name/role, disposition, date, and remaining limitations.

Never store customer plans, addresses, credentials, signed URLs, or confidential
commercial documents in this public repository. Evidence records must use opaque
project identifiers and sanitized summaries.

## Release rule

DONE A, B, or C may be reported as accepted only when every row for that
milestone is `accepted`. Overall DONE requires all three accepted milestones.

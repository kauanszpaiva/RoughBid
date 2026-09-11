# RoughBid product definition of done

Status: approved product target; implementation and acceptance are tracked in
[`docs/acceptance/traceability-matrix.md`](acceptance/traceability-matrix.md).

RoughBid is complete only when an authorized user can register a New England
construction project, collect plans and other evidence, confirm scope, and
receive a detailed and reproducible estimate. The estimate must trace materials,
labor, waste, logistics, and applicable local requirements to their evidence and
versioned sources. Two authorized users must receive identical values from the
same canonical inputs and versions.

Construction execution must connect the approved estimate to planning,
procurement, field execution, changes, inspections, collaboration, and actual
costs without erasing earlier versions. Once monitoring hardware is in scope,
observable risks and deviations must create measurable alerts that remain owned
and tracked until resolution.

Acceptance requires evidence from authorized real projects and review by
professionals from the relevant disciplines. A finished screen, AI response,
automated test suite, green deployment, or Vercel `READY` state does not by
itself prove the complete workflow.

## DONE A — Regional estimate

Ready means:

- a canonical, tenant-isolated project shared by authorized users;
- multiple versioned plans and supporting media;
- reviewed quantities with page/region evidence and explicit coverage limits;
- a confirmed New England jurisdiction and versioned local requirements;
- a detailed estimate covering material, labor, equipment, subcontract, waste,
  freight/logistics, tax, general conditions, contingency, overhead, and profit;
- source, geography, effective date, confidence, and version provenance for
  every applied price or assumption;
- immutable estimate versions and client/internal exports on web and mobile.

Acceptance evidence:

- an authorized real project for each supported state and representative project
  type;
- two distinct authorized accounts reproduce identical values from the same
  canonical input and version set;
- valid sources and reviewer-approved explanations for every difference;
- professional review of takeoff, scope, jurisdiction, rates, and export.

## DONE B — Construction operations

Ready means the approved estimate is connected to schedule and planning,
procurement and commitments, field execution, change orders, inspections,
actual costs, collaboration, and governed lessons learned. Every mutation has an
actor, timestamp, evidence, and version relationship.

Acceptance evidence:

- a real authorized change follows scope → estimate → approval → execution →
  cost reconciliation;
- the previous approved estimate and evidence remain immutable and accessible;
- affected professionals review the operational record.

## DONE C — Monitored construction

Ready means installed hardware has a site/device identity, declared coverage,
calibration evidence, validated detection, telemetry health, measurable alert
rules, and an incident lifecycle through resolution.

Acceptance evidence:

- independent field pilots report metrics by event type, climate, lighting,
  construction site, and physical device;
- alerts record measured value, threshold/rule version, ownership,
  acknowledgement, escalation, and resolution;
- the relevant field and hardware professionals approve the results.

## Complete product gate

`DONE complete = DONE A accepted + DONE B accepted + DONE C accepted`.

The estimate milestone may have commercial value before monitoring hardware is
ready, but the product must not be announced as the complete integrated vision
until all three milestones have their own acceptance evidence.

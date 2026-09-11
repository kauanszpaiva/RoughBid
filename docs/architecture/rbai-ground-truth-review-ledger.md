# RB.AI Ground-Truth Review Ledger

## Why this exists

An AI plan-reading result is not a useful supervised label merely because a user clicked Reject. RoughBid needs to preserve what the model predicted, who reviewed it, and—when the reviewer knows the right answer—the canonical corrected target.

This ledger creates that audit trail without changing the original model output and without treating customer AI-processing consent as model-training permission.

## Review semantics

- `accepted`: the estimator confirms the model target as correct. The current model target becomes canonical ground truth for QA/evaluation.
- `rejected`: the estimator says the prediction is wrong, but no replacement target is known. This is useful negative QA evidence, not a complete supervised target.
- `corrected`: the estimator supplies one or more corrected target fields. The canonical target is the original target merged with the validated correction.
- `needs_review`: workflow state only. Returning a finding to review does not create a ground-truth event.

The original `plan_reading_findings` row remains the model prediction. Corrections are not written over it.

## HTTP review contract

The existing `PATCH /api/ai-plan-readings/findings/:id` contract remains backward compatible for `needs_review`, `accepted`, and `rejected`.

A canonical correction uses:

```json
{
  "status": "corrected",
  "correction": {
    "quantity": 12,
    "unit": "LF"
  }
}
```

Only `finding_type`, `label`, `value_text`, `quantity`, `unit`, and `geometry` may be corrected. The HTTP boundary rejects malformed or unsupported fields before the database call, and the database repeats validation as the authoritative boundary. A corrected response returns the review event rather than pretending the original model prediction was overwritten.

Corrected review writes deliberately use the request-scoped authenticated Supabase client. They do not use the service-role findings writer because `review_plan_reading_finding` depends on `auth.uid()`, workspace-role checks, and product access to preserve tenancy and reviewer attribution.

## Training rights

`training_eligible` is hard-locked to `false` in this migration. The review ledger is for product QA, benchmarking, error analysis, and future dataset preparation only. Enabling training requires a separately reviewed policy and migration that establishes data provenance, customer/owner rights, retention rules, and explicit training eligibility.

## Security, tenancy, and lifecycle

Authenticated workspace members can read review records only when existing workspace and product-access policies permit it. Authenticated users receive no direct insert/update/delete privilege on the review table. Writes go through `review_plan_reading_finding`, which requires an authenticated `admin` or `estimator` in the finding's workspace plus active product access.

Project/file/workspace deletion may cascade review rows to preserve the existing privacy/deletion lifecycle. Reviewer identity uses `ON DELETE SET NULL`: deleting an auth account does not delete the QA event and does not let the audit ledger block account removal. The historical review therefore remains usable while the deleted user's identifier is no longer retained in that foreign-key field.

## Backward compatibility

The existing `set_plan_reading_finding_status` RPC keeps its name, arguments, and `plan_reading_findings` return type. Existing Accept/Reject UI calls therefore keep working. Accepted and rejected transitions now also write a review event. `needs_review` remains a state transition only.

The `corrected` HTTP status is additive. Existing clients never need to send a `correction`, and correction payloads attached to legacy statuses fail closed rather than being silently discarded.

## What this enables next

1. Build a frozen KSP-owned/rights-cleared gold dataset from reviewed findings.
2. Export only the latest canonical review per finding for evaluation.
3. Join review rows to `plan_reading_jobs.model` and project IDs for model/version slices and project-family-safe splits.
4. Measure current RB.AI against the benchmark foundation before changing providers, prompts, geometry logic, or trained models.
5. Prioritize low-confidence/high-cost errors for active review instead of labeling random findings.

## Non-goals

This change does not train a model, claim an accuracy increase, change pricing, alter the Plans UI, or apply a production database migration. It creates the auditable labels required to prove later improvements.

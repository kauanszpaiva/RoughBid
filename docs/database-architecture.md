# Database architecture and migration playbook

## Goals and boundaries

The Prisma schema in `prisma/schema.prisma` is the application data contract. PostgreSQL
remains the source of truth for constraints, append-only enforcement, and Supabase row
security. A tenant is an `Organization`; every project belongs to exactly one tenant.
Organization membership grants a baseline role, while `ProjectMember` records provide an
explicit project role. Application authorization must require organization membership and
then use the project grant when one exists. `OWNER`/`ADMIN` organization roles retain
administrative access; a project grant must never allow a non-member into an organization.

Suggested capabilities are:

| Role | View | Edit plans | Edit estimates | Manage project access |
| --- | --- | --- | --- | --- |
| Organization `OWNER` / `ADMIN` | yes | yes | yes | yes |
| Project `OWNER` | yes | yes | yes | yes |
| Project `EDITOR` | yes | yes | yes | no |
| Project `ESTIMATOR` | yes | no | yes | no |
| Project `VIEWER` or organization `VIEWER` | yes | no | no | no |

All repository queries must include `organizationId`; an ID lookup without its tenant key is
not an authorization check. Use a transaction to verify membership and project capability
before mutations. Supabase installations should extend their existing RLS policies with the
same matrix. Prisma's migration role should own schema changes; the runtime role should not
have `BYPASSRLS` or permission to alter the immutable-record triggers.

## Version model

`ProjectPlan` and `ProjectEstimate` are stable, mutable containers used for names and list
views. Their revision rows are immutable:

* `PlanRevision` stores a monotonically increasing revision number, object path, byte size,
  and SHA-256 digest. Uploading a replacement creates a row; it never overwrites an object.
* `EstimateRevision` stores the complete input in `content`, the calculation engine version,
  and materialized totals. `basedOnRevisionId` makes branching history explainable.
* Allocate revision numbers inside a serializable transaction, or take a PostgreSQL
  transaction advisory lock keyed by the container ID before reading `max(revision_number)`.
  The unique constraints are the final concurrency guard; retry `P2002` conflicts.

`QuoteSnapshot` is not a renamed draft. Exporting copies customer-facing data into `snapshot`
and pins the exact estimate and optional plan revisions. Export content and documents are
immutable, while the small workflow state may move through submitted/accepted/rejected or
voided. Each delivery is an append-only `QuoteSubmission`. A correction therefore means:

1. Create another estimate revision.
2. Export a new quote number and snapshot.
3. Void (do not delete) the superseded quote.
4. Append audit events in the same transaction as each operation.

This permits draft cleanup without changing anything previously sent to a customer.

## Deployment strategy

The migration assumes migrations `0001` through `0003` have run. It renames workspaces to
organizations so IDs and foreign keys remain stable, converts roles/statuses to enums, and
adds versioned tables. It deliberately leaves legacy `project_files` and `estimates` in place
for a staged backfill.

Before deploying:

```sql
SELECT role, count(*) FROM workspace_members GROUP BY role;
SELECT status, count(*) FROM projects GROUP BY status;
SELECT project_id, version, count(*) FROM estimates GROUP BY 1, 2 HAVING count(*) > 1;
```

Deploy and backfill in four releases:

1. **Expand:** back up the database, run `prisma migrate deploy`, deploy code capable of
   reading old rows and writing only the new structures, and add tenant-aware RLS policies.
2. **Backfill:** create one plan/container per legacy stream, copy every historical estimate
   version into an `EstimateRevision`, retain original timestamps/actors, record old IDs in
   revision JSON metadata, and verify row counts and monetary totals. Make the job idempotent
   with a mapping table or stable source IDs.
3. **Cut over:** dual-read and compare, stop legacy writes, drain jobs, then switch reads to
   the new tables. Sample document hashes and quote totals before declaring success.
4. **Contract (later migration):** archive legacy tables only after the audit retention window.
   Never put table drops in the expand migration. Restore the backup to roll back schema;
   during dual-write, replay new revisions before reverting application code.

CI should run `prisma format --check`, `prisma validate`, and migration tests against a clean
PostgreSQL database plus a production-shaped copy upgraded from `0001`-`0003`.

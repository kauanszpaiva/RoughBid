-- This is an additive/renaming migration from the Supabase 0001-0003 schema.
-- Take a backup and run the preflight queries documented in docs/database-architecture.md.

CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'EDITOR', 'ESTIMATOR', 'VIEWER');
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'ARCHIVED');
CREATE TYPE "QuoteStatus" AS ENUM ('EXPORTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'VOIDED');
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'EXPORT', 'SUBMIT', 'STATUS_CHANGE');

ALTER TABLE "workspaces" RENAME TO "organizations";
ALTER TABLE "organizations" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "workspace_members" RENAME TO "organization_members";
ALTER TABLE "organization_members" RENAME COLUMN "workspace_id" TO "organization_id";
ALTER TABLE "organization_members" DROP CONSTRAINT "workspace_members_role_check";
ALTER TABLE "organization_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "organization_members" ALTER COLUMN "role" TYPE "OrganizationRole"
  USING (UPPER("role")::"OrganizationRole");
ALTER TABLE "organization_members" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
ALTER TABLE "projects" RENAME COLUMN "workspace_id" TO "organization_id";
ALTER TABLE "projects" DROP CONSTRAINT "projects_status_check";
ALTER TABLE "projects" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "projects" ALTER COLUMN "status" TYPE "ProjectStatus"
  USING (UPPER("status")::"ProjectStatus");
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");
CREATE INDEX "projects_organization_id_updated_at_idx" ON "projects"("organization_id", "updated_at" DESC);

CREATE TABLE "project_members" (
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "ProjectRole" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id"),
  CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE
);
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

CREATE TABLE "project_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "project_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);
CREATE INDEX "project_plans_project_id_idx" ON "project_plans"("project_id");

CREATE TABLE "plan_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "plan_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL CHECK ("revision_number" > 0), "storage_path" TEXT NOT NULL,
  "original_name" TEXT NOT NULL, "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
  "byte_size" BIGINT NOT NULL CHECK ("byte_size" > 0), "sha256" CHAR(64) NOT NULL,
  "change_summary" TEXT, "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_revisions_plan_id_revision_number_key" UNIQUE ("plan_id", "revision_number"),
  CONSTRAINT "plan_revisions_storage_path_key" UNIQUE ("storage_path"),
  CONSTRAINT "plan_revisions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "project_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "plan_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "plan_revisions_plan_id_created_at_idx" ON "plan_revisions"("plan_id", "created_at" DESC);

CREATE TABLE "project_estimates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "project_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL, "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_estimates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_estimates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "project_estimates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "project_estimates_project_id_updated_at_idx" ON "project_estimates"("project_id", "updated_at" DESC);

CREATE TABLE "estimate_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "estimate_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL CHECK ("revision_number" > 0), "based_on_revision_id" UUID,
  "content" JSONB NOT NULL, "calculation_version" VARCHAR(50) NOT NULL, "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "direct_cost" DECIMAL(14,2) NOT NULL CHECK ("direct_cost" >= 0),
  "overhead_amount" DECIMAL(14,2) NOT NULL CHECK ("overhead_amount" >= 0),
  "markup_amount" DECIMAL(14,2) NOT NULL CHECK ("markup_amount" >= 0),
  "total" DECIMAL(14,2) NOT NULL CHECK ("total" >= 0), "change_summary" TEXT,
  "created_by" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "estimate_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "estimate_revisions_estimate_id_revision_number_key" UNIQUE ("estimate_id", "revision_number"),
  CONSTRAINT "estimate_revisions_id_estimate_id_key" UNIQUE ("id", "estimate_id"),
  CONSTRAINT "estimate_revisions_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "project_estimates"("id") ON DELETE CASCADE,
  CONSTRAINT "estimate_revisions_based_on_revision_id_fkey" FOREIGN KEY ("based_on_revision_id") REFERENCES "estimate_revisions"("id") ON DELETE RESTRICT,
  CONSTRAINT "estimate_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "estimate_revisions_estimate_id_created_at_idx" ON "estimate_revisions"("estimate_id", "created_at" DESC);

CREATE TABLE "quote_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "project_id" UUID NOT NULL,
  "estimate_id" UUID NOT NULL, "estimate_revision_id" UUID NOT NULL, "plan_id" UUID, "plan_revision_id" UUID,
  "quote_number" TEXT NOT NULL, "status" "QuoteStatus" NOT NULL DEFAULT 'EXPORTED', "snapshot" JSONB NOT NULL,
  "document_path" TEXT, "document_sha256" CHAR(64), "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "voided_at" TIMESTAMPTZ(6),
  CONSTRAINT "quote_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_snapshots_organization_id_quote_number_key" UNIQUE ("organization_id", "quote_number"),
  CONSTRAINT "quote_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "project_estimates"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_estimate_revision_fkey" FOREIGN KEY ("estimate_revision_id", "estimate_id") REFERENCES "estimate_revisions"("id", "estimate_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "project_plans"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_plan_revision_id_fkey" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revisions"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_snapshots_void_consistency" CHECK (("status" = 'VOIDED') = ("voided_at" IS NOT NULL)),
  CONSTRAINT "quote_snapshots_plan_pair" CHECK (("plan_id" IS NULL) = ("plan_revision_id" IS NULL))
);
CREATE INDEX "quote_snapshots_project_id_created_at_idx" ON "quote_snapshots"("project_id", "created_at" DESC);

CREATE TABLE "quote_submissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "quote_id" UUID NOT NULL, "submitted_by" UUID NOT NULL,
  "recipient" TEXT NOT NULL, "channel" VARCHAR(30) NOT NULL, "external_ref" TEXT,
  "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_submissions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote_snapshots"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_submissions_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "profiles"("id") ON DELETE RESTRICT
);
CREATE INDEX "quote_submissions_quote_id_submitted_at_idx" ON "quote_submissions"("quote_id", "submitted_at" DESC);

CREATE TABLE "audit_events" (
  "id" BIGSERIAL PRIMARY KEY, "organization_id" UUID NOT NULL, "project_id" UUID, "actor_id" UUID,
  "action" "AuditAction" NOT NULL, "entity_type" VARCHAR(60) NOT NULL, "entity_id" UUID NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}', "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "audit_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT,
  CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE SET NULL
);
CREATE INDEX "audit_events_organization_id_occurred_at_idx" ON "audit_events"("organization_id", "occurred_at" DESC);
CREATE INDEX "audit_events_project_id_occurred_at_idx" ON "audit_events"("project_id", "occurred_at" DESC);
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- Revisions and exported quote payloads are append-only. Corrections create a new row.
CREATE FUNCTION prevent_versioned_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% records are immutable; create a new revision or snapshot', TG_TABLE_NAME; END;
$$;
CREATE FUNCTION protect_quote_snapshot_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'quote snapshots cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'voided_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'voided_at']) THEN
    RAISE EXCEPTION 'exported quote content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plan_revisions_immutable BEFORE UPDATE OR DELETE ON "plan_revisions" FOR EACH ROW EXECUTE FUNCTION prevent_versioned_record_mutation();
CREATE TRIGGER estimate_revisions_immutable BEFORE UPDATE OR DELETE ON "estimate_revisions" FOR EACH ROW EXECUTE FUNCTION prevent_versioned_record_mutation();
CREATE TRIGGER quote_snapshots_protect_content BEFORE UPDATE OR DELETE ON "quote_snapshots" FOR EACH ROW EXECUTE FUNCTION protect_quote_snapshot_content();
CREATE TRIGGER quote_submissions_immutable BEFORE UPDATE OR DELETE ON "quote_submissions" FOR EACH ROW EXECUTE FUNCTION prevent_versioned_record_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION prevent_versioned_record_mutation();

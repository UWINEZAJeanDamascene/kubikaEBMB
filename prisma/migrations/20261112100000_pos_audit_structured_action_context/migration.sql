BEGIN;

-- Add explicit queryable action context without rewriting immutable history.
-- Existing chained rows keep NULL hash_version and continue using v1 hashing.
ALTER TABLE "pos_audit_logs"
  ADD COLUMN "action_id" CHAR(24),
  ADD COLUMN "correlation_id" VARCHAR(128),
  ADD COLUMN "outcome" VARCHAR(16),
  ADD COLUMN "entity_type" VARCHAR(64),
  ADD COLUMN "entity_id" VARCHAR(128),
  ADD COLUMN "hash_version" SMALLINT,
  ADD CONSTRAINT "pos_audit_logs_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('COMMITTED', 'DENIED', 'FAILED', 'OBSERVED')),
  ADD CONSTRAINT "pos_audit_logs_hash_version_check"
    CHECK ("hash_version" IS NULL OR "hash_version" = 2);

CREATE INDEX "pos_audit_logs_company_action_id_idx"
  ON "pos_audit_logs"("company_id", "action_id");
CREATE INDEX "pos_audit_logs_company_correlation_id_idx"
  ON "pos_audit_logs"("company_id", "correlation_id");
CREATE INDEX "pos_audit_logs_company_entity_created_idx"
  ON "pos_audit_logs"("company_id", "entity_type", "entity_id", "created_at");

COMMIT;

ALTER TABLE "pos_sync_exceptions"
  ADD COLUMN "resolution" VARCHAR(40),
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "resolution_reference_type" VARCHAR(24),
  ADD COLUMN "resolution_reference_id" VARCHAR(64),
  ADD COLUMN "resolved_by_id" CHAR(24),
  ADD COLUMN "resolved_at" TIMESTAMPTZ(3),
  ADD COLUMN "retry_authorized_by_id" CHAR(24),
  ADD COLUMN "retry_authorized_at" TIMESTAMPTZ(3);

CREATE INDEX "pos_sync_exceptions_company_status_updated_idx"
  ON "pos_sync_exceptions" ("company_id", "status", "updated_at" DESC);
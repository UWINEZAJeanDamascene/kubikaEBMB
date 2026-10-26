ALTER TABLE "ebm_submission_queues"
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN "prerequisite_type" TEXT,
  ADD COLUMN "prerequisite_endpoint" TEXT,
  ADD COLUMN "prerequisite_operation_key" TEXT,
  ADD COLUMN "fiscal_response" JSONB,
  ADD COLUMN "source_applied_at" TIMESTAMPTZ(3),
  ADD COLUMN "dependents_dispatched_at" TIMESTAMPTZ(3);

DROP INDEX IF EXISTS "ebm_submission_queues_company_id_document_type_document_id__key";

CREATE UNIQUE INDEX "ebm_submission_queues_operation_environment_key"
  ON "ebm_submission_queues"(
    "company_id",
    "document_type",
    "document_id",
    "endpoint",
    "operation_key",
    "environment"
  );

ALTER TABLE "ebm_submission_queues"
  ALTER COLUMN "next_retry_at" DROP NOT NULL;

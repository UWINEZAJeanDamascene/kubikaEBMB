-- Completed legacy rows carried response bodies in the request ledger. Move
-- them to manager reconciliation before removing that column; the old payloads
-- cannot be safely converted to the new authenticated-encryption format in SQL.
UPDATE "pos_idempotency_records"
SET "status" = 'NEEDS_REVIEW',
    "response_status" = NULL,
    "completed_at" = COALESCE("completed_at", CURRENT_TIMESTAMP),
    "lease_expires_at" = NULL
WHERE "status" = 'COMPLETED';

ALTER TABLE "pos_idempotency_records"
  DROP CONSTRAINT IF EXISTS "pos_idempotency_records_result_check";

ALTER TABLE "pos_idempotency_records"
  DROP COLUMN IF EXISTS "response_body",
  ADD COLUMN "result_reference_id" CHAR(24);

CREATE TABLE "pos_idempotency_results" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "idempotency_record_id" CHAR(24) NOT NULL,
  "payload_ciphertext" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_idempotency_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_idempotency_results_record_fkey"
    FOREIGN KEY ("idempotency_record_id") REFERENCES "pos_idempotency_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "pos_idempotency_results_company_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "pos_idempotency_results_record_unique" UNIQUE ("idempotency_record_id")
);

ALTER TABLE "pos_idempotency_records"
  ADD CONSTRAINT "pos_idempotency_records_result_check"
  CHECK ("status" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "result_reference_id" IS NOT NULL));

CREATE INDEX "pos_idempotency_results_company_created_idx"
  ON "pos_idempotency_results"("company_id", "created_at");

CREATE TABLE "pos_idempotency_records" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "scope" VARCHAR(220) NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "actor_id" CHAR(24),
    "register_id" CHAR(24),
    "status" VARCHAR(24) NOT NULL DEFAULT 'PROCESSING',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "pos_idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pos_idempotency_records_company_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "pos_idempotency_records_status_check"
      CHECK ("status" IN ('PROCESSING', 'COMPLETED', 'COMPLETED_NO_REPLAY', 'FAILED_SAFE', 'NEEDS_REVIEW')),
    CONSTRAINT "pos_idempotency_records_result_check"
      CHECK (("status" = 'COMPLETED') = ("response_status" IS NOT NULL AND "response_body" IS NOT NULL))
);

CREATE UNIQUE INDEX "pos_idempotency_records_scope_key"
  ON "pos_idempotency_records"("company_id", "scope", "idempotency_key");
CREATE INDEX "pos_idempotency_records_status_idx"
  ON "pos_idempotency_records"("company_id", "status", "created_at");
CREATE INDEX "pos_idempotency_records_lease_idx"
  ON "pos_idempotency_records"("company_id", "status", "lease_expires_at");
CREATE INDEX "pos_idempotency_records_register_idx"
  ON "pos_idempotency_records"("company_id", "register_id", "created_at");

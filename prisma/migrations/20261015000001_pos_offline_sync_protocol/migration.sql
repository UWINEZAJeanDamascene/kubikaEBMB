CREATE TABLE "pos_processed_operations" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "operation_id" VARCHAR(100) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "sequence" BIGINT NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "operation_state" VARCHAR(24) NOT NULL,
  "device_time" TIMESTAMPTZ(3) NOT NULL,
  "clock_skew_ms" BIGINT NOT NULL,
  "result" JSONB,
  "error" JSONB,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(3),
  CONSTRAINT "pos_processed_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_processed_operations_company_device_operation_key"
    UNIQUE ("company_id", "device_id", "operation_id"),
  CONSTRAINT "pos_processed_operations_company_device_sequence_key"
    UNIQUE ("company_id", "device_id", "sequence")
);
CREATE INDEX "pos_processed_operations_company_state_received_idx"
  ON "pos_processed_operations" ("company_id", "operation_state", "received_at");

CREATE TABLE "pos_sync_exceptions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "operation_id" VARCHAR(100) NOT NULL,
  "error_code" VARCHAR(100) NOT NULL,
  "message" TEXT NOT NULL,
  "operation_payload" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_sync_exceptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_sync_exceptions_company_device_operation_key"
    UNIQUE ("company_id", "device_id", "operation_id")
);
CREATE INDEX "pos_sync_exceptions_company_status_created_idx"
  ON "pos_sync_exceptions" ("company_id", "status", "created_at");

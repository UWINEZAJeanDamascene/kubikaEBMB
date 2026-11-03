ALTER TABLE "pos_shifts"
  ADD COLUMN "handover_from_shift_id" CHAR(24),
  ADD COLUMN "handover_payload_hash" CHAR(64);

DROP INDEX "one_open_shift_per_register";
CREATE UNIQUE INDEX "one_open_shift_per_register"
  ON "pos_shifts"("register_id")
  WHERE "status" IN ('open', 'reopened');

CREATE TABLE "pos_shift_correction_reports" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "shift_id" CHAR(24) NOT NULL,
  "original_z_report_id" CHAR(24) NOT NULL,
  "correction_number" INTEGER NOT NULL,
  "correction_type" VARCHAR(16) NOT NULL,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "prior_close_idempotency_key" VARCHAR(100),
  "payload_hash" CHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "journal_entry_id" CHAR(24),
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_shift_correction_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_shift_correction_reports_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_shift_correction_reports_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_shift_correction_reports_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_shift_correction_reports_original_z_report_id_fkey"
    FOREIGN KEY ("original_z_report_id") REFERENCES "pos_z_reports"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_shift_correction_reports_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_shift_correction_reports_company_id_idempotency_key_key"
  ON "pos_shift_correction_reports"("company_id", "idempotency_key");
CREATE UNIQUE INDEX "pos_shift_correction_reports_company_id_prior_close_idempotency_key_key"
  ON "pos_shift_correction_reports"("company_id", "prior_close_idempotency_key");
CREATE UNIQUE INDEX "pos_shift_correction_reports_shift_id_correction_number_key"
  ON "pos_shift_correction_reports"("shift_id", "correction_number");
CREATE INDEX "pos_shift_correction_reports_company_id_register_id_created_at_idx"
  ON "pos_shift_correction_reports"("company_id", "register_id", "created_at");
CREATE INDEX "pos_shift_correction_reports_shift_id_created_at_idx"
  ON "pos_shift_correction_reports"("shift_id", "created_at");

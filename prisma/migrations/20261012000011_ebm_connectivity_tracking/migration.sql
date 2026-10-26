ALTER TABLE "ebm_devices"
  ADD COLUMN "environment" VARCHAR(20) NOT NULL DEFAULT 'mock',
  ADD COLUMN "last_successful_contact_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_successful_fiscal_at" TIMESTAMPTZ(3);

UPDATE "ebm_devices"
SET "environment" = COALESCE(NULLIF("initialized_mode", ''), NULLIF("last_attempt_mode", ''), 'mock');

DROP INDEX IF EXISTS "ebm_devices_company_id_branch_id_device_serial_no_key";

CREATE UNIQUE INDEX "ebm_devices_company_id_branch_id_device_serial_no_environment_key"
  ON "ebm_devices"("company_id", "branch_id", "device_serial_no", "environment");

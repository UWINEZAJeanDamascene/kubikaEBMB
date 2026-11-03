ALTER TABLE "pos_register_access"
  ADD COLUMN "failed_pin_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pin_locked_until" TIMESTAMPTZ(3);

ALTER TABLE "pos_register_access"
  ADD CONSTRAINT "pos_register_access_failed_pin_attempts_check"
  CHECK ("failed_pin_attempts" >= 0);

CREATE INDEX "pos_register_access_company_id_register_id_pin_locked_until_idx"
  ON "pos_register_access"("company_id", "register_id", "pin_locked_until");

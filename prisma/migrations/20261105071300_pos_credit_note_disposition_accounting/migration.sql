ALTER TABLE "credit_note_lines"
  ADD COLUMN IF NOT EXISTS "return_disposition" VARCHAR(16) NOT NULL DEFAULT 'restock',
  ADD COLUMN IF NOT EXISTS "write_off_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "non_stock_write_off" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "credit_notes"
  ADD COLUMN IF NOT EXISTS "write_off_reversal_entry_id" CHAR(24);

ALTER TABLE "pos_payment_settings"
  ADD COLUMN IF NOT EXISTS "write_off_approval_threshold_rwf" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS "write_off_approval_threshold_by_till_type" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "pos_payment_settings"
  ADD CONSTRAINT "pos_payment_settings_write_off_approval_threshold_rwf_check"
  CHECK ("write_off_approval_threshold_rwf" >= 0);

ALTER TABLE "credit_note_lines"
  ADD CONSTRAINT "credit_note_lines_return_disposition_check"
  CHECK ("return_disposition" IN ('restock', 'write_off'));

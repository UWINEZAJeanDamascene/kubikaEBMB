ALTER TABLE "pos_cash_movements"
  ADD COLUMN "posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT "pos_cash_movements_posting_status_check"
    CHECK ("posting_status" IN ('not_required', 'pending', 'posted', 'failed', 'reversed'));

UPDATE "pos_cash_movements"
SET "posting_status" = CASE
  WHEN "journal_entry_id" IS NOT NULL THEN 'posted'
  WHEN "type" = 'REFUND' THEN 'not_required'
  ELSE 'pending'
END;

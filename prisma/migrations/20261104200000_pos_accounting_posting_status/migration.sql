ALTER TABLE "invoices"
  ADD COLUMN "pos_posting_status" VARCHAR(16);

UPDATE "invoices"
SET "pos_posting_status" = CASE
  WHEN "revenue_journal_entry_id" IS NOT NULL THEN 'posted'
  WHEN "status" IN ('draft', 'PENDING_PAYMENT') THEN 'pending'
  ELSE 'failed'
END
WHERE "pos_origin" = TRUE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_pos_posting_status_check"
  CHECK ("pos_posting_status" IS NULL OR "pos_posting_status" IN ('pending', 'posted', 'failed'));

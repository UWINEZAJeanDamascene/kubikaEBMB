ALTER TABLE "credit_notes"
  ADD COLUMN "pos_posting_status" VARCHAR(16),
  ADD COLUMN "loyalty_reward_reversed" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN "loyalty_reward_consumed" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "credit_notes_pos_posting_status_check"
    CHECK ("pos_posting_status" IS NULL OR "pos_posting_status" IN ('pending', 'posted', 'failed', 'reversed'));

UPDATE "credit_notes" AS credit_note
SET "pos_posting_status" = posting."status"
FROM "pos_accounting_postings" AS posting
WHERE credit_note."company_id" = posting."company_id"
  AND credit_note."id" = posting."source_id"
  AND credit_note."pos_origin" = TRUE
  AND posting."source_type" = 'pos_credit_note';

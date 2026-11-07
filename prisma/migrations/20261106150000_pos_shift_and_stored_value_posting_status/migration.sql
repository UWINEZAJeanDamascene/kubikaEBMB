ALTER TABLE "pos_shifts"
  ADD COLUMN "posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT "pos_shifts_posting_status_check"
    CHECK ("posting_status" IN ('not_required', 'pending', 'posted', 'failed', 'reversed'));

UPDATE "pos_shifts" AS shift
SET "posting_status" = COALESCE(
  (
    SELECT posting."status"
    FROM "pos_accounting_postings" AS posting
    WHERE posting."company_id" = shift."company_id"
      AND posting."source_type" = 'pos_shift_close'
      AND (
        posting."source_id" = shift."id"
        OR posting."source_id" IN (
          SELECT correction."id"
          FROM "pos_shift_correction_reports" AS correction
          WHERE correction."company_id" = shift."company_id"
            AND correction."shift_id" = shift."id"
        )
      )
    ORDER BY posting."updated_at" DESC
    LIMIT 1
  ),
  CASE
    WHEN shift."status" <> 'closed' THEN 'pending'
    WHEN COALESCE(shift."difference", 0) = 0 THEN 'not_required'
    WHEN shift."journal_entry_id" IS NOT NULL THEN 'posted'
    ELSE 'failed'
  END
);

ALTER TABLE "pos_stored_value_ledger"
  ADD COLUMN "journal_entry_id" CHAR(24),
  ADD COLUMN "posting_status" VARCHAR(16) NOT NULL DEFAULT 'not_required',
  ADD CONSTRAINT "pos_stored_value_ledger_posting_status_check"
    CHECK ("posting_status" IN ('not_required', 'pending', 'posted', 'failed', 'reversed'));

UPDATE "pos_stored_value_ledger" AS ledger
SET "posting_status" = COALESCE(
      (
        SELECT queue."status"
        FROM "pos_accounting_postings" AS queue
        WHERE queue."company_id" = ledger."company_id"
          AND queue."source_type" IN ('pos_stored_value_issue', 'pos_stored_value_load', 'pos_sale')
          AND (
            queue."source_id" = ledger."id"
            OR queue."payload"->>'relatedLedgerEntryId' = ledger."id"::text
            OR (queue."source_type" = 'pos_stored_value_issue'
              AND queue."source_id" = ledger."account_id"
              AND ledger."entry_type" = 'issue')
            OR (queue."source_type" = 'pos_sale'
              AND queue."source_id" = ledger."invoice_id"
              AND ledger."entry_type" IN ('redeem', 'earn'))
          )
        ORDER BY queue."created_at" DESC
        LIMIT 1
      ),
      'not_required'
    ),
    "journal_entry_id" = (
      SELECT queue."journal_entry_id"
      FROM "pos_accounting_postings" AS queue
      WHERE queue."company_id" = ledger."company_id"
        AND queue."source_type" IN ('pos_stored_value_issue', 'pos_stored_value_load', 'pos_sale')
        AND (
          queue."source_id" = ledger."id"
          OR queue."payload"->>'relatedLedgerEntryId' = ledger."id"::text
          OR (queue."source_type" = 'pos_stored_value_issue'
            AND queue."source_id" = ledger."account_id"
            AND ledger."entry_type" = 'issue')
          OR (queue."source_type" = 'pos_sale'
            AND queue."source_id" = ledger."invoice_id"
            AND ledger."entry_type" IN ('redeem', 'earn'))
        )
      ORDER BY queue."created_at" DESC
      LIMIT 1
    );

UPDATE "pos_stored_value_ledger" AS ledger
SET "posting_status" = COALESCE(invoice."pos_posting_status", ledger."posting_status"),
    "journal_entry_id" = COALESCE(invoice."revenue_journal_entry_id", ledger."journal_entry_id")
FROM "invoices" AS invoice
WHERE invoice."company_id" = ledger."company_id"
  AND invoice."id" = ledger."invoice_id"
  AND invoice."pos_origin" = TRUE
  AND ledger."entry_type" IN ('redeem', 'earn');

CREATE INDEX "pos_stored_value_ledger_company_id_posting_status_idx"
  ON "pos_stored_value_ledger"("company_id", "posting_status");

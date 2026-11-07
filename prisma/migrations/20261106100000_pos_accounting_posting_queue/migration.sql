CREATE TABLE "pos_accounting_postings" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" CHAR(24) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "journal_entry_id" CHAR(24),
  "journal_entry_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "next_retry_at" TIMESTAMPTZ(3),
  "last_attempt_at" TIMESTAMPTZ(3),
  "posted_at" TIMESTAMPTZ(3),
  "failed_at" TIMESTAMPTZ(3),
  "last_error" JSONB,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_postings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_postings_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_postings_attempts_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"),
  CONSTRAINT "pos_accounting_postings_status_check"
    CHECK ("status" IN ('not_required', 'pending', 'posted', 'failed', 'reversed')),
  CONSTRAINT "pos_accounting_postings_company_source_key"
    UNIQUE ("company_id", "source_type", "source_id"),
  CONSTRAINT "pos_accounting_postings_company_idempotency_key"
    UNIQUE ("company_id", "idempotency_key")
);

CREATE INDEX "pos_accounting_postings_due_idx"
  ON "pos_accounting_postings" ("status", "next_retry_at", "created_at")
  WHERE "status" = 'pending';
CREATE INDEX "pos_accounting_postings_company_status_idx"
  ON "pos_accounting_postings" ("company_id", "status", "created_at" DESC);

ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_pos_posting_status_check";

UPDATE "invoices"
SET "pos_posting_status" = 'not_required'
WHERE "pos_origin" = TRUE
  AND "revenue_journal_entry_id" IS NULL
  AND "status" IN ('draft', 'PENDING_PAYMENT');

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_pos_posting_status_check"
  CHECK (
    "pos_posting_status" IS NULL
    OR "pos_posting_status" IN ('not_required', 'pending', 'posted', 'failed', 'reversed')
  );

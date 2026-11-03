ALTER TABLE "clients"
  ADD COLUMN "credit_account_status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "credit_terms_days" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "clients"
  ADD CONSTRAINT "clients_credit_account_status_check"
    CHECK ("credit_account_status" IN ('ACTIVE', 'ON_HOLD', 'CLOSED')),
  ADD CONSTRAINT "clients_credit_terms_days_check"
    CHECK ("credit_terms_days" BETWEEN 0 AND 3650);

ALTER TABLE "ar_receipts"
  ADD COLUMN "pos_idempotency_key" VARCHAR(100),
  ADD COLUMN "pos_refund_idempotency_key" VARCHAR(100);

CREATE UNIQUE INDEX "ar_receipts_company_pos_idempotency_key"
  ON "ar_receipts"("company_id", "pos_idempotency_key");

CREATE UNIQUE INDEX "ar_receipts_company_pos_refund_idempotency_key"
  ON "ar_receipts"("company_id", "pos_refund_idempotency_key");

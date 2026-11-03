CREATE TYPE "PosPaymentReconciliationStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'MISSING', 'DISPUTED');

CREATE TYPE "PosManualMobileMoneyMode" AS ENUM ('INSTANT', 'VERIFY');

ALTER TABLE "pos_payments"
ADD COLUMN "normalized_reference" VARCHAR(160),
ADD COLUMN "reconciliation_status" "PosPaymentReconciliationStatus",
ADD COLUMN "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN "confirmed_by_id" CHAR(24),
ADD COLUMN "reconciled_at" TIMESTAMPTZ(3),
ADD COLUMN "reconciled_by_id" CHAR(24);

ALTER TABLE "pos_payment_settings"
ADD COLUMN "manual_mobile_money_mode" "PosManualMobileMoneyMode" NOT NULL DEFAULT 'VERIFY',
ADD COLUMN "manual_mobile_money_receivers" JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX "pos_payments_company_id_method_normalized_reference_key"
ON "pos_payments"("company_id", "method", "normalized_reference");

CREATE INDEX "pos_payments_company_id_method_reconciliation_status_created_at_idx"
ON "pos_payments"("company_id", "method", "reconciliation_status", "created_at");

CREATE INDEX "pos_payments_company_id_cashier_id_created_at_idx"
ON "pos_payments"("company_id", "cashier_id", "created_at");

ALTER TABLE "pos_payments"
ADD CONSTRAINT "pos_payments_confirmed_by_id_fkey"
FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "pos_payments_reconciled_by_id_fkey"
FOREIGN KEY ("reconciled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

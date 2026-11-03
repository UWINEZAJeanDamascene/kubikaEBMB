CREATE TYPE "PosPaymentFlow" AS ENUM ('LEGACY', 'PAYMENTS_V2');
CREATE TYPE "PosPendingSaleExpiryPolicy" AS ENUM ('SHIFT_CLOSE');

ALTER TYPE "PosCashMovementType" ADD VALUE 'REFUND';

ALTER TABLE "pos_payment_settings"
  ADD COLUMN "payment_flow" "PosPaymentFlow" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "register_payment_flow_overrides" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "pending_sale_expiry_policy" "PosPendingSaleExpiryPolicy" NOT NULL DEFAULT 'SHIFT_CLOSE',
  ADD COLUMN "pending_sale_max_age_hours" INTEGER,
  ADD COLUMN "paid_sale_refund_approval_amount" INTEGER NOT NULL DEFAULT 20000,
  ADD COLUMN "paid_sale_refund_approval_count" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "invoices"
  ADD COLUMN "pos_checkout_payload" JSONB,
  ADD COLUMN "pos_completion_key" VARCHAR(100),
  ADD COLUMN "pos_cancellation_key" VARCHAR(100);

CREATE UNIQUE INDEX "invoices_company_id_pos_completion_key_key"
  ON "invoices"("company_id", "pos_completion_key");

CREATE UNIQUE INDEX "invoices_company_id_pos_cancellation_key_key"
  ON "invoices"("company_id", "pos_cancellation_key");

ALTER TABLE "invoice_lines"
  ADD COLUMN "serial_numbers" JSONB NOT NULL DEFAULT '[]';

-- CreateEnum
CREATE TYPE "PosPaymentMethod" AS ENUM ('CASH', 'MTN_MOMO', 'AIRTEL_MONEY', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS');

-- CreateEnum
CREATE TYPE "PosPaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'VOIDED', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS');

-- CreateEnum
CREATE TYPE "PosPaymentRefundStatus" AS ENUM ('PENDING', 'DONE', 'MANUAL_DUE', 'FAILED');

-- CreateEnum
CREATE TYPE "PosPaymentEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "PosStoredValueOperation" AS ENUM ('ISSUE', 'LOAD', 'REDEEM', 'REFUND', 'ADJUST');

-- AlterTable
ALTER TABLE "pos_stored_value_ledger" ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "operation_type" "PosStoredValueOperation",
ADD COLUMN     "pos_payment_id" CHAR(24);

-- CreateTable
CREATE TABLE "pos_payments" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "sale_id" CHAR(24) NOT NULL,
    "shift_id" CHAR(24) NOT NULL,
    "register_id" CHAR(24) NOT NULL,
    "cashier_id" CHAR(24) NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "status" "PosPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "tendered" INTEGER,
    "change_given" INTEGER,
    "reference" TEXT,
    "customer_id" CHAR(24),
    "provider_name" TEXT,
    "provider_tx_id" TEXT,
    "payer_phone" TEXT,
    "external_ref" TEXT,
    "note" TEXT,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_payment_attempts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "payment_id" CHAR(24) NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider_status" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3),
    "raw_response" JSONB,

    CONSTRAINT "pos_payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_provider_events" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24),
    "provider" VARCHAR(32) NOT NULL,
    "event_key" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_ok" BOOLEAN NOT NULL,
    "matched_payment_id" CHAR(24),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_payment_refunds" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "payment_id" CHAR(24) NOT NULL,
    "sale_id" CHAR(24) NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PosPaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "approved_by" CHAR(24),
    "provider_tx_id" TEXT,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_payment_settings" (
    "company_id" CHAR(24) NOT NULL,
    "enabled_methods" JSONB NOT NULL,
    "register_overrides" JSONB NOT NULL DEFAULT '{}',
    "momo_timeout_sec" INTEGER NOT NULL DEFAULT 120,
    "cash_rounding" INTEGER,
    "allow_over_credit_limit" BOOLEAN NOT NULL DEFAULT false,
    "bank_transfer_needs_confirm" BOOLEAN NOT NULL DEFAULT true,
    "provider_environment" "PosPaymentEnvironment" NOT NULL DEFAULT 'sandbox',
    "provider_config" JSONB,

    CONSTRAINT "pos_payment_settings_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE INDEX "pos_payments_company_id_sale_id_idx" ON "pos_payments"("company_id", "sale_id");

-- CreateIndex
CREATE INDEX "pos_payments_company_id_shift_id_method_status_idx" ON "pos_payments"("company_id", "shift_id", "method", "status");

-- CreateIndex
CREATE INDEX "pos_payments_company_id_register_id_created_at_idx" ON "pos_payments"("company_id", "register_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_payments_company_id_idempotency_key_key" ON "pos_payments"("company_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "pos_payments_company_id_external_ref_key" ON "pos_payments"("company_id", "external_ref");

-- CreateIndex
CREATE INDEX "pos_payment_attempts_company_id_payment_id_expires_at_idx" ON "pos_payment_attempts"("company_id", "payment_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_payment_attempts_company_id_payment_id_attempt_no_key" ON "pos_payment_attempts"("company_id", "payment_id", "attempt_no");

-- CreateIndex
CREATE INDEX "pos_provider_events_company_id_provider_created_at_idx" ON "pos_provider_events"("company_id", "provider", "created_at");

-- CreateIndex
CREATE INDEX "pos_provider_events_company_id_matched_payment_id_idx" ON "pos_provider_events"("company_id", "matched_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_provider_events_provider_company_id_event_key_key" ON "pos_provider_events"("provider", "company_id", "event_key");

-- Prisma cannot model this partial index; it deduplicates quarantined events.
CREATE UNIQUE INDEX "pos_provider_events_unmatched_provider_event_key_key" ON "pos_provider_events"("provider", "event_key") WHERE "company_id" IS NULL;

-- CreateIndex
CREATE INDEX "pos_payment_refunds_company_id_sale_id_created_at_idx" ON "pos_payment_refunds"("company_id", "sale_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_payment_refunds_company_id_payment_id_status_idx" ON "pos_payment_refunds"("company_id", "payment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pos_payment_refunds_company_id_idempotency_key_key" ON "pos_payment_refunds"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "pos_stored_value_ledger_company_id_pos_payment_id_idx" ON "pos_stored_value_ledger"("company_id", "pos_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_stored_value_ledger_company_id_idempotency_key_key" ON "pos_stored_value_ledger"("company_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "pos_stored_value_ledger" ADD CONSTRAINT "pos_stored_value_ledger_pos_payment_id_fkey" FOREIGN KEY ("pos_payment_id") REFERENCES "pos_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_attempts" ADD CONSTRAINT "pos_payment_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_attempts" ADD CONSTRAINT "pos_payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "pos_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_provider_events" ADD CONSTRAINT "pos_provider_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_provider_events" ADD CONSTRAINT "pos_provider_events_matched_payment_id_fkey" FOREIGN KEY ("matched_payment_id") REFERENCES "pos_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_refunds" ADD CONSTRAINT "pos_payment_refunds_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_refunds" ADD CONSTRAINT "pos_payment_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "pos_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_refunds" ADD CONSTRAINT "pos_payment_refunds_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_refunds" ADD CONSTRAINT "pos_payment_refunds_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payment_settings" ADD CONSTRAINT "pos_payment_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "system_settings"
  ADD COLUMN "pos_voucher_settings" JSONB NOT NULL
  DEFAULT '{"maxVouchersPerSale":1,"reservationTtlMinutes":15,"invalidAttemptsBeforeLockout":5,"lockoutMinutes":15}';

CREATE TABLE "pos_vouchers" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "batch_id" CHAR(24),
  "code_hash" CHAR(64) NOT NULL,
  "code_suffix" VARCHAR(8) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "discount_type" VARCHAR(16) NOT NULL,
  "value" DECIMAL(19,4) NOT NULL,
  "max_discount_rwf" INTEGER,
  "min_spend_rwf" INTEGER NOT NULL DEFAULT 0,
  "total_usage_limit" INTEGER,
  "per_customer_usage_limit" INTEGER,
  "single_use" BOOLEAN NOT NULL DEFAULT FALSE,
  "can_combine_with_discounts" BOOLEAN NOT NULL DEFAULT FALSE,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "customer_ids" JSONB NOT NULL DEFAULT '[]',
  "customer_group_tags" JSONB NOT NULL DEFAULT '[]',
  "excluded_product_ids" JSONB NOT NULL DEFAULT '[]',
  "excluded_category_ids" JSONB NOT NULL DEFAULT '[]',
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "created_by_id" CHAR(24) NOT NULL,
  "updated_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_vouchers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_vouchers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_vouchers_discount_type_check" CHECK ("discount_type" IN ('percent', 'fixed')),
  CONSTRAINT "pos_vouchers_value_check" CHECK ("value" > 0 AND ("discount_type" <> 'percent' OR "value" <= 100)),
  CONSTRAINT "pos_vouchers_min_spend_check" CHECK ("min_spend_rwf" >= 0),
  CONSTRAINT "pos_vouchers_max_discount_check" CHECK ("max_discount_rwf" IS NULL OR ("discount_type" = 'percent' AND "max_discount_rwf" > 0)),
  CONSTRAINT "pos_vouchers_usage_limits_check" CHECK (("total_usage_limit" IS NULL OR "total_usage_limit" > 0) AND ("per_customer_usage_limit" IS NULL OR "per_customer_usage_limit" > 0)),
  CONSTRAINT "pos_vouchers_date_window_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "pos_vouchers_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'CANCELLED'))
);
CREATE UNIQUE INDEX "pos_vouchers_company_id_code_hash_key" ON "pos_vouchers"("company_id", "code_hash");
CREATE INDEX "pos_vouchers_company_status_dates_idx" ON "pos_vouchers"("company_id", "status", "starts_at", "ends_at");
CREATE INDEX "pos_vouchers_company_batch_idx" ON "pos_vouchers"("company_id", "batch_id");

CREATE TABLE "pos_voucher_redemptions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "voucher_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24),
  "cashier_id" CHAR(24) NOT NULL,
  "till_session_id" CHAR(24),
  "cart_key_hash" CHAR(64) NOT NULL,
  "reservation_token_hash" CHAR(64) NOT NULL,
  "invoice_id" CHAR(24),
  "code_suffix" VARCHAR(8) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  "discount_rwf" INTEGER NOT NULL DEFAULT 0,
  "pricing_snapshot" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "redeemed_at" TIMESTAMPTZ(3),
  "restored_at" TIMESTAMPTZ(3),
  "restored_by_id" CHAR(24),
  "restore_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_voucher_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_voucher_redemptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_voucher_redemptions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "pos_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_voucher_redemptions_status_check" CHECK ("status" IN ('RESERVED', 'REDEEMED', 'RELEASED', 'EXPIRED', 'RESTORED')),
  CONSTRAINT "pos_voucher_redemptions_discount_check" CHECK ("discount_rwf" >= 0)
);
CREATE UNIQUE INDEX "pos_voucher_redemptions_token_hash_key" ON "pos_voucher_redemptions"("reservation_token_hash");
CREATE UNIQUE INDEX "pos_voucher_redemptions_active_cart_key" ON "pos_voucher_redemptions"("company_id", "voucher_id", "cart_key_hash") WHERE "status" = 'RESERVED';
CREATE INDEX "pos_voucher_redemptions_company_voucher_status_expiry_idx" ON "pos_voucher_redemptions"("company_id", "voucher_id", "status", "expires_at");
CREATE INDEX "pos_voucher_redemptions_company_client_voucher_status_idx" ON "pos_voucher_redemptions"("company_id", "client_id", "voucher_id", "status");
CREATE INDEX "pos_voucher_redemptions_company_invoice_idx" ON "pos_voucher_redemptions"("company_id", "invoice_id");

CREATE TABLE "pos_voucher_code_attempts" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "cashier_id" CHAR(24) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "window_started_at" TIMESTAMPTZ(3) NOT NULL,
  "locked_until" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_voucher_code_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_voucher_code_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_voucher_code_attempts_count_check" CHECK ("attempt_count" >= 0)
);
CREATE UNIQUE INDEX "pos_voucher_code_attempts_company_cashier_key" ON "pos_voucher_code_attempts"("company_id", "cashier_id");
CREATE INDEX "pos_voucher_code_attempts_company_lockout_idx" ON "pos_voucher_code_attempts"("company_id", "locked_until");

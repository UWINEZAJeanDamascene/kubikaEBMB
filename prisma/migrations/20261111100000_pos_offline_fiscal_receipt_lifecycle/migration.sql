ALTER TABLE "pos_receipt_number_allocations"
  ADD COLUMN "retired_at" TIMESTAMPTZ(3),
  ADD COLUMN "retirement_reason" VARCHAR(32),
  ADD CONSTRAINT "pos_receipt_alloc_retirement_pair_check"
    CHECK (("retired_at" IS NULL) = ("retirement_reason" IS NULL)),
  ADD CONSTRAINT "pos_receipt_alloc_retirement_reason_check"
    CHECK ("retirement_reason" IS NULL OR "retirement_reason" IN ('SYNC_COMPLETED', 'SHIFT_CLOSED')),
  ADD CONSTRAINT "pos_receipt_alloc_retired_unused_check"
    CHECK ("retired_at" IS NULL OR ("used_at" IS NULL AND "operation_id" IS NULL));

CREATE INDEX "pos_receipt_number_allocations_company_register_retired_idx"
  ON "pos_receipt_number_allocations" ("company_id", "register_id", "retired_at");

UPDATE "system_settings"
   SET "pos_offline_policy" = jsonb_set(
     COALESCE("pos_offline_policy", '{}'::jsonb),
     '{provisionalFiscalReceiptsAllowed}',
     'false'::jsonb,
     true
   );

ALTER TABLE "system_settings"
  ALTER COLUMN "pos_offline_policy" SET DEFAULT '{"companyActions":{"cash_sales":true,"manual_mobile_money":true,"manual_card":true,"cash_paid_in":true,"cash_paid_out":true,"receipt_printing":true,"local_x_report":true,"cached_customer_search":false,"customer_quick_add":false,"gift_card_issue":false,"gift_card_redemption":false,"voucher_redemption":false,"credit_sales":false,"credit_account_payments":false,"store_credit":false,"loyalty_wallet":false,"loyalty_points":false,"bank_transfer":false,"cheque":false,"refunds":false,"voids":false,"manager_approvals":false,"price_overrides":false,"discounts_above_limit":false,"ebm_required_sales":false,"shift_open":false,"shift_close":false},"provisionalFiscalReceiptsAllowed":false,"tillTypeOverrides":{},"registerOverrides":{}}'::jsonb;

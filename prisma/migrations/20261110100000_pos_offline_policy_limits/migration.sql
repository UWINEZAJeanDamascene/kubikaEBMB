ALTER TABLE "system_settings"
  ALTER COLUMN "pos_offline_max_hours" SET DEFAULT 12,
  ADD COLUMN "pos_offline_max_sales" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "pos_offline_max_single_sale" INTEGER NOT NULL DEFAULT 1000000,
  ADD COLUMN "pos_offline_policy" JSONB NOT NULL DEFAULT '{"companyActions":{"cash_sales":true,"manual_mobile_money":true,"manual_card":true,"cash_paid_in":true,"cash_paid_out":true,"receipt_printing":true,"local_x_report":true,"cached_customer_search":false,"customer_quick_add":false,"gift_card_issue":false,"gift_card_redemption":false,"voucher_redemption":false,"credit_sales":false,"credit_account_payments":false,"store_credit":false,"loyalty_wallet":false,"loyalty_points":false,"bank_transfer":false,"cheque":false,"refunds":false,"voids":false,"manager_approvals":false,"price_overrides":false,"discounts_above_limit":false,"ebm_required_sales":false,"shift_open":false,"shift_close":false},"tillTypeOverrides":{},"registerOverrides":{}}'::jsonb;

-- The previous value was the application default, so move untouched defaults to the approved 12-hour safe window.
UPDATE "system_settings" SET "pos_offline_max_hours" = 12 WHERE "pos_offline_max_hours" = 24;
UPDATE "system_settings" SET "pos_offline_max_single_sale" = LEAST("pos_offline_max_single_sale", ROUND("pos_offline_queue_limit"))
 WHERE "pos_offline_max_single_sale" > ROUND("pos_offline_queue_limit");
UPDATE "system_settings" SET "pos_offline_queue_limit" = ROUND("pos_offline_queue_limit") WHERE "pos_offline_queue_limit" <> TRUNC("pos_offline_queue_limit");

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_pos_offline_max_sales_check" CHECK ("pos_offline_max_sales" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "system_settings_pos_offline_max_single_sale_check" CHECK ("pos_offline_max_single_sale" BETWEEN 1 AND 1000000000),
  ADD CONSTRAINT "system_settings_pos_offline_max_hours_check" CHECK ("pos_offline_max_hours" BETWEEN 1 AND 720),
  ADD CONSTRAINT "system_settings_pos_offline_queue_limit_whole_check" CHECK ("pos_offline_queue_limit" BETWEEN 1 AND 1000000000 AND "pos_offline_queue_limit" = TRUNC("pos_offline_queue_limit"));

-- A sale reservation shares the same company/snapshot/operation idempotency key
-- as tender reservations, and records one count plus the authoritative sale value.
ALTER TABLE "pos_offline_action_usage"
  DROP CONSTRAINT "pos_offline_action_usage_action_check";
ALTER TABLE "pos_offline_action_usage"
  ADD CONSTRAINT "pos_offline_action_usage_action_check"
  CHECK ("action" IN (
    'mobile_money', 'card', 'paid_in', 'paid_out',
    'manager_mobile_money', 'manager_card', 'manager_paid_in', 'manager_paid_out',
    'sale'
  ));

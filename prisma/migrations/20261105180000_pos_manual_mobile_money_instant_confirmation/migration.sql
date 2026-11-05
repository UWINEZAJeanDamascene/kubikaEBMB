BEGIN;

ALTER TABLE "pos_payment_settings"
  ALTER COLUMN "manual_mobile_money_mode" SET DEFAULT 'INSTANT';

UPDATE "pos_payment_settings"
SET "manual_mobile_money_mode" = 'INSTANT'
WHERE "manual_mobile_money_mode" = 'VERIFY';

WITH promoted_payments AS (
  UPDATE "pos_payments"
  SET
    "status" = 'SUCCESS',
    "confirmed_at" = COALESCE("confirmed_at", "created_at"),
    "confirmed_by_id" = COALESCE("confirmed_by_id", "cashier_id"),
    "completed_at" = COALESCE("completed_at", "created_at")
  WHERE "status" = 'PENDING_VERIFICATION'
    AND "method" IN ('MTN_MOMO', 'AIRTEL_MONEY')
  RETURNING "id", "company_id", "register_id", "cashier_id", "sale_id", "method", "amount"
)
INSERT INTO "pos_audit_logs" (
  "id",
  "company_id",
  "register_id",
  "user_id",
  "event",
  "metadata",
  "created_at"
)
SELECT
  SUBSTRING(MD5('manual-mobile-money-instant-confirmation:' || "id"), 1, 24),
  "company_id",
  "register_id",
  "cashier_id",
  'PAYMENT_MANUAL_MOBILE_MONEY_AUTO_CONFIRMED',
  JSONB_BUILD_OBJECT(
    'paymentId', "id",
    'saleId', "sale_id",
    'provider', "method"::TEXT,
    'amount', "amount",
    'source', 'migration'
  ),
  CURRENT_TIMESTAMP
FROM promoted_payments
ON CONFLICT ("id") DO NOTHING;

COMMIT;

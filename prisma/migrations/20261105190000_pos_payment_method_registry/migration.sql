ALTER TABLE "pos_payment_settings"
ADD COLUMN "method_registry" JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  CREATE TYPE "PosPaymentEnvironment" AS ENUM ('sandbox', 'production');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "pos_payment_settings"
ADD COLUMN IF NOT EXISTS "provider_environment" "PosPaymentEnvironment" NOT NULL DEFAULT 'sandbox';

ALTER TABLE "system_settings"
ADD COLUMN "pos_receipt_settings" JSONB NOT NULL DEFAULT '{"paperWidth":80,"showCashier":true,"showCustomer":true,"showSku":false,"showBarcode":false,"headerNote":"","footerNote":"Thank you for shopping with us."}'::jsonb;

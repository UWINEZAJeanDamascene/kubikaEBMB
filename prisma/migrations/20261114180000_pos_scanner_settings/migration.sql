ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "pos_scanner_settings" JSONB NOT NULL
  DEFAULT '{"companyDefaults":{"terminator":"Enter","speedThresholdMs":50,"minimumLength":3,"maximumLength":128,"duplicateWindowMs":800,"duplicateBehavior":"add_quantity","prefixToStrip":"","suffixToStrip":"","feedbackSound":false,"enabledSymbologies":["EAN13","EAN8","UPCA","CODE128","CODE39","ITF14","QR"]},"tillTypeOverrides":{},"registerOverrides":{}}'::jsonb;

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "alternate_barcodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

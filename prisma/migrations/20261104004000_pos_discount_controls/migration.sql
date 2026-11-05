ALTER TABLE "system_settings"
  ADD COLUMN "pos_discount_settings" JSONB NOT NULL DEFAULT '{"defaultLimits":{"maxLineDiscountPercent":null,"maxCartDiscountPercent":null,"maxSaleDiscountRwf":null},"rules":[],"discountReasons":[],"systemTillTypes":["retail"],"registerLabels":[]}'::jsonb;

ALTER TABLE "pos_registers"
  ADD COLUMN "system_till_type" VARCHAR(40) NOT NULL DEFAULT 'retail',
  ADD COLUMN "discount_label" VARCHAR(80);

ALTER TABLE "categories"
  ADD COLUMN "is_no_discount" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "products"
  ADD COLUMN "is_no_discount" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "purchase_order_lines"
ADD COLUMN "unit_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb;

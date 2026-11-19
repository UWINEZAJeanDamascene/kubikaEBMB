ALTER TABLE "purchase_return_lines"
ADD COLUMN "unit_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb;

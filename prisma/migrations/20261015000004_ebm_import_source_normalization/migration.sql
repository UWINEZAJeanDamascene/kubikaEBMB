ALTER TABLE "ebm_imported_items"
  ALTER COLUMN "unit_cost" DROP NOT NULL,
  ALTER COLUMN "unit_cost" DROP DEFAULT,
  ALTER COLUMN "tax_rate" DROP NOT NULL,
  ALTER COLUMN "tax_rate" DROP DEFAULT;

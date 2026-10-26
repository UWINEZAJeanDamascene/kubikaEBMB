ALTER TABLE "ebm_imported_items"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN "source_item_key" TEXT,
  ADD COLUMN "item_seq" DECIMAL(10,0),
  ADD COLUMN "rra_status_code" TEXT;

UPDATE "ebm_imported_items"
SET "source_item_key" = 'legacy:' || "id"
WHERE "source_item_key" IS NULL;

ALTER TABLE "ebm_imported_items"
  ALTER COLUMN "source_item_key" SET NOT NULL;

DROP INDEX IF EXISTS "ebm_imported_items_company_id_branch_id_import_task_code_key";

CREATE UNIQUE INDEX "ebm_imported_items_company_branch_mode_source_item_key_key"
  ON "ebm_imported_items"("company_id", "branch_id", "mode", "source_item_key");

DROP INDEX IF EXISTS "ebm_imported_items_company_id_confirmation_status_import_da_idx";

CREATE INDEX "ebm_imported_items_company_mode_confirmation_status_import_date_idx"
  ON "ebm_imported_items"("company_id", "mode", "confirmation_status", "import_date" DESC);

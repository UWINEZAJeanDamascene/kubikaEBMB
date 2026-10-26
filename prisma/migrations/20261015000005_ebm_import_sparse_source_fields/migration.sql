-- The v1.0.5 select-import response does not mark row fields as required.
-- Keep sparse source rows representable without fabricating values.
ALTER TABLE "ebm_imported_items"
  ALTER COLUMN "import_task_code" DROP NOT NULL,
  ALTER COLUMN "item_name" DROP NOT NULL,
  ALTER COLUMN "quantity" DROP NOT NULL;

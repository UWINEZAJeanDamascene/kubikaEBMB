ALTER TABLE "pos_print_printers"
ADD COLUMN "code_page" INTEGER NOT NULL DEFAULT 16;

ALTER TABLE "pos_print_jobs"
ADD COLUMN "source_document_id" VARCHAR(64),
ADD COLUMN "copy_number" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pos_print_jobs"
ADD COLUMN "shift_id" CHAR(24),
ADD COLUMN "local_only" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "pos_print_jobs"
ADD CONSTRAINT "pos_print_jobs_shift_id_fkey"
FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pos_print_jobs_shift_status_idx"
ON "pos_print_jobs"("company_id", "register_id", "shift_id", "status");

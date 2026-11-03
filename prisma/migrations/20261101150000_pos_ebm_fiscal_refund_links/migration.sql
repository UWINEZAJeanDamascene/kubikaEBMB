-- Link each V2 fiscal refund to the signed fiscal sale it reverses.
ALTER TABLE "ebm_submission_queues"
  ADD COLUMN "original_submission_id" CHAR(24);

ALTER TABLE "ebm_submission_queues"
  ADD CONSTRAINT "ebm_submission_queues_original_submission_id_fkey"
  FOREIGN KEY ("original_submission_id") REFERENCES "ebm_submission_queues"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ebm_submission_queues_company_id_original_submission_id_idx"
  ON "ebm_submission_queues"("company_id", "original_submission_id");


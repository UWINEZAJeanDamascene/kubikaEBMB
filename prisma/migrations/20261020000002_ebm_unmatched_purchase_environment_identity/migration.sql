-- Keep the same fiscal source record isolated between mock, sandbox, and production.
ALTER TABLE "ebm_unmatched_purchases"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'legacy-unknown';

DROP INDEX IF EXISTS "ebm_unmatched_purchases_company_id_branch_id_supplier_tin_s_key";

CREATE UNIQUE INDEX "ebm_unmatched_purchases_company_id_mode_branch_id_supplier_tin_seller_invoice_no_key"
  ON "ebm_unmatched_purchases"("company_id", "mode", "branch_id", "supplier_tin", "seller_invoice_no");

DROP INDEX IF EXISTS "ebm_unmatched_purchases_company_id_branch_id_idx";
CREATE INDEX "ebm_unmatched_purchases_company_id_mode_branch_id_idx"
  ON "ebm_unmatched_purchases"("company_id", "mode", "branch_id");

DROP INDEX IF EXISTS "ebm_unmatched_purchases_company_id_status_pulled_at_idx";
CREATE INDEX "ebm_unmatched_purchases_company_id_mode_status_pulled_at_idx"
  ON "ebm_unmatched_purchases"("company_id", "mode", "status", "pulled_at" DESC);

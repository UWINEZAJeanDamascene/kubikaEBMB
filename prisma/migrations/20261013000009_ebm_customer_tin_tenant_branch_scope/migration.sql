-- Customer TIN lookups belong to the requesting tenant and RRA branch.
-- Existing global rows remain nullable legacy data and are not returned by scoped endpoints.
ALTER TABLE "ebm_tins"
  DROP CONSTRAINT IF EXISTS "ebm_tins_tin_key";

DROP INDEX IF EXISTS "ebm_tins_tin_key";

ALTER TABLE "ebm_tins"
  ADD COLUMN "company_id" CHAR(24),
  ADD COLUMN "branch_id" VARCHAR(2),
  ADD COLUMN "sector_name" TEXT,
  ADD COLUMN "verification_mode" TEXT;

ALTER TABLE "ebm_tins"
  ADD CONSTRAINT "ebm_tins_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ebm_tins_company_branch_scope_check"
    CHECK (("company_id" IS NULL AND "branch_id" IS NULL) OR ("company_id" IS NOT NULL AND "branch_id" IS NOT NULL));

CREATE UNIQUE INDEX "ebm_tins_company_id_branch_id_tin_key"
  ON "ebm_tins"("company_id", "branch_id", "tin");

CREATE INDEX "ebm_tins_company_id_branch_id_tin_taxpayer_name_idx"
  ON "ebm_tins"("company_id", "branch_id", "tin", "taxpayer_name");

CREATE INDEX "ebm_tins_company_id_branch_id_active_idx"
  ON "ebm_tins"("company_id", "branch_id", "active");

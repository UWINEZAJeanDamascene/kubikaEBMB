CREATE TABLE "ebm_branch_lookups" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "tin" CHAR(9) NOT NULL,
  "branch_id" VARCHAR(2) NOT NULL,
  "environment" VARCHAR(20) NOT NULL,
  "branch_name" TEXT,
  "status_code" TEXT,
  "province_name" TEXT,
  "district_name" TEXT,
  "sector_name" TEXT,
  "location_description" TEXT,
  "manager_name" TEXT,
  "manager_phone" TEXT,
  "manager_email" TEXT,
  "head_office_yn" CHAR(1),
  "source" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ebm_branch_lookups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ebm_branch_lookups_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ebm_branch_lookups_company_tin_branch_environment_key"
  ON "ebm_branch_lookups"("company_id", "tin", "branch_id", "environment");
CREATE INDEX "ebm_branch_lookups_company_environment_branch_idx"
  ON "ebm_branch_lookups"("company_id", "environment", "branch_id");

ALTER TABLE "warehouses"
  ADD COLUMN IF NOT EXISTS "ebm_insurance_submissions" JSONB NOT NULL DEFAULT '[]';

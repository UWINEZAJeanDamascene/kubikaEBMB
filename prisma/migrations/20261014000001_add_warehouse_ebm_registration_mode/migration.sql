ALTER TABLE "warehouses"
  ADD COLUMN IF NOT EXISTS "ebm_registration_mode" VARCHAR(16);

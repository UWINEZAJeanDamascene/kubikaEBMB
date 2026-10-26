ALTER TABLE "ebm_devices"
ADD COLUMN IF NOT EXISTS "sequence_seed_status" VARCHAR(20);

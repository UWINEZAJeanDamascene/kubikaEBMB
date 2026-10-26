ALTER TABLE "ebm_devices"
ADD COLUMN IF NOT EXISTS "last_request_id" VARCHAR(64);

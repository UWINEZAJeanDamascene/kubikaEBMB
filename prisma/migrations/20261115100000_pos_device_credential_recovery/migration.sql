ALTER TABLE "pos_devices"
  ADD COLUMN "recovery_challenge_hash" VARCHAR(64),
  ADD COLUMN "recovery_challenge_expires_at" TIMESTAMPTZ(3);

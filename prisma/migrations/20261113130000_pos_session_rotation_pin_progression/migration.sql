ALTER TABLE "pos_sessions"
  ADD COLUMN "refresh_token_hash" CHAR(64),
  ADD COLUMN "refresh_expires_at" TIMESTAMPTZ(3);

ALTER TABLE "pos_register_access"
  ADD COLUMN "pin_lockout_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "pos_sessions_refresh_expiry_idx"
  ON "pos_sessions"("refresh_expires_at")
  WHERE "refresh_token_hash" IS NOT NULL;

DROP INDEX IF EXISTS "pos_devices_active_register_key";

ALTER TABLE "pos_sessions"
  ADD COLUMN "device_id" VARCHAR(80);

CREATE INDEX "pos_sessions_company_device_status_idx"
  ON "pos_sessions" ("company_id", "device_id", "status");

UPDATE "pos_sessions" session
SET "device_id" = register."claimed_device_id"
FROM "pos_registers" register
WHERE session."register_id" = register."id"
  AND register."claimed_device_id" IS NOT NULL;

CREATE TABLE "pos_devices" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(80) NOT NULL,
  "public_key" TEXT,
  "device_token_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'needs_enrollment',
  "app_version" VARCHAR(80),
  "queue_depth" INTEGER NOT NULL DEFAULT 0,
  "last_sync_at" TIMESTAMPTZ(3),
  "wipe_requested_at" TIMESTAMPTZ(3),
  "wipe_acknowledged_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_devices_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_devices_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_devices_status_check"
    CHECK ("status" IN ('needs_enrollment', 'active', 'disabled', 'revoked')),
  CONSTRAINT "pos_devices_queue_depth_check"
    CHECK ("queue_depth" >= 0)
);

CREATE UNIQUE INDEX "pos_devices_company_id_device_id_key"
  ON "pos_devices" ("company_id", "device_id");
CREATE UNIQUE INDEX "pos_devices_device_token_hash_key"
  ON "pos_devices" ("device_token_hash");
CREATE UNIQUE INDEX "pos_devices_active_register_key"
  ON "pos_devices" ("company_id", "register_id")
  WHERE "status" = 'active';
CREATE INDEX "pos_devices_company_status_last_sync_idx"
  ON "pos_devices" ("company_id", "status", "last_sync_at");
CREATE INDEX "pos_devices_company_register_idx"
  ON "pos_devices" ("company_id", "register_id");

INSERT INTO "pos_devices" (
  "id", "company_id", "register_id", "device_id", "device_token_hash",
  "status", "last_sync_at", "created_at", "updated_at"
)
SELECT
  substr(md5(random()::text || clock_timestamp()::text), 1, 24),
  register."company_id",
  register."id",
  register."claimed_device_id",
  register."device_token_hash",
  'needs_enrollment',
  register."last_seen_at",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "pos_registers" register
WHERE register."claimed_device_id" IS NOT NULL
  AND register."device_token_hash" IS NOT NULL
ON CONFLICT ("company_id", "device_id") DO NOTHING;

ALTER TABLE "pos_devices"
  ADD COLUMN "storage_usage_bytes" BIGINT,
  ADD COLUMN "storage_quota_bytes" BIGINT,
  ADD COLUMN "storage_persistent" BOOLEAN,
  ADD COLUMN "storage_checked_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "pos_devices_storage_usage_nonnegative_check"
    CHECK ("storage_usage_bytes" IS NULL OR "storage_usage_bytes" >= 0),
  ADD CONSTRAINT "pos_devices_storage_quota_positive_check"
    CHECK ("storage_quota_bytes" IS NULL OR "storage_quota_bytes" > 0);

CREATE INDEX "pos_devices_company_storage_checked_idx"
  ON "pos_devices" ("company_id", "storage_checked_at");

ALTER TABLE "system_settings"
  ADD COLUMN "pos_offline_action_caps" JSONB NOT NULL
  DEFAULT '{"companyDefaults":{"mobile_money":{"maxPerTransaction":0,"maxTotalPerPeriod":0,"maxCountPerPeriod":0},"card":{"maxPerTransaction":0,"maxTotalPerPeriod":0,"maxCountPerPeriod":0},"paid_in":{"maxPerTransaction":0,"maxTotalPerPeriod":0,"maxCountPerPeriod":0},"paid_out":{"maxPerTransaction":0,"maxTotalPerPeriod":0,"maxCountPerPeriod":0}},"tillTypeOverrides":{},"registerOverrides":{}}'::jsonb;

CREATE TABLE "pos_offline_action_usage" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "snapshot_id" CHAR(24) NOT NULL,
  "operation_id" VARCHAR(100) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "action" VARCHAR(24) NOT NULL,
  "amount" DECIMAL(19,2) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_offline_action_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_offline_action_usage_action_check"
    CHECK ("action" IN ('mobile_money', 'card', 'paid_in', 'paid_out')),
  CONSTRAINT "pos_offline_action_usage_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "pos_offline_action_usage_snapshot_fk"
    FOREIGN KEY ("snapshot_id") REFERENCES "pos_offline_snapshots"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pos_offline_action_usage_operation_action_key"
  ON "pos_offline_action_usage" ("company_id", "snapshot_id", "operation_id", "action");
CREATE INDEX "pos_offline_action_usage_period_idx"
  ON "pos_offline_action_usage" ("company_id", "snapshot_id", "action");

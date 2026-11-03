CREATE TYPE "PosSessionStatus" AS ENUM ('active', 'locked', 'ended');

ALTER TABLE "system_settings"
  ADD COLUMN "pos_idle_lock_minutes" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "pos_single_register_session" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pos_role_permissions" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "pos_registers"
  ADD COLUMN "branch_id" CHAR(24),
  ADD COLUMN "device_token_hash" VARCHAR(64),
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "pos_registers_device_token_hash_key"
  ON "pos_registers"("device_token_hash");

CREATE TABLE "pos_user_credentials" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "pin_hash" VARCHAR(255) NOT NULL,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMPTZ(3),
  "pin_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "must_change" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "pos_user_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_user_credentials_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_user_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_user_credentials_failed_count_check" CHECK ("failed_count" >= 0)
);

CREATE UNIQUE INDEX "pos_user_credentials_company_id_user_id_key"
  ON "pos_user_credentials"("company_id", "user_id");
CREATE INDEX "pos_user_credentials_company_id_locked_until_idx"
  ON "pos_user_credentials"("company_id", "locked_until");

CREATE TABLE "pos_register_access" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  CONSTRAINT "pos_register_access_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_register_access_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_register_access_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_register_access_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_register_access_register_id_user_id_key"
  ON "pos_register_access"("register_id", "user_id");
CREATE INDEX "pos_register_access_company_id_user_id_idx"
  ON "pos_register_access"("company_id", "user_id");

CREATE TABLE "pos_sessions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "status" "PosSessionStatus" NOT NULL DEFAULT 'active',
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(3),
  "ended_at" TIMESTAMPTZ(3),
  "end_reason" VARCHAR(24),
  CONSTRAINT "pos_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_sessions_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_sessions_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pos_sessions_company_id_register_id_status_idx"
  ON "pos_sessions"("company_id", "register_id", "status");
CREATE INDEX "pos_sessions_company_id_user_id_status_idx"
  ON "pos_sessions"("company_id", "user_id", "status");
CREATE INDEX "pos_sessions_company_id_last_activity_at_idx"
  ON "pos_sessions"("company_id", "last_activity_at");

CREATE TABLE "pos_approvals" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "requested_by" CHAR(24) NOT NULL,
  "approved_by" CHAR(24) NOT NULL,
  "action" VARCHAR(40) NOT NULL,
  "context" JSONB,
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_approvals_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approvals_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approvals_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approvals_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_approvals_token_hash_key"
  ON "pos_approvals"("token_hash");
CREATE INDEX "pos_approvals_company_id_register_id_action_expires_at_idx"
  ON "pos_approvals"("company_id", "register_id", "action", "expires_at");
CREATE INDEX "pos_approvals_company_id_requested_by_created_at_idx"
  ON "pos_approvals"("company_id", "requested_by", "created_at");

CREATE TABLE "pos_audit_logs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24),
  "user_id" CHAR(24),
  "event" VARCHAR(64) NOT NULL,
  "metadata" JSONB,
  "ip" VARCHAR(45),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_audit_logs_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_audit_logs_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_audit_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "pos_audit_logs_company_id_created_at_idx"
  ON "pos_audit_logs"("company_id", "created_at");
CREATE INDEX "pos_audit_logs_company_id_register_id_created_at_idx"
  ON "pos_audit_logs"("company_id", "register_id", "created_at");

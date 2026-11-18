BEGIN;

CREATE TABLE "company_module_entitlements" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "module_code" VARCHAR(80) NOT NULL,
  "status" VARCHAR(8) NOT NULL,
  "changed_by" CHAR(24),
  "reason" TEXT NOT NULL,
  "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "company_module_entitlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_module_entitlements_status_check" CHECK ("status" IN ('on', 'off')),
  CONSTRAINT "company_module_entitlements_module_code_check"
    CHECK ("module_code" ~ '^[a-z][a-z0-9._-]{0,79}$'),
  CONSTRAINT "company_module_entitlements_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "company_module_entitlements_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "company_module_entitlements_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "company_module_entitlements_company_module_key"
  ON "company_module_entitlements"("company_id", "module_code");
CREATE INDEX "company_module_entitlements_company_status_idx"
  ON "company_module_entitlements"("company_id", "status");
CREATE INDEX "company_module_entitlements_module_status_idx"
  ON "company_module_entitlements"("module_code", "status");

CREATE TABLE "platform_module_audit_logs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "module_code" VARCHAR(80) NOT NULL,
  "actor_user_id" CHAR(24) NOT NULL,
  "event_type" VARCHAR(32) NOT NULL,
  "old_status" VARCHAR(8),
  "new_status" VARCHAR(8),
  "reason" TEXT NOT NULL,
  "result" VARCHAR(32) NOT NULL,
  "correlation_id" UUID NOT NULL,
  "effective_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_module_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_module_audit_module_code_check"
    CHECK ("module_code" ~ '^[a-z][a-z0-9._-]{0,79}$'),
  CONSTRAINT "platform_module_audit_old_status_check"
    CHECK ("old_status" IS NULL OR "old_status" IN ('on', 'off')),
  CONSTRAINT "platform_module_audit_new_status_check"
    CHECK ("new_status" IS NULL OR "new_status" IN ('on', 'off')),
  CONSTRAINT "platform_module_audit_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "platform_module_audit_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "platform_module_audit_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "platform_module_audit_company_module_created_idx"
  ON "platform_module_audit_logs"("company_id", "module_code", "created_at");
CREATE INDEX "platform_module_audit_actor_created_idx"
  ON "platform_module_audit_logs"("actor_user_id", "created_at");
CREATE INDEX "platform_module_audit_correlation_idx"
  ON "platform_module_audit_logs"("correlation_id");

INSERT INTO "company_module_entitlements" (
  "id",
  "company_id",
  "module_code",
  "status",
  "changed_by",
  "reason",
  "effective_at",
  "created_at",
  "updated_at"
)
SELECT
  substr(md5('company-module-entitlement:fiscal.ebm:' || c."id"), 1, 24),
  c."id",
  'fiscal.ebm',
  CASE WHEN c."ebm_enabled" THEN 'on' ELSE 'off' END,
  NULL,
  'Preserved Company.ebmEnabled during entitlement cutover',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "companies" c
ON CONFLICT ("company_id", "module_code") DO NOTHING;

CREATE OR REPLACE FUNCTION "companies_default_ebm_off_before_insert"()
RETURNS TRIGGER AS $$
BEGIN
  NEW."ebm_enabled" := FALSE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "companies_default_ebm_off_before_insert"
  BEFORE INSERT ON "companies"
  FOR EACH ROW EXECUTE FUNCTION "companies_default_ebm_off_before_insert"();

CREATE OR REPLACE FUNCTION "companies_create_ebm_entitlement_after_insert"()
RETURNS TRIGGER AS $$
DECLARE
  effective_at_value TIMESTAMPTZ(3);
BEGIN
  effective_at_value := COALESCE(NEW."created_at", CURRENT_TIMESTAMP);
  INSERT INTO "company_module_entitlements" (
    "id",
    "company_id",
    "module_code",
    "status",
    "changed_by",
    "reason",
    "effective_at",
    "created_at",
    "updated_at"
  )
  VALUES (
    substr(md5('company-module-entitlement:fiscal.ebm:' || NEW."id"), 1, 24),
    NEW."id",
    'fiscal.ebm',
    'off',
    NULL,
    'Default off for new company',
    effective_at_value,
    effective_at_value,
    COALESCE(NEW."updated_at", effective_at_value)
  )
  ON CONFLICT ("company_id", "module_code") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "companies_create_ebm_entitlement_after_insert"
  AFTER INSERT ON "companies"
  FOR EACH ROW EXECUTE FUNCTION "companies_create_ebm_entitlement_after_insert"();

CREATE OR REPLACE FUNCTION "platform_module_audit_reject_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Platform module audit rows are append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_module_audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "platform_module_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "platform_module_audit_reject_mutation"();
CREATE TRIGGER "platform_module_audit_logs_no_truncate"
  BEFORE TRUNCATE ON "platform_module_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform_module_audit_reject_mutation"();

COMMIT;

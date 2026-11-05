CREATE TABLE "pos_approval_policies" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "action" VARCHAR(40) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "request_ttl_seconds" INTEGER NOT NULL DEFAULT 600,
  "pin_approval_ttl_seconds" INTEGER NOT NULL DEFAULT 60,
  "manager_approval_ttl_seconds" INTEGER NOT NULL DEFAULT 300,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_approval_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_approval_policies_company_id_fkey" FOREIGN KEY ("company_id")
    REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approval_policies_company_id_action_key" UNIQUE ("company_id", "action"),
  CONSTRAINT "pos_approval_policies_request_ttl_check" CHECK ("request_ttl_seconds" BETWEEN 60 AND 3600),
  CONSTRAINT "pos_approval_policies_pin_ttl_check" CHECK ("pin_approval_ttl_seconds" BETWEEN 30 AND 300),
  CONSTRAINT "pos_approval_policies_manager_ttl_check" CHECK ("manager_approval_ttl_seconds" BETWEEN 30 AND 600)
);

CREATE INDEX "pos_approval_policies_company_enabled_idx"
  ON "pos_approval_policies"("company_id", "enabled");

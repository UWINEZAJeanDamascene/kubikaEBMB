CREATE TABLE "pos_approval_requests" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "cashier_id" CHAR(24) NOT NULL,
  "till_session_id" CHAR(24),
  "action" VARCHAR(20) NOT NULL,
  "subject_id" CHAR(24),
  "payload" JSONB NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "decision_by_id" CHAR(24),
  "decision_reason" VARCHAR(500),
  "decision_at" TIMESTAMPTZ(3),
  "manager_approval_id" CHAR(24),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_approval_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_approval_requests_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  CONSTRAINT "pos_approval_requests_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approval_requests_register_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approval_requests_cashier_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_approval_requests_decision_by_fkey" FOREIGN KEY ("decision_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_approval_requests_manager_approval_fkey" FOREIGN KEY ("manager_approval_id") REFERENCES "pos_manager_approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "pos_approval_requests_company_status_created_idx" ON "pos_approval_requests"("company_id", "status", "created_at");
CREATE INDEX "pos_approval_requests_company_register_created_idx" ON "pos_approval_requests"("company_id", "register_id", "created_at");
CREATE UNIQUE INDEX "pos_approval_requests_manager_approval_id_key" ON "pos_approval_requests"("manager_approval_id");

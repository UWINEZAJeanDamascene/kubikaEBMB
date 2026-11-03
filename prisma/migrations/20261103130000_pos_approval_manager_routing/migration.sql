ALTER TABLE "pos_approval_requests"
  ADD COLUMN "assigned_manager_id" CHAR(24);

ALTER TABLE "pos_approval_requests"
  ADD CONSTRAINT "pos_approval_requests_assigned_manager_fkey"
  FOREIGN KEY ("assigned_manager_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pos_appr_req_company_mgr_status_created_idx"
  ON "pos_approval_requests"("company_id", "assigned_manager_id", "status", "created_at");

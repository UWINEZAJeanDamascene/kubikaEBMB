CREATE TYPE "PosEbmShiftClosePolicy" AS ENUM ('WARN', 'REQUIRE_APPROVAL', 'BLOCK');

CREATE TABLE "pos_ebm_settings" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "signature_wait_timeout_seconds" INTEGER NOT NULL DEFAULT 10,
  "queue_when_unavailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "offline_submission_deadline_minutes" INTEGER,
  "copy_receipt_submit_to_vsdc" BOOLEAN NOT NULL DEFAULT FALSE,
  "tender_mappings" JSONB NOT NULL DEFAULT '{"CASH":"01","CREDIT":"02","CARD":"05","MTN_MOMO":"06","AIRTEL_MONEY":"06"}'::jsonb,
  "split_tender_policy" TEXT NOT NULL DEFAULT 'LARGEST_TENDER_PROVISIONAL',
  "rounding_policy" TEXT NOT NULL DEFAULT 'NONE',
  "shift_close_fiscal_policy" "PosEbmShiftClosePolicy" NOT NULL DEFAULT 'REQUIRE_APPROVAL',
  "policy_statuses" JSONB NOT NULL DEFAULT '{"saleBeforeSignature":"PROVISIONAL","offlineQueue":"PROVISIONAL","copySubmission":"PROVISIONAL","refundBeforeSignature":"PROVISIONAL","unknownOutcome":"PROVISIONAL","tenderMappings":"PROVISIONAL","splitTender":"PROVISIONAL","rounding":"PROVISIONAL","shiftClose":"PROVISIONAL"}'::jsonb,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_ebm_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_ebm_settings_company_id_key" UNIQUE ("company_id"),
  CONSTRAINT "pos_ebm_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_ebm_settings_signature_timeout_check" CHECK ("signature_wait_timeout_seconds" BETWEEN 1 AND 120),
  CONSTRAINT "pos_ebm_settings_offline_deadline_check" CHECK ("offline_submission_deadline_minutes" IS NULL OR "offline_submission_deadline_minutes" > 0),
  CONSTRAINT "pos_ebm_settings_offline_deadline_required" CHECK (NOT "queue_when_unavailable" OR "offline_submission_deadline_minutes" IS NOT NULL)
);

ALTER TABLE "ebm_submission_queues"
  ADD COLUMN "register_id" CHAR(24),
  ADD COLUMN "shift_id" CHAR(24),
  ADD COLUMN "cashier_id" CHAR(24),
  ADD COLUMN "sales_ty_cd" VARCHAR(1),
  ADD COLUMN "rcpt_ty_cd" VARCHAR(1),
  ADD COLUMN "request_payload_hash" CHAR(64),
  ADD COLUMN "request_sent_at" TIMESTAMPTZ(3),
  ADD COLUMN "signed_at" TIMESTAMPTZ(3),
  ADD COLUMN "fiscal_data_source" VARCHAR(20),
  ADD COLUMN "manager_evidence_note" TEXT,
  ADD COLUMN "second_approver_id" CHAR(24),
  ADD COLUMN "manager_approval_id" CHAR(24),
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "resolution" VARCHAR(32),
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "resolved_by_id" CHAR(24),
  ADD COLUMN "v2_resolved_at" TIMESTAMPTZ(3),
  ADD COLUMN "resend_authorized_at" TIMESTAMPTZ(3),
  ADD COLUMN "resend_authorized_by" CHAR(24),
  ADD COLUMN "resend_consumed_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "ebm_submission_queues_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ebm_submission_queues_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ebm_submission_queues_manager_approval_id_fkey" FOREIGN KEY ("manager_approval_id") REFERENCES "pos_manager_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ebm_sales_ty_cd_check" CHECK ("sales_ty_cd" IS NULL OR "sales_ty_cd" IN ('N','C','T','P')),
  ADD CONSTRAINT "ebm_rcpt_ty_cd_check" CHECK ("rcpt_ty_cd" IS NULL OR "rcpt_ty_cd" IN ('S','R')),
  ADD CONSTRAINT "ebm_code_pair_check" CHECK (("sales_ty_cd" IS NULL) = ("rcpt_ty_cd" IS NULL)),
  ADD CONSTRAINT "ebm_register_requires_receipt_codes_check" CHECK ("register_id" IS NULL OR ("sales_ty_cd" IS NOT NULL AND "rcpt_ty_cd" IS NOT NULL)),
  ADD CONSTRAINT "ebm_fiscal_data_source_check" CHECK ("fiscal_data_source" IS NULL OR "fiscal_data_source" IN ('VSDC_RESPONSE','MANAGER_ENTRY')),
  ADD CONSTRAINT "ebm_signed_source_required_check" CHECK ("register_id" IS NULL OR "signed_at" IS NULL OR "fiscal_data_source" IS NOT NULL),
  ADD CONSTRAINT "ebm_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('CONFIRMED_SIGNED','CONFIRMED_NOT_RECEIVED')),
  ADD CONSTRAINT "ebm_resolution_requires_audit_fields_check" CHECK ("resolution" IS NULL OR ("resolved_by_id" IS NOT NULL AND "v2_resolved_at" IS NOT NULL AND NULLIF(BTRIM("resolution_reason"), '') IS NOT NULL)),
  ADD CONSTRAINT "ebm_resend_consumed_requires_authorization_check" CHECK ("resend_consumed_at" IS NULL OR "resend_authorized_at" IS NOT NULL),
  ADD CONSTRAINT "ebm_resend_authorization_pair_check" CHECK (("resend_authorized_at" IS NULL) = ("resend_authorized_by" IS NULL)),
  ADD CONSTRAINT "ebm_manual_signed_evidence_check" CHECK ("fiscal_data_source" IS DISTINCT FROM 'MANAGER_ENTRY' OR ("resolution" = 'CONFIRMED_SIGNED' AND NULLIF(BTRIM("manager_evidence_note"), '') IS NOT NULL AND "second_approver_id" IS NOT NULL AND "resolved_by_id" IS NOT NULL AND "second_approver_id" <> "resolved_by_id" AND "manager_approval_id" IS NOT NULL));

-- Preserve the legacy resolved_at lifecycle/latency semantics. V2 uses v2_resolved_at.
ALTER TABLE "pos_manager_approvals"
  DROP CONSTRAINT "pos_manager_approvals_action_check",
  ADD CONSTRAINT "pos_manager_approvals_action_check"
    CHECK ("action" IN ('discount', 'void', 'refund', 'FISCAL_RECEIPT_ENTRY'));

-- Plain unique index: PostgreSQL treats NULL values as distinct. Existing rows have NULL codes.
CREATE UNIQUE INDEX "ebm_submission_queues_receipt_type_key"
  ON "ebm_submission_queues" ("company_id", "document_type", "document_id", "sales_ty_cd", "rcpt_ty_cd");

CREATE INDEX "ebm_submission_queues_company_shift_status_idx"
  ON "ebm_submission_queues" ("company_id", "shift_id", "ebm_status");
ALTER INDEX "ebm_submission_queues_company_shift_status_idx"
  RENAME TO "ebm_submission_queues_company_id_shift_id_ebm_status_idx";
CREATE INDEX "ebm_submission_queues_company_id_register_id_idx"
  ON "ebm_submission_queues" ("company_id", "register_id");
CREATE INDEX "ebm_submission_queues_ebm_status_lease_expires_at_idx"
  ON "ebm_submission_queues" ("ebm_status", "lease_expires_at");

ALTER TABLE "invoice_receipt_metadata"
  ADD COLUMN "submission_id" CHAR(24),
  ADD CONSTRAINT "invoice_receipt_metadata_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "ebm_submission_queues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "invoice_receipt_metadata_company_id_submission_id_key"
  ON "invoice_receipt_metadata" ("company_id", "submission_id");

CREATE TABLE "pos_ebm_receipt_reprints" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "submission_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24),
  "actor_user_id" CHAR(24) NOT NULL,
  "copy_number" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_ebm_receipt_reprints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_ebm_receipt_reprints_company_id_idempotency_key_key" UNIQUE ("company_id", "idempotency_key"),
  CONSTRAINT "pos_ebm_receipt_reprints_company_id_invoice_id_copy_number_key" UNIQUE ("company_id", "invoice_id", "copy_number"),
  CONSTRAINT "pos_ebm_receipt_reprints_copy_number_check" CHECK ("copy_number" > 0),
  CONSTRAINT "pos_ebm_receipt_reprints_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_ebm_receipt_reprints_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_ebm_receipt_reprints_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "ebm_submission_queues"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_ebm_receipt_reprints_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "pos_ebm_receipt_reprints_company_id_invoice_id_created_at_idx"
  ON "pos_ebm_receipt_reprints" ("company_id", "invoice_id", "created_at");

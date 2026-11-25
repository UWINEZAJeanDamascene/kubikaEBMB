ALTER TYPE "PosPaymentMethod" ADD VALUE IF NOT EXISTS 'INSURANCE';

CREATE TABLE "pharmacy_insurance_providers" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "contact_name" VARCHAR(160),
  "phone" VARCHAR(40),
  "email" VARCHAR(160),
  "submission_instructions" VARCHAR(1000),
  "requires_preauthorization" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pharmacy_insurance_providers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_providers_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_insurance_providers_company_code_key"
  ON "pharmacy_insurance_providers"("company_id", "code");
CREATE INDEX "pharmacy_insurance_providers_company_active_name_idx"
  ON "pharmacy_insurance_providers"("company_id", "is_active", "name");

CREATE TABLE "pharmacy_insurance_members" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "provider_id" CHAR(24) NOT NULL,
  "patient_id" CHAR(24) NOT NULL,
  "member_number" VARCHAR(100) NOT NULL,
  "policy_number" VARCHAR(100),
  "group_number" VARCHAR(100),
  "relationship_to_holder" VARCHAR(40),
  "effective_from" DATE,
  "effective_to" DATE,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending_verification',
  "verified_at" TIMESTAMPTZ(3),
  "verified_by_id" CHAR(24),
  "verification_reference" VARCHAR(160),
  "verification_note" VARCHAR(1000),
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pharmacy_insurance_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_members_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_members_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "pharmacy_insurance_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_members_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "pharmacy_patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_members_status_check"
    CHECK ("status" IN ('pending_verification', 'active', 'expired', 'rejected', 'suspended'))
);
CREATE UNIQUE INDEX "pharmacy_insurance_members_company_provider_patient_number_key"
  ON "pharmacy_insurance_members"("company_id", "provider_id", "patient_id", "member_number");
CREATE INDEX "pharmacy_insurance_members_company_patient_status_idx"
  ON "pharmacy_insurance_members"("company_id", "patient_id", "status");
CREATE INDEX "pharmacy_insurance_members_company_provider_number_idx"
  ON "pharmacy_insurance_members"("company_id", "provider_id", "member_number");

CREATE TABLE "pharmacy_insurance_eligibilities" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "provider_id" CHAR(24) NOT NULL,
  "member_id" CHAR(24) NOT NULL,
  "patient_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "covered_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "copay_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "response_reference" VARCHAR(160),
  "response_note" VARCHAR(1000),
  "checked_by_id" CHAR(24) NOT NULL,
  "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_until" TIMESTAMPTZ(3),
  CONSTRAINT "pharmacy_insurance_eligibilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_eligibilities_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_eligibilities_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "pharmacy_insurance_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_eligibilities_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "pharmacy_insurance_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_eligibilities_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "pharmacy_patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_eligibilities_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_eligibilities_amounts_check"
    CHECK ("covered_amount" >= 0 AND "copay_amount" >= 0),
  CONSTRAINT "pharmacy_insurance_eligibilities_status_check"
    CHECK ("status" IN ('pending', 'eligible', 'not_eligible'))
);
CREATE UNIQUE INDEX "pharmacy_insurance_eligibilities_company_invoice_key"
  ON "pharmacy_insurance_eligibilities"("company_id", "invoice_id");
CREATE INDEX "pharmacy_insurance_eligibilities_company_patient_checked_idx"
  ON "pharmacy_insurance_eligibilities"("company_id", "patient_id", "checked_at" DESC);
CREATE INDEX "pharmacy_insurance_eligibilities_company_provider_status_idx"
  ON "pharmacy_insurance_eligibilities"("company_id", "provider_id", "status", "checked_at" DESC);

CREATE TABLE "pharmacy_insurance_authorizations" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "provider_id" CHAR(24) NOT NULL,
  "member_id" CHAR(24) NOT NULL,
  "patient_id" CHAR(24) NOT NULL,
  "eligibility_id" CHAR(24) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'requested',
  "requested_amount" DECIMAL(19,2) NOT NULL,
  "authorized_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "request_reference" VARCHAR(160),
  "authorization_reference" VARCHAR(160),
  "request_note" VARCHAR(1000),
  "response_note" VARCHAR(1000),
  "requested_by_id" CHAR(24) NOT NULL,
  "responded_by_id" CHAR(24),
  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  CONSTRAINT "pharmacy_insurance_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_authorizations_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_authorizations_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "pharmacy_insurance_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_authorizations_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "pharmacy_insurance_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_authorizations_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "pharmacy_patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_authorizations_eligibility_id_fkey"
    FOREIGN KEY ("eligibility_id") REFERENCES "pharmacy_insurance_eligibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_authorizations_amounts_check"
    CHECK ("requested_amount" > 0 AND "authorized_amount" >= 0 AND "authorized_amount" <= "requested_amount"),
  CONSTRAINT "pharmacy_insurance_authorizations_status_check"
    CHECK ("status" IN ('requested', 'approved', 'partially_approved', 'rejected', 'expired', 'cancelled'))
);
CREATE INDEX "pharmacy_insurance_authorizations_company_patient_requested_idx"
  ON "pharmacy_insurance_authorizations"("company_id", "patient_id", "requested_at" DESC);
CREATE INDEX "pharmacy_insurance_authorizations_company_provider_status_idx"
  ON "pharmacy_insurance_authorizations"("company_id", "provider_id", "status", "requested_at" DESC);

CREATE TABLE "pharmacy_insurance_claims" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "provider_id" CHAR(24) NOT NULL,
  "member_id" CHAR(24) NOT NULL,
  "patient_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "eligibility_id" CHAR(24) NOT NULL,
  "authorization_id" CHAR(24),
  "claim_number" VARCHAR(80) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
  "gross_amount" DECIMAL(19,2) NOT NULL,
  "copay_amount" DECIMAL(19,2) NOT NULL,
  "claim_amount" DECIMAL(19,2) NOT NULL,
  "settled_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "adjusted_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "approved_amount" DECIMAL(19,2),
  "rejection_reason" VARCHAR(1000),
  "submitted_at" TIMESTAMPTZ(3),
  "resolved_at" TIMESTAMPTZ(3),
  "created_by_id" CHAR(24) NOT NULL,
  "updated_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pharmacy_insurance_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_claims_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "pharmacy_insurance_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "pharmacy_insurance_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "pharmacy_patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_eligibility_id_fkey"
    FOREIGN KEY ("eligibility_id") REFERENCES "pharmacy_insurance_eligibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_authorization_id_fkey"
    FOREIGN KEY ("authorization_id") REFERENCES "pharmacy_insurance_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claims_amounts_check"
    CHECK ("gross_amount" > 0 AND "copay_amount" >= 0 AND "claim_amount" > 0
      AND "copay_amount" + "claim_amount" = "gross_amount"
      AND "settled_amount" >= 0 AND "settled_amount" <= "claim_amount"
      AND "adjusted_amount" >= 0 AND "adjusted_amount" <= "claim_amount"
      AND "settled_amount" + "adjusted_amount" <= "claim_amount"
      AND ("approved_amount" IS NULL OR ("approved_amount" >= 0 AND "approved_amount" <= "claim_amount"))),
  CONSTRAINT "pharmacy_insurance_claims_status_check"
    CHECK ("status" IN ('draft', 'submitted', 'rejected', 'accepted', 'partially_accepted', 'partially_settled', 'settled', 'resubmission_required', 'adjusted', 'cancelled'))
);
CREATE UNIQUE INDEX "pharmacy_insurance_claims_company_invoice_key"
  ON "pharmacy_insurance_claims"("company_id", "invoice_id");
CREATE UNIQUE INDEX "pharmacy_insurance_claims_company_provider_number_key"
  ON "pharmacy_insurance_claims"("company_id", "provider_id", "claim_number");
CREATE INDEX "pharmacy_insurance_claims_company_status_created_idx"
  ON "pharmacy_insurance_claims"("company_id", "status", "created_at" DESC);
CREATE INDEX "pharmacy_insurance_claims_company_provider_status_idx"
  ON "pharmacy_insurance_claims"("company_id", "provider_id", "status", "created_at" DESC);

CREATE TABLE "pharmacy_insurance_claim_lines" (
  "id" CHAR(24) NOT NULL,
  "claim_id" CHAR(24) NOT NULL,
  "invoice_line_id" CHAR(24) NOT NULL,
  "quantity" DECIMAL(19,4) NOT NULL,
  "gross_amount" DECIMAL(19,2) NOT NULL,
  "copay_amount" DECIMAL(19,2) NOT NULL,
  "claim_amount" DECIMAL(19,2) NOT NULL,
  "rejection_reason" VARCHAR(1000),
  CONSTRAINT "pharmacy_insurance_claim_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_claim_lines_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "pharmacy_insurance_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_lines_invoice_line_id_fkey"
    FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_lines_amounts_check"
    CHECK ("quantity" > 0 AND "gross_amount" >= 0 AND "copay_amount" >= 0
      AND "claim_amount" >= 0 AND "copay_amount" + "claim_amount" = "gross_amount")
);
CREATE UNIQUE INDEX "pharmacy_insurance_claim_lines_claim_invoice_line_key"
  ON "pharmacy_insurance_claim_lines"("claim_id", "invoice_line_id");
CREATE INDEX "pharmacy_insurance_claim_lines_invoice_line_idx"
  ON "pharmacy_insurance_claim_lines"("invoice_line_id");

CREATE TABLE "pharmacy_insurance_claim_attempts" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "claim_id" CHAR(24) NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "reference" VARCHAR(160),
  "response_note" VARCHAR(1000),
  "response_amount" DECIMAL(19,2),
  "submitted_by_id" CHAR(24) NOT NULL,
  "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_by_id" CHAR(24),
  "responded_at" TIMESTAMPTZ(3),
  CONSTRAINT "pharmacy_insurance_claim_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_claim_attempts_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_attempts_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "pharmacy_insurance_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_attempts_status_check"
    CHECK ("status" IN ('submitted', 'accepted', 'rejected', 'partially_accepted'))
);
CREATE UNIQUE INDEX "pharmacy_insurance_claim_attempts_claim_attempt_key"
  ON "pharmacy_insurance_claim_attempts"("claim_id", "attempt_number");
CREATE INDEX "pharmacy_insurance_claim_attempts_company_claim_submitted_idx"
  ON "pharmacy_insurance_claim_attempts"("company_id", "claim_id", "submitted_at" DESC);

CREATE TABLE "pharmacy_insurance_claim_adjustments" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "claim_id" CHAR(24) NOT NULL,
  "amount" DECIMAL(19,2) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "reference" VARCHAR(160),
  "idempotency_key" VARCHAR(100) NOT NULL,
  "journal_entry_id" CHAR(24),
  "posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "recorded_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_insurance_claim_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_claim_adjustments_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_adjustments_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "pharmacy_insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_claim_adjustments_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "pharmacy_insurance_claim_adjustments_company_idempotency_key"
  ON "pharmacy_insurance_claim_adjustments"("company_id", "idempotency_key");
CREATE INDEX "pharmacy_insurance_claim_adjustments_company_claim_date_idx"
  ON "pharmacy_insurance_claim_adjustments"("company_id", "claim_id", "created_at" DESC);

CREATE TABLE "pharmacy_insurance_settlements" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "claim_id" CHAR(24) NOT NULL,
  "amount" DECIMAL(19,2) NOT NULL,
  "settlement_date" TIMESTAMPTZ(3) NOT NULL,
  "reference" VARCHAR(160),
  "note" VARCHAR(1000),
  "idempotency_key" VARCHAR(100) NOT NULL,
  "journal_entry_id" CHAR(24),
  "posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "recorded_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_insurance_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_insurance_settlements_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_settlements_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "pharmacy_insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_insurance_settlements_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "pharmacy_insurance_settlements_company_idempotency_key"
  ON "pharmacy_insurance_settlements"("company_id", "idempotency_key");
CREATE INDEX "pharmacy_insurance_settlements_company_claim_date_idx"
  ON "pharmacy_insurance_settlements"("company_id", "claim_id", "settlement_date" DESC);

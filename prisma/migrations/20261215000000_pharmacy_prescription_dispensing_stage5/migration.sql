CREATE TABLE "pharmacy_patients" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "patient_code" VARCHAR(40) NOT NULL,
  "full_name" VARCHAR(160) NOT NULL,
  "phone" VARCHAR(40),
  "date_of_birth" DATE,
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_patients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_patients_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_patients_birth_date_check" CHECK ("date_of_birth" IS NULL OR "date_of_birth" <= CURRENT_DATE)
);

CREATE TABLE "pharmacy_prescriptions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "patient_id" CHAR(24) NOT NULL,
  "prescription_number" VARCHAR(80) NOT NULL,
  "prescriber_name" VARCHAR(160) NOT NULL,
  "prescriber_license" VARCHAR(80) NOT NULL,
  "issue_date" DATE NOT NULL,
  "expiry_date" DATE NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending_review',
  "refills_authorized" INTEGER NOT NULL DEFAULT 0,
  "refills_used" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_prescriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_prescriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_prescriptions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "pharmacy_patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_prescriptions_status_check" CHECK ("status" IN ('pending_review', 'approved', 'on_hold', 'partially_dispensed', 'dispensed', 'cancelled', 'rejected')),
  CONSTRAINT "pharmacy_prescriptions_dates_check" CHECK ("expiry_date" >= "issue_date"),
  CONSTRAINT "pharmacy_prescriptions_refills_check" CHECK ("refills_authorized" >= 0 AND "refills_used" >= 0 AND "refills_used" <= "refills_authorized")
);

CREATE TABLE "pharmacy_prescription_lines" (
  "id" CHAR(24) NOT NULL,
  "prescription_id" CHAR(24) NOT NULL,
  "product_id" CHAR(24) NOT NULL,
  "product_name" VARCHAR(180) NOT NULL,
  "generic_name" VARCHAR(180) NOT NULL,
  "strength" VARCHAR(80) NOT NULL,
  "dosage_form" VARCHAR(48) NOT NULL,
  "prescription_status" VARCHAR(24) NOT NULL,
  "controlled" BOOLEAN NOT NULL DEFAULT FALSE,
  "prescribed_quantity" DECIMAL(19,4) NOT NULL,
  "dosage_instructions" VARCHAR(500) NOT NULL,
  "substitution_allowed" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "pharmacy_prescription_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_prescription_lines_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "pharmacy_prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_prescription_lines_quantity_check" CHECK ("prescribed_quantity" > 0),
  CONSTRAINT "pharmacy_prescription_lines_status_check" CHECK ("prescription_status" IN ('PRESCRIPTION', 'RESTRICTED'))
);

CREATE TABLE "pharmacy_prescription_fills" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "prescription_id" CHAR(24) NOT NULL,
  "fill_number" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending_review',
  "reviewed_by_id" CHAR(24),
  "reviewed_at" TIMESTAMPTZ(3),
  "review_note" VARCHAR(500),
  "held_by_id" CHAR(24),
  "held_at" TIMESTAMPTZ(3),
  "hold_reason" VARCHAR(500),
  "cancelled_by_id" CHAR(24),
  "cancelled_at" TIMESTAMPTZ(3),
  "cancel_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_prescription_fills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_prescription_fills_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "pharmacy_prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_prescription_fills_status_check" CHECK ("status" IN ('pending_review', 'approved', 'on_hold', 'partially_dispensed', 'dispensed', 'cancelled', 'rejected')),
  CONSTRAINT "pharmacy_prescription_fills_number_check" CHECK ("fill_number" >= 1)
);

CREATE TABLE "pharmacy_dispenses" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "prescription_id" CHAR(24) NOT NULL,
  "fill_id" CHAR(24) NOT NULL,
  "dispensing_user_id" CHAR(24) NOT NULL,
  "controlled_reference" VARCHAR(120),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_dispenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_dispenses_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "pharmacy_prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_dispenses_fill_id_fkey" FOREIGN KEY ("fill_id") REFERENCES "pharmacy_prescription_fills"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "pharmacy_dispense_lines" (
  "id" CHAR(24) NOT NULL,
  "dispense_id" CHAR(24) NOT NULL,
  "fill_id" CHAR(24) NOT NULL,
  "prescription_line_id" CHAR(24) NOT NULL,
  "quantity" DECIMAL(19,4) NOT NULL,
  "supplied_product_id" CHAR(24) NOT NULL,
  "supplied_product_name" VARCHAR(180) NOT NULL,
  "substitution_reason" VARCHAR(300),
  CONSTRAINT "pharmacy_dispense_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_dispense_lines_dispense_id_fkey" FOREIGN KEY ("dispense_id") REFERENCES "pharmacy_dispenses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_dispense_lines_fill_id_fkey" FOREIGN KEY ("fill_id") REFERENCES "pharmacy_prescription_fills"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_dispense_lines_prescription_line_id_fkey" FOREIGN KEY ("prescription_line_id") REFERENCES "pharmacy_prescription_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_dispense_lines_quantity_check" CHECK ("quantity" > 0)
);

CREATE UNIQUE INDEX "pharmacy_patients_company_register_code_key" ON "pharmacy_patients"("company_id", "register_id", "patient_code");
CREATE INDEX "pharmacy_patients_company_register_name_idx" ON "pharmacy_patients"("company_id", "register_id", "full_name");
CREATE INDEX "pharmacy_patients_company_register_phone_idx" ON "pharmacy_patients"("company_id", "register_id", "phone");
CREATE UNIQUE INDEX "pharmacy_prescriptions_company_register_number_key" ON "pharmacy_prescriptions"("company_id", "register_id", "prescription_number");
CREATE INDEX "pharmacy_prescriptions_company_register_status_created_idx" ON "pharmacy_prescriptions"("company_id", "register_id", "status", "created_at" DESC);
CREATE INDEX "pharmacy_prescriptions_company_patient_created_idx" ON "pharmacy_prescriptions"("company_id", "patient_id", "created_at" DESC);
CREATE INDEX "pharmacy_prescription_lines_prescription_idx" ON "pharmacy_prescription_lines"("prescription_id");
CREATE UNIQUE INDEX "pharmacy_prescription_fills_prescription_fill_number_key" ON "pharmacy_prescription_fills"("prescription_id", "fill_number");
CREATE INDEX "pharmacy_prescription_fills_company_register_status_created_idx" ON "pharmacy_prescription_fills"("company_id", "register_id", "status", "created_at" DESC);
CREATE INDEX "pharmacy_dispenses_company_register_created_idx" ON "pharmacy_dispenses"("company_id", "register_id", "created_at" DESC);
CREATE INDEX "pharmacy_dispenses_prescription_fill_idx" ON "pharmacy_dispenses"("prescription_id", "fill_id");
CREATE INDEX "pharmacy_dispense_lines_dispense_idx" ON "pharmacy_dispense_lines"("dispense_id");
CREATE INDEX "pharmacy_dispense_lines_fill_idx" ON "pharmacy_dispense_lines"("fill_id");
CREATE INDEX "pharmacy_dispense_lines_prescription_line_idx" ON "pharmacy_dispense_lines"("prescription_line_id");

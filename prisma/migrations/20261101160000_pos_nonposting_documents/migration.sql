ALTER TABLE "pos_registers"
  ADD COLUMN "training_mode" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "pos_non_posting_documents" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "created_by_id" CHAR(24) NOT NULL,
  "document_number" VARCHAR(80) NOT NULL,
  "document_type" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "document_data" JSONB NOT NULL,
  "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "conversion_key" VARCHAR(100),
  "converted_invoice_id" CHAR(24),
  "converted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_non_posting_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_non_posting_documents_type_check" CHECK ("document_type" IN ('TRAINING', 'PROFORMA')),
  CONSTRAINT "pos_non_posting_documents_status_check" CHECK ("status" IN ('open', 'converted', 'cancelled')),
  CONSTRAINT "pos_non_posting_documents_conversion_check" CHECK (
    (
      "document_type" = 'PROFORMA'
      AND "conversion_key" IS NOT NULL
      AND (
        ("status" = 'converted' AND "converted_invoice_id" IS NOT NULL AND "converted_at" IS NOT NULL)
        OR ("status" IN ('open', 'cancelled') AND "converted_invoice_id" IS NULL AND "converted_at" IS NULL)
      )
    )
    OR (
      "document_type" = 'TRAINING'
      AND "status" IN ('open', 'cancelled')
      AND "conversion_key" IS NULL
      AND "converted_invoice_id" IS NULL
      AND "converted_at" IS NULL
    )
  ),
  CONSTRAINT "pos_non_posting_documents_company_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_non_posting_documents_register_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_non_posting_documents_company_document_number_key"
  ON "pos_non_posting_documents"("company_id", "document_number");
CREATE UNIQUE INDEX "pos_non_posting_documents_conversion_key_key"
  ON "pos_non_posting_documents"("conversion_key");
CREATE UNIQUE INDEX "pos_non_posting_documents_converted_invoice_id_key"
  ON "pos_non_posting_documents"("converted_invoice_id");
CREATE INDEX "pos_non_posting_documents_company_register_type_status_created_idx"
  ON "pos_non_posting_documents"("company_id", "register_id", "document_type", "status", "created_at" DESC);

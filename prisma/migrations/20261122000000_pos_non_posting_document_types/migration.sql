ALTER TABLE "pos_non_posting_documents"
  DROP CONSTRAINT "pos_non_posting_documents_type_check",
  ADD CONSTRAINT "pos_non_posting_documents_type_check"
    CHECK ("document_type" IN ('TRAINING', 'PROFORMA', 'QUOTE', 'DELIVERY_NOTE'));

ALTER TABLE "pos_non_posting_documents"
  DROP CONSTRAINT "pos_non_posting_documents_conversion_check",
  ADD CONSTRAINT "pos_non_posting_documents_conversion_check" CHECK (
    (
      "document_type" = 'PROFORMA'
      AND "conversion_key" IS NOT NULL
      AND (
        ("status" = 'converted' AND "converted_invoice_id" IS NOT NULL AND "converted_at" IS NOT NULL)
        OR ("status" IN ('open', 'cancelled') AND "converted_invoice_id" IS NULL AND "converted_at" IS NULL)
      )
    )
    OR (
      "document_type" IN ('TRAINING', 'QUOTE', 'DELIVERY_NOTE')
      AND "status" IN ('open', 'cancelled')
      AND "conversion_key" IS NULL
      AND "converted_invoice_id" IS NULL
      AND "converted_at" IS NULL
    )
  );

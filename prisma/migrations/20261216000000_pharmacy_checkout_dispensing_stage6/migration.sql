ALTER TABLE "pharmacy_dispenses"
  ADD COLUMN "invoice_id" CHAR(24);

CREATE INDEX "pharmacy_dispenses_company_invoice_idx"
  ON "pharmacy_dispenses"("company_id", "invoice_id");

CREATE UNIQUE INDEX "pharmacy_dispenses_invoice_fill_key"
  ON "pharmacy_dispenses"("invoice_id", "fill_id");

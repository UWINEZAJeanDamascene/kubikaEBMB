CREATE TABLE "pos_pharmacy_pending_stock_reservations" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "lines" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_pharmacy_pending_stock_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_pharmacy_pending_stock_reservations_company_invoice_key" UNIQUE ("company_id", "invoice_id"),
  CONSTRAINT "pos_pharmacy_pending_stock_reservations_invoice_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_pharmacy_pending_stock_reservations_status_check"
    CHECK ("status" IN ('reserved', 'consumed', 'released'))
);

CREATE INDEX "pos_pharmacy_pending_stock_reservations_company_status_idx"
  ON "pos_pharmacy_pending_stock_reservations" ("company_id", "status");

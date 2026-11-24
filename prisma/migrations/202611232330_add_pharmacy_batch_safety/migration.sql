ALTER TABLE "stock_batches"
ADD COLUMN IF NOT EXISTS "lot_number" TEXT,
ADD COLUMN IF NOT EXISTS "recall_status" VARCHAR(16) NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS "stock_batches_company_recall_expiry_idx"
ON "stock_batches" ("company_id", "recall_status", "expiry_date");

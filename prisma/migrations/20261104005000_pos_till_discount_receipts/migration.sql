ALTER TABLE "invoice_lines"
  ADD COLUMN IF NOT EXISTS "discount_reason" TEXT;

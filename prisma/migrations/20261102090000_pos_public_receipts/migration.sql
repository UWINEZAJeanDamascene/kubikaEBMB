CREATE TABLE "pos_public_receipt_tokens" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "first_viewed_at" TIMESTAMPTZ(3),
  "last_viewed_at" TIMESTAMPTZ(3),
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_public_receipt_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_public_receipt_tokens_view_count_check" CHECK ("view_count" >= 0)
);

CREATE UNIQUE INDEX "pos_public_receipt_tokens_token_hash_key"
  ON "pos_public_receipt_tokens"("token_hash");
CREATE INDEX "pos_public_receipt_tokens_company_id_invoice_id_created_at_idx"
  ON "pos_public_receipt_tokens"("company_id", "invoice_id", "created_at");
CREATE INDEX "pos_public_receipt_tokens_company_id_expires_at_revoked_at_idx"
  ON "pos_public_receipt_tokens"("company_id", "expires_at", "revoked_at");

ALTER TABLE "pos_public_receipt_tokens"
  ADD CONSTRAINT "pos_public_receipt_tokens_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_public_receipt_tokens"
  ADD CONSTRAINT "pos_public_receipt_tokens_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "system_settings"
  ALTER COLUMN "pos_receipt_settings" SET DEFAULT '{"paperWidth":80,"showCashier":true,"showCustomer":true,"showSku":false,"showBarcode":false,"headerNote":"","footerNote":"Thank you for shopping with us.","digitalReceiptsEnabled":true,"digitalReceiptExpiryDays":30}'::jsonb;

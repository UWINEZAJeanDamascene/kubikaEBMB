ALTER TABLE "pos_stored_value_accounts"
  ADD COLUMN "replacement_key" VARCHAR(100),
  ADD COLUMN "replaces_account_id" CHAR(24),
  ADD COLUMN "replaced_by_account_id" CHAR(24),
  ADD COLUMN "replaced_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "pos_stored_value_accounts_company_replacement_key_key"
  ON "pos_stored_value_accounts"("company_id", "replacement_key");

CREATE INDEX "pos_stored_value_accounts_company_replaced_by_idx"
  ON "pos_stored_value_accounts"("company_id", "replaced_by_account_id");

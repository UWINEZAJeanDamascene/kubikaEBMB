ALTER TABLE "pos_shifts"
  ADD COLUMN "idempotency_key" VARCHAR(100);

CREATE UNIQUE INDEX "pos_shifts_company_id_idempotency_key_key"
  ON "pos_shifts"("company_id", "idempotency_key");

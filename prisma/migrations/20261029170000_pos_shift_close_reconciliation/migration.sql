ALTER TABLE "pos_shifts"
  ADD COLUMN "close_idempotency_key" VARCHAR(100),
  ADD COLUMN "close_payload_hash" CHAR(64);

CREATE UNIQUE INDEX "pos_shifts_company_id_close_idempotency_key_key"
  ON "pos_shifts"("company_id", "close_idempotency_key");

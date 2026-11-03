ALTER TABLE "clients"
  ADD COLUMN "phone_normalized" VARCHAR(16),
  ADD COLUMN "phone_needs_review" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "group_tag" VARCHAR(80),
  ADD COLUMN "marketing_consent" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "digital_receipt_consent" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "is_walk_in" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "merged_into_client_id" CHAR(24),
  ADD COLUMN "merged_at" TIMESTAMPTZ(3),
  ADD COLUMN "merged_by_id" CHAR(24);

-- Normalize existing Rwanda phone values without changing the source contact JSON.
WITH normalized AS (
  SELECT id, company_id,
    regexp_replace(COALESCE(contact->>'phone', ''), '[^0-9]', '', 'g') AS digits
  FROM "clients"
)
UPDATE "clients" AS client
SET phone_normalized = CASE
  WHEN normalized.digits ~ '^0[0-9]{9}$' THEN '+250' || substring(normalized.digits FROM 2)
  WHEN normalized.digits ~ '^250[0-9]{9}$' THEN '+' || normalized.digits
  WHEN normalized.digits ~ '^[0-9]{9}$' THEN '+250' || normalized.digits
  ELSE NULL
END
FROM normalized
WHERE normalized.id = client.id AND normalized.company_id = client.company_id;

-- Existing duplicate contacts remain visible in contact JSON. Keep one indexed
-- normalized phone and require duplicates to be reviewed before either is edited.
WITH ranked AS (
  SELECT id, company_id, phone_normalized,
         row_number() OVER (PARTITION BY company_id, phone_normalized ORDER BY created_at, id) AS duplicate_rank
  FROM "clients"
  WHERE phone_normalized IS NOT NULL
)
UPDATE "clients" AS client
SET phone_normalized = NULL,
    phone_needs_review = TRUE
FROM ranked
WHERE ranked.id = client.id AND ranked.company_id = client.company_id AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "clients_company_phone_normalized_key"
  ON "clients"("company_id", "phone_normalized");
CREATE INDEX "clients_company_is_walk_in_idx"
  ON "clients"("company_id", "is_walk_in");
CREATE INDEX "clients_company_phone_needs_review_idx"
  ON "clients"("company_id", "phone_needs_review");
CREATE INDEX "clients_company_merged_into_idx"
  ON "clients"("company_id", "merged_into_client_id");
CREATE UNIQUE INDEX "clients_one_walk_in_per_company_key"
  ON "clients"("company_id") WHERE "is_walk_in" = TRUE;
CREATE UNIQUE INDEX "clients_company_id_id_key"
  ON "clients"("company_id", "id");

ALTER TABLE "clients"
  ADD CONSTRAINT "clients_merged_into_client_id_fkey"
    FOREIGN KEY ("merged_into_client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pos_customer_loyalty_ledger" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24) NOT NULL,
  "entry_type" VARCHAR(16) NOT NULL,
  "points" INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "invoice_id" CHAR(24),
  "reason" VARCHAR(500),
  "created_by_id" CHAR(24) NOT NULL,
  "idempotency_key" VARCHAR(120) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_customer_loyalty_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_customer_loyalty_ledger_entry_type_check"
    CHECK ("entry_type" IN ('EARN', 'REDEEM', 'ADJUST', 'EXPIRE', 'REVERSE')),
  CONSTRAINT "pos_customer_loyalty_ledger_points_check" CHECK ("points" <> 0),
  CONSTRAINT "pos_customer_loyalty_ledger_direction_check"
    CHECK (("entry_type" <> 'EARN' OR "points" > 0) AND ("entry_type" NOT IN ('REDEEM', 'EXPIRE') OR "points" < 0)),
  CONSTRAINT "pos_customer_loyalty_ledger_adjust_reason_check"
    CHECK ("entry_type" <> 'ADJUST' OR length(btrim(COALESCE("reason", ''))) >= 3),
  CONSTRAINT "pos_customer_loyalty_ledger_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_customer_loyalty_ledger_client_id_fkey"
    FOREIGN KEY ("company_id", "client_id") REFERENCES "clients"("company_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_customer_loyalty_ledger_company_idempotency_key"
  ON "pos_customer_loyalty_ledger"("company_id", "idempotency_key");
CREATE INDEX "pos_customer_loyalty_ledger_company_client_created_idx"
  ON "pos_customer_loyalty_ledger"("company_id", "client_id", "created_at" DESC);
CREATE INDEX "pos_customer_loyalty_ledger_company_invoice_idx"
  ON "pos_customer_loyalty_ledger"("company_id", "invoice_id");

CREATE TABLE "pos_customer_credit_ledger" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24) NOT NULL,
  "entry_type" VARCHAR(20) NOT NULL,
  "direction" VARCHAR(8) NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "balance_after" DECIMAL(19,4) NOT NULL,
  "invoice_id" CHAR(24),
  "receipt_id" CHAR(24),
  "due_date" TIMESTAMPTZ(3),
  "reason" VARCHAR(500),
  "created_by_id" CHAR(24) NOT NULL,
  "idempotency_key" VARCHAR(120) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_customer_credit_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_customer_credit_ledger_entry_type_check"
    CHECK ("entry_type" IN ('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF', 'REFUND_CREDIT')),
  CONSTRAINT "pos_customer_credit_ledger_direction_check" CHECK ("direction" IN ('INCREASE', 'DECREASE')),
  CONSTRAINT "pos_customer_credit_ledger_entry_direction_check"
    CHECK (("entry_type" <> 'CHARGE' OR "direction" = 'INCREASE') AND ("entry_type" NOT IN ('PAYMENT', 'WRITE_OFF', 'REFUND_CREDIT') OR "direction" = 'DECREASE')),
  CONSTRAINT "pos_customer_credit_ledger_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "pos_customer_credit_ledger_balance_check" CHECK ("balance_after" >= 0),
  CONSTRAINT "pos_customer_credit_ledger_reason_check"
    CHECK ("entry_type" NOT IN ('ADJUSTMENT', 'WRITE_OFF') OR length(btrim(COALESCE("reason", ''))) >= 3),
  CONSTRAINT "pos_customer_credit_ledger_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_customer_credit_ledger_client_id_fkey"
    FOREIGN KEY ("company_id", "client_id") REFERENCES "clients"("company_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_customer_credit_ledger_company_idempotency_key"
  ON "pos_customer_credit_ledger"("company_id", "idempotency_key");
CREATE INDEX "pos_customer_credit_ledger_company_client_created_idx"
  ON "pos_customer_credit_ledger"("company_id", "client_id", "created_at" DESC);
CREATE INDEX "pos_customer_credit_ledger_company_due_date_idx"
  ON "pos_customer_credit_ledger"("company_id", "due_date");
CREATE INDEX "pos_customer_credit_ledger_company_invoice_idx"
  ON "pos_customer_credit_ledger"("company_id", "invoice_id");
CREATE INDEX "pos_customer_credit_ledger_company_receipt_idx"
  ON "pos_customer_credit_ledger"("company_id", "receipt_id");

-- Ledgers cannot be edited or directly deleted. Tenant deletion remains possible
-- through the existing company-level cascade (nested FK cascades have depth > 1).
CREATE FUNCTION prevent_customer_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Customer ledgers are append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_customer_loyalty_ledger_append_only"
BEFORE UPDATE OR DELETE ON "pos_customer_loyalty_ledger"
FOR EACH ROW EXECUTE FUNCTION prevent_customer_ledger_mutation();
CREATE TRIGGER "pos_customer_credit_ledger_append_only"
BEFORE UPDATE OR DELETE ON "pos_customer_credit_ledger"
FOR EACH ROW EXECUTE FUNCTION prevent_customer_ledger_mutation();

-- Backfill the protected walk-in record for all existing companies.
INSERT INTO "clients" ("id", "company_id", "name", "code", "is_walk_in", "created_at", "updated_at")
SELECT substr(md5(company."id" || ':walk-in'), 1, 24), company."id", 'Walk-in customer', 'WALKIN-' || upper(company."id"), TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" AS company;

CREATE FUNCTION create_company_walk_in_customer() RETURNS trigger AS $$
BEGIN
  INSERT INTO "clients" ("id", "company_id", "name", "code", "is_walk_in", "created_at", "updated_at")
  VALUES (substr(md5(NEW."id" || ':walk-in'), 1, 24), NEW."id", 'Walk-in customer', 'WALKIN-' || upper(NEW."id"), TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "companies_create_walk_in_customer"
AFTER INSERT ON "companies"
FOR EACH ROW EXECUTE FUNCTION create_company_walk_in_customer();

CREATE FUNCTION protect_customer_record() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Customers must be deactivated instead of deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."is_walk_in" OR NEW."is_walk_in") AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'The company walk-in customer is protected';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."merged_into_client_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "clients" AS survivor
       WHERE survivor."company_id" = NEW."company_id"
         AND survivor."id" = NEW."merged_into_client_id"
     ) THEN
    RAISE EXCEPTION 'A customer can only be merged within its company';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "clients_protect_walk_in_customer"
BEFORE UPDATE OR DELETE ON "clients"
FOR EACH ROW EXECUTE FUNCTION protect_customer_record();

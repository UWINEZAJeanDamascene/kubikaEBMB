BEGIN;

-- POS audit rows are evidence, not dependent records. Remove the old
-- cascading/set-null links so deleting a tenant, register, or user cannot
-- rewrite or erase an audit row after the immutability triggers are installed.
ALTER TABLE "pos_audit_logs"
  DROP CONSTRAINT IF EXISTS "pos_audit_logs_company_id_fkey",
  DROP CONSTRAINT IF EXISTS "pos_audit_logs_register_id_fkey",
  DROP CONSTRAINT IF EXISTS "pos_audit_logs_user_id_fkey";

ALTER TABLE "pos_audit_logs"
  ADD COLUMN "stream_id" VARCHAR(100),
  ADD COLUMN "stream_sequence" BIGINT,
  ADD COLUMN "prev_hash" CHAR(64),
  ADD COLUMN "hash" CHAR(64),
  ADD CONSTRAINT "pos_audit_logs_chain_fields_check" CHECK (
    ("stream_id" IS NULL AND "stream_sequence" IS NULL AND "prev_hash" IS NULL AND "hash" IS NULL)
    OR
    ("stream_id" IS NOT NULL AND "stream_sequence" > 0 AND "prev_hash" IS NOT NULL AND "hash" IS NOT NULL)
  );

CREATE UNIQUE INDEX "pos_audit_logs_company_stream_sequence_key"
  ON "pos_audit_logs"("company_id", "stream_id", "stream_sequence");

-- Existing rows are retained with all chain fields NULL. They predate the
-- tamper-evident cutover and are reported as legacy/unverified by the verifier.
CREATE TABLE "pos_audit_checkpoints" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "stream_id" VARCHAR(100) NOT NULL,
  "checkpoint_date" DATE NOT NULL,
  "stream_sequence" BIGINT NOT NULL,
  "audit_log_id" CHAR(24) NOT NULL,
  "audit_hash" CHAR(64) NOT NULL,
  "checkpoint_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_audit_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_audit_checkpoints_stream_sequence_check" CHECK ("stream_sequence" > 0)
);
CREATE UNIQUE INDEX "pos_audit_checkpoints_company_stream_date_key"
  ON "pos_audit_checkpoints"("company_id", "stream_id", "checkpoint_date");
CREATE INDEX "pos_audit_checkpoints_company_checkpoint_date_idx"
  ON "pos_audit_checkpoints"("company_id", "checkpoint_date");

CREATE OR REPLACE FUNCTION "pos_audit_require_chain_on_insert"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."stream_id" IS NULL
    OR NEW."stream_sequence" IS NULL
    OR NEW."stream_sequence" <= 0
    OR NEW."prev_hash" IS NULL
    OR NEW."hash" IS NULL
    OR NEW."prev_hash" !~ '^[0-9a-f]{64}$'
    OR NEW."hash" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'New POS audit rows require a valid hash-chain entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_audit_logs_require_chain_insert"
  BEFORE INSERT ON "pos_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "pos_audit_require_chain_on_insert"();

CREATE OR REPLACE FUNCTION "pos_audit_reject_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'POS audit evidence is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "pos_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "pos_audit_reject_mutation"();
CREATE TRIGGER "pos_audit_checkpoints_immutable"
  BEFORE UPDATE OR DELETE ON "pos_audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "pos_audit_reject_mutation"();
CREATE TRIGGER "pos_audit_logs_no_truncate"
  BEFORE TRUNCATE ON "pos_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "pos_audit_reject_mutation"();
CREATE TRIGGER "pos_audit_checkpoints_no_truncate"
  BEFORE TRUNCATE ON "pos_audit_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION "pos_audit_reject_mutation"();

COMMIT;

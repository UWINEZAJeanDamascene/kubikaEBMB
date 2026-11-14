CREATE TABLE "pos_print_drawer_authorizations" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "action_type" VARCHAR(40) NOT NULL,
  "action_id" VARCHAR(160) NOT NULL,
  "shift_id" CHAR(24),
  "requester_id" CHAR(24) NOT NULL,
  "approval_id" CHAR(24),
  "reason" VARCHAR(500) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "outcome" VARCHAR(30),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_print_drawer_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_drawer_authorizations_token_hash_key" UNIQUE ("token_hash")
);

CREATE INDEX "pos_print_drawer_authorizations_company_id_register_id_expires_at_idx"
  ON "pos_print_drawer_authorizations" ("company_id", "register_id", "expires_at");

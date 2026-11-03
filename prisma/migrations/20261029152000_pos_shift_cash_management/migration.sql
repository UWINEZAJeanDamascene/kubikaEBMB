CREATE TYPE "PosShiftStatus" AS ENUM ('open', 'closed', 'reopened');
CREATE TYPE "PosCashMovementType" AS ENUM ('cash_in', 'cash_out', 'safe_drop');

ALTER TABLE "system_settings"
  ADD COLUMN "pos_cash_accountability" VARCHAR(16) NOT NULL DEFAULT 'REGISTER',
  ADD COLUMN "pos_cash_denominations" JSONB NOT NULL DEFAULT '[5000,2000,1000,500,100,50]'::jsonb,
  ADD COLUMN "pos_default_float" INTEGER,
  ADD COLUMN "pos_variance_tolerance" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "pos_variance_approval_limit" INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN "pos_cash_out_approval_limit" INTEGER NOT NULL DEFAULT 50000,
  ADD COLUMN "pos_drawer_warn_amount" INTEGER,
  ADD COLUMN "pos_held_sales_on_close" VARCHAR(16) NOT NULL DEFAULT 'WARN',
  ADD CONSTRAINT "system_settings_pos_cash_accountability_check"
    CHECK ("pos_cash_accountability" IN ('REGISTER', 'CASHIER')),
  ADD CONSTRAINT "system_settings_pos_held_sales_on_close_check"
    CHECK ("pos_held_sales_on_close" IN ('WARN', 'BLOCK', 'CARRY_OVER')),
  ADD CONSTRAINT "system_settings_pos_shift_amounts_check"
    CHECK (
      ("pos_default_float" IS NULL OR "pos_default_float" >= 0)
      AND "pos_variance_tolerance" >= 0
      AND "pos_variance_approval_limit" >= 0
      AND "pos_cash_out_approval_limit" >= 0
      AND ("pos_drawer_warn_amount" IS NULL OR "pos_drawer_warn_amount" >= 0)
    );

CREATE TABLE "pos_shifts" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "shift_number" INTEGER NOT NULL,
  "status" "PosShiftStatus" NOT NULL DEFAULT 'open',
  "opened_by" CHAR(24) NOT NULL,
  "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "opening_float" INTEGER NOT NULL,
  "opening_count" JSONB,
  "closed_by" CHAR(24),
  "closed_at" TIMESTAMPTZ(3),
  "counted_cash" INTEGER,
  "closing_count" JSONB,
  "expected_cash" INTEGER,
  "difference" INTEGER,
  "difference_reason" TEXT,
  "approved_by" CHAR(24),
  "journal_entry_id" CHAR(24),
  "note" TEXT,
  CONSTRAINT "pos_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_shifts_shift_number_check" CHECK ("shift_number" > 0),
  CONSTRAINT "pos_shifts_opening_float_check" CHECK ("opening_float" >= 0),
  CONSTRAINT "pos_shifts_counted_cash_check" CHECK ("counted_cash" IS NULL OR "counted_cash" >= 0),
  CONSTRAINT "pos_shifts_expected_cash_check" CHECK ("expected_cash" IS NULL OR "expected_cash" >= 0),
  CONSTRAINT "pos_shifts_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_shifts_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_shifts_opened_by_fkey"
    FOREIGN KEY ("opened_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_shifts_closed_by_fkey"
    FOREIGN KEY ("closed_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_shifts_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_shifts_register_id_shift_number_key"
  ON "pos_shifts"("register_id", "shift_number");
CREATE UNIQUE INDEX "one_open_shift_per_register"
  ON "pos_shifts"("register_id")
  WHERE "status" = 'open';
CREATE INDEX "pos_shifts_company_id_register_id_status_idx"
  ON "pos_shifts"("company_id", "register_id", "status");

CREATE TABLE "pos_cash_movements" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "shift_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "type" "PosCashMovementType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason_code" VARCHAR(40) NOT NULL,
  "note" TEXT,
  "performed_by" CHAR(24) NOT NULL,
  "approved_by" CHAR(24),
  "journal_entry_id" CHAR(24),
  "idempotency_key" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_movements_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "pos_cash_movements_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_movements_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_movements_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_movements_performed_by_fkey"
    FOREIGN KEY ("performed_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_movements_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_movements_company_id_idempotency_key_key"
  ON "pos_cash_movements"("company_id", "idempotency_key");
CREATE INDEX "pos_cash_movements_shift_id_created_at_idx"
  ON "pos_cash_movements"("shift_id", "created_at");
CREATE INDEX "pos_cash_movements_company_id_register_id_created_at_idx"
  ON "pos_cash_movements"("company_id", "register_id", "created_at");

CREATE TABLE "pos_z_reports" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "shift_id" CHAR(24) NOT NULL,
  "z_number" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "print_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "pos_z_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_z_reports_z_number_check" CHECK ("z_number" > 0),
  CONSTRAINT "pos_z_reports_print_count_check" CHECK ("print_count" >= 0),
  CONSTRAINT "pos_z_reports_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_z_reports_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_z_reports_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_z_reports_shift_id_key"
  ON "pos_z_reports"("shift_id");
CREATE UNIQUE INDEX "pos_z_reports_company_id_register_id_z_number_key"
  ON "pos_z_reports"("company_id", "register_id", "z_number");

ALTER TABLE "invoices"
  ADD COLUMN "shift_id" CHAR(24),
  ADD COLUMN "cashier_id" CHAR(24),
  ADD CONSTRAINT "invoices_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "invoices_cashier_id_fkey"
    FOREIGN KEY ("cashier_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "invoices_company_id_shift_id_idx"
  ON "invoices"("company_id", "shift_id");
CREATE INDEX "invoices_company_id_cashier_id_invoice_date_idx"
  ON "invoices"("company_id", "cashier_id", "invoice_date" DESC);

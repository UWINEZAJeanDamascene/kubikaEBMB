BEGIN;

ALTER TABLE "companies"
  ADD COLUMN "timezone" VARCHAR(64);

ALTER TABLE "company_module_entitlements"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pending_status" VARCHAR(8),
  ADD COLUMN "pending_effective_at" TIMESTAMPTZ(3),
  ADD COLUMN "pending_correlation_id" UUID,
  ADD CONSTRAINT "company_module_entitlements_version_check"
    CHECK ("version" > 0),
  ADD CONSTRAINT "company_module_entitlements_pending_status_check"
    CHECK ("pending_status" IS NULL OR "pending_status" IN ('on', 'off'));

CREATE INDEX "company_module_entitlements_pending_idx"
  ON "company_module_entitlements"("module_code", "pending_status", "pending_effective_at");

ALTER TABLE "pos_offline_snapshots"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "entitlement_version" INTEGER,
  ADD CONSTRAINT "pos_offline_snapshots_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "pos_offline_sales"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "entitlement_version" INTEGER,
  ADD CONSTRAINT "pos_offline_sales_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "stock_movements"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "stock_movements_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "stock_transfers"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "stock_transfers_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "invoices"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "invoices_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "credit_notes"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "credit_notes_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "purchase_orders"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "purchase_orders_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "purchases"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "purchases_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

ALTER TABLE "goods_received_notes"
  ADD COLUMN "fiscal_mode" VARCHAR(8),
  ADD COLUMN "fiscal_status" VARCHAR(32),
  ADD CONSTRAINT "goods_received_notes_fiscal_mode_check"
    CHECK ("fiscal_mode" IS NULL OR "fiscal_mode" IN ('none', 'ebm'));

COMMIT;

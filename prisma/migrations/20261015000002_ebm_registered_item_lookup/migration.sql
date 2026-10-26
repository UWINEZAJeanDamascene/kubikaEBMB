CREATE TABLE "ebm_registered_items" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "tin" CHAR(9) NOT NULL,
  "branch_id" VARCHAR(2) NOT NULL,
  "environment" VARCHAR(20) NOT NULL,
  "item_cd" VARCHAR(20) NOT NULL,
  "item_cls_cd" VARCHAR(10),
  "item_nm" TEXT,
  "use_yn" CHAR(1),
  "source" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ebm_registered_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ebm_registered_items_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ebm_registered_items_scope_item_key"
  ON "ebm_registered_items"("company_id", "tin", "branch_id", "environment", "item_cd");
CREATE INDEX "ebm_registered_items_scope_active_idx"
  ON "ebm_registered_items"("company_id", "environment", "branch_id", "use_yn");

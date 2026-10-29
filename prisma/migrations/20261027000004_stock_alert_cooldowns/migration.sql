CREATE TABLE "stock_alert_cooldowns" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "alert_type" TEXT NOT NULL,
    "last_notified_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_alert_cooldowns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_alert_cooldowns_company_id_product_id_alert_type_key"
    ON "stock_alert_cooldowns"("company_id", "product_id", "alert_type");

CREATE INDEX "stock_alert_cooldowns_company_id_last_notified_at_idx"
    ON "stock_alert_cooldowns"("company_id", "last_notified_at");

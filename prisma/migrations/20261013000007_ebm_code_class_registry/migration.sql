CREATE TABLE "ebm_code_classes" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "code_class" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "user_defined_name_1" TEXT,
  "user_defined_name_2" TEXT,
  "user_defined_name_3" TEXT,
  "use_yn" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "source" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ebm_code_classes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ebm_code_classes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ebm_code_classes_company_id_code_class_key" ON "ebm_code_classes"("company_id", "code_class");
CREATE INDEX "ebm_code_classes_company_id_active_idx" ON "ebm_code_classes"("company_id", "active");

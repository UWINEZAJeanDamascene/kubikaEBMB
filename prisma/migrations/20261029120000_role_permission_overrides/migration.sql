CREATE TABLE "role_permission_overrides" (
    "company_id" CHAR(24) NOT NULL,
    "role_id" CHAR(24) NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "role_permission_overrides_pkey" PRIMARY KEY ("company_id", "role_id")
);

CREATE INDEX "role_permission_overrides_role_id_idx"
    ON "role_permission_overrides"("role_id");

ALTER TABLE "role_permission_overrides"
    ADD CONSTRAINT "role_permission_overrides_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permission_overrides"
    ADD CONSTRAINT "role_permission_overrides_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

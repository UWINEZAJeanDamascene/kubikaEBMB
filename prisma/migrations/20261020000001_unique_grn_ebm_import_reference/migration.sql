-- An imported RRA item can have at most one local GRN, including drafts.
-- PostgreSQL permits multiple NULL values in this unique index for normal GRNs.
CREATE UNIQUE INDEX "goods_received_notes_company_id_ebm_import_reference_key"
ON "goods_received_notes"("company_id", "ebm_import_reference");

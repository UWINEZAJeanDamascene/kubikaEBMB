CREATE INDEX IF NOT EXISTS "products_alternate_barcodes_gin_idx"
  ON "products" USING GIN ("alternate_barcodes");

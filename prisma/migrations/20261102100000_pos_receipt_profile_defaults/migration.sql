ALTER TABLE "system_settings"
  ALTER COLUMN "pos_receipt_settings"
  SET DEFAULT '{"paperWidth":80,"columns":42,"showCashier":true,"showCustomer":true,"showSku":false,"showBarcode":false,"headerNote":"","footerNote":"Thank you for shopping with us.","returnPolicy":"","logoUrl":"","autoPrintOnSale":false,"digitalReceiptsEnabled":true,"digitalReceiptExpiryDays":30}'::jsonb;

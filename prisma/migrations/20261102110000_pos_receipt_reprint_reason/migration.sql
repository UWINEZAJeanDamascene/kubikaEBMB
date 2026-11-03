ALTER TABLE "pos_ebm_receipt_reprints"
  ADD COLUMN "reason" VARCHAR(500);

-- Preserve existing audit rows while marking that older clients did not capture a reason.
UPDATE "pos_ebm_receipt_reprints"
SET "reason" = '[Legacy reprint: reason was not recorded]'
WHERE "reason" IS NULL;

ALTER TABLE "pos_ebm_receipt_reprints"
  ALTER COLUMN "reason" SET NOT NULL,
  ADD CONSTRAINT "pos_ebm_receipt_reprints_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

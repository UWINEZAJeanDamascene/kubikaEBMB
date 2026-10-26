ALTER TABLE "ebm_item_classes"
  ADD COLUMN "major_target_yn" TEXT,
  ADD COLUMN "use_yn" TEXT;

UPDATE "ebm_item_classes"
SET "major_target_yn" = "source" ->> 'mjrTgYn'
WHERE "source" ? 'mjrTgYn';

UPDATE "ebm_item_classes"
SET "use_yn" = "source" ->> 'useYn'
WHERE "source" ? 'useYn';

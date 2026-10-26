ALTER TABLE "ebm_notices"
  ADD COLUMN "detail_url" TEXT,
  ADD COLUMN "registrant_name" TEXT;

UPDATE "ebm_notices"
SET "notice_date" = "source" ->> 'regDt'
WHERE jsonb_typeof("source") = 'object' AND "source" ? 'regDt';

UPDATE "ebm_notices"
SET "registrant_name" = "source" ->> 'regrNm'
WHERE jsonb_typeof("source") = 'object' AND "source" ? 'regrNm';

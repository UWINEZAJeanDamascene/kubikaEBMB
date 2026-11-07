'use strict';

const { dbClient } = require('../lib/prisma');

const SOURCE_TYPE_PATTERN = /^[a-z0-9_]{1,64}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function invalid(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

exports.get = async (req, res, next) => {
  const companyId = String(req.posAuthContext?.session?.companyId || '');
  const sourceType = String(req.params.sourceType || '').trim();
  const sourceId = String(req.params.sourceId || '').trim();
  if (!companyId) return invalid(res, 401, 'POS_SESSION_REQUIRED', 'An active POS session is required.');
  if (!SOURCE_TYPE_PATTERN.test(sourceType) || !OBJECT_ID_PATTERN.test(sourceId)) {
    return invalid(res, 400, 'POS_ACCOUNTING_POSTING_ID_INVALID', 'A valid source type and document ID are required.');
  }

  try {
    const rows = await dbClient().$queryRawUnsafe(
      `SELECT "source_type" AS "sourceType", "source_id" AS "sourceId", "status",
              "journal_entry_id" AS "journalEntryId", "journal_entry_ids" AS "journalEntryIds",
              "attempt_count" AS "attemptCount", "max_attempts" AS "maxAttempts",
              "next_retry_at" AS "nextRetryAt", "last_attempt_at" AS "lastAttemptAt",
              "posted_at" AS "postedAt", "failed_at" AS "failedAt", "last_error" AS "lastError"
       FROM "pos_accounting_postings"
       WHERE "company_id" = $1 AND "source_type" = $2 AND "source_id" = $3
       LIMIT 1`,
      companyId,
      sourceType,
      sourceId,
    );
    if (!rows.length) {
      return invalid(res, 404, 'POS_ACCOUNTING_POSTING_NOT_FOUND', 'No accounting posting record was found for this document.');
    }
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return next(error);
  }
};

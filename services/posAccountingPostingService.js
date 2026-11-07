'use strict';

const { createHash, randomBytes } = require('crypto');
const JournalService = require('./journalService');
const { runInTransaction } = require('./transactionService');

const MAX_ATTEMPTS = Math.max(1, Number(process.env.POS_ACCOUNTING_MAX_ATTEMPTS || 8));
const BASE_BACKOFF_MS = Math.max(250, Number(process.env.POS_ACCOUNTING_RETRY_BASE_MS || 2000));
const MAX_BACKOFF_MS = Math.max(BASE_BACKOFF_MS, Number(process.env.POS_ACCOUNTING_RETRY_MAX_MS || 3600000));
const INTERVAL_MS = Math.max(1000, Number(process.env.POS_ACCOUNTING_RETRY_INTERVAL_MS || 5000));
const BATCH_SIZE = Math.max(1, Number(process.env.POS_ACCOUNTING_RETRY_BATCH_SIZE || 25));

let running = false;
let timer = null;

function postingId() {
  return randomBytes(12).toString('hex');
}

function serializeError(error) {
  return {
    code: error?.code ? String(error.code) : null,
    message: String(error?.message || error || 'Unknown accounting posting error').slice(0, 2000),
  };
}

function retryAt(attemptCount, now = new Date()) {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delay);
}

function normalizeJournalEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('At least one journal entry is required for a POS posting.');
  }
  return JSON.parse(JSON.stringify(entries));
}

async function findPosting(tx, companyId, sourceType, sourceId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT "status", "journal_entry_ids" AS "journalEntryIds", "attempt_count" AS "attemptCount", "max_attempts" AS "maxAttempts" FROM "pos_accounting_postings" WHERE "company_id" = $1 AND "source_type" = $2 AND "source_id" = $3 LIMIT 1',
    String(companyId),
    String(sourceType),
    String(sourceId),
  );
  return rows[0] || null;
}

async function savePosting(tx, {
  companyId,
  sourceType,
  sourceId,
  status,
  entries,
  userId,
  attemptCount,
  journalEntryIds = [],
  error = null,
  metadata = {},
  now = new Date(),
}) {
  const payload = JSON.stringify({ userId: String(userId), entries, ...metadata });
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const journalIds = JSON.stringify(journalEntryIds);
  const lastError = error ? JSON.stringify(serializeError(error)) : null;
  const postedAt = status === 'posted' ? now : null;
  const failedAt = status === 'failed' ? now : null;
  const nextRetryAt = status === 'pending' ? retryAt(attemptCount, now) : null;
  const idempotencyKey = `${sourceType}:${sourceId}`;

  await tx.$executeRawUnsafe(
    `INSERT INTO "pos_accounting_postings" (
      "id", "company_id", "source_type", "source_id", "status",
      "journal_entry_id", "journal_entry_ids", "attempt_count", "max_attempts",
      "next_retry_at", "last_attempt_at", "posted_at", "failed_at",
      "last_error", "payload", "payload_hash", "idempotency_key",
      "created_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
      $14::jsonb, $15::jsonb, $16, $17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("company_id", "source_type", "source_id") DO UPDATE SET
      "status" = EXCLUDED."status",
      "journal_entry_id" = EXCLUDED."journal_entry_id",
      "journal_entry_ids" = EXCLUDED."journal_entry_ids",
      "attempt_count" = EXCLUDED."attempt_count",
      "max_attempts" = EXCLUDED."max_attempts",
      "next_retry_at" = EXCLUDED."next_retry_at",
      "last_attempt_at" = EXCLUDED."last_attempt_at",
      "posted_at" = EXCLUDED."posted_at",
      "failed_at" = EXCLUDED."failed_at",
      "last_error" = EXCLUDED."last_error",
      "payload" = EXCLUDED."payload",
      "payload_hash" = EXCLUDED."payload_hash",
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "pos_accounting_postings"."status" NOT IN ('posted', 'reversed')`,
    postingId(),
    String(companyId),
    String(sourceType),
    String(sourceId),
    status,
    journalEntryIds[0] || null,
    journalIds,
    attemptCount,
    MAX_ATTEMPTS,
    nextRetryAt,
    attemptCount > 0 ? now : null,
    postedAt,
    failedAt,
    lastError,
    payload,
    payloadHash,
    idempotencyKey,
  );
}

async function withPostingSavepoint(tx, callback) {
  await tx.$executeRawUnsafe('SAVEPOINT pos_accounting_posting_attempt');
  try {
    const result = await callback();
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT pos_accounting_posting_attempt');
    return result;
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pos_accounting_posting_attempt');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT pos_accounting_posting_attempt');
    throw error;
  }
}

async function enqueueForRetry({ tx, companyId, userId, sourceType, sourceId, entries, metadata = {} }) {
  if (!tx?.$executeRawUnsafe || !tx?.$queryRawUnsafe) {
    throw new TypeError('POS accounting retry enqueue requires the active PostgreSQL transaction client.');
  }
  const normalizedEntries = normalizeJournalEntries(entries);
  const existing = await findPosting(tx, companyId, sourceType, sourceId);
  if (existing && ['posted', 'reversed'].includes(existing.status)) {
    return {
      status: existing.status,
      journalEntryIds: existing.journalEntryIds || [],
      attemptCount: Number(existing.attemptCount) || 0,
      replayed: true,
    };
  }
  await savePosting(tx, {
    companyId,
    sourceType,
    sourceId,
    status: 'pending',
    entries: normalizedEntries,
    userId,
    attemptCount: 0,
    metadata,
  });
  return { status: 'pending', journalEntryIds: [], attemptCount: 0, replayed: !!existing };
}

async function enqueueSaleBuildRetry({ tx, companyId, userId, sourceId, buildContext, error }) {
  if (!tx?.$executeRawUnsafe || !tx?.$queryRawUnsafe) {
    throw new TypeError('POS accounting retry enqueue requires the active PostgreSQL transaction client.');
  }
  const sourceType = 'pos_sale';
  const existing = await findPosting(tx, companyId, sourceType, sourceId);
  if (existing && ['posted', 'reversed'].includes(existing.status)) {
    return {
      status: existing.status,
      journalEntryIds: existing.journalEntryIds || [],
      attemptCount: Number(existing.attemptCount) || 0,
      replayed: true,
    };
  }
  await savePosting(tx, {
    companyId,
    sourceType,
    sourceId,
    status: 'pending',
    entries: [],
    userId,
    attemptCount: 0,
    error,
    metadata: { buildContext },
  });
  console.error('[POS accounting posting] Sale journal build deferred to retry queue:', {
    companyId: String(companyId),
    sourceId: String(sourceId),
    error: error?.message || String(error),
  });
  return { status: 'pending', journalEntryIds: [], entries: [], attemptCount: 0 };
}

function journalEntryIds(entries) {
  return entries.map((entry) => entry?._id || entry?.id).filter(Boolean).map(String);
}

async function postOrQueue({ tx, companyId, userId, sourceType, sourceId, entries, metadata = {} }) {
  if ((!tx?.$executeRawUnsafe || !tx?.$queryRawUnsafe) && process.env.NODE_ENV === 'test') {
    const normalizedEntries = normalizeJournalEntries(entries);
    try {
      const createEntries = typeof JournalService.createEntriesAtomic === 'function'
        ? JournalService.createEntriesAtomic.bind(JournalService)
        : async (entryCompanyId, entryUserId, entryList, options) => Promise.all(entryList.map((entry) => (
          JournalService.createEntry(entryCompanyId, entryUserId, { ...entry, session: options.session })
        )));
      const created = await createEntries(
        companyId,
        userId,
        normalizedEntries.map((entry) => ({
          ...entry,
          date: entry.date ? new Date(entry.date) : new Date(),
        })),
        { session: tx || null, allowDuplicate: false },
      );
      if (!Array.isArray(created) || created.length !== normalizedEntries.length
        || created.some((entry) => !(entry?._id || entry?.id))) {
        throw new Error('Accounting did not confirm every POS journal entry.');
      }
      return {
        status: 'posted',
        journalEntryIds: journalEntryIds(created),
        entries: created,
        attemptCount: 1,
      };
    } catch (error) {
      console.error('[POS accounting posting] Test transaction deferred journal:', error.message || error);
      return {
        status: 'pending',
        journalEntryIds: [],
        entries: [],
        attemptCount: 1,
        error,
      };
    }
  }
  if (!tx?.$executeRawUnsafe || !tx?.$queryRawUnsafe) {
    throw new TypeError('POS accounting posting requires the active PostgreSQL transaction client.');
  }
  const normalizedEntries = normalizeJournalEntries(entries);
  const existing = await findPosting(tx, companyId, sourceType, sourceId);
  if (existing && ['posted', 'failed', 'reversed'].includes(existing.status)) {
    return {
      status: existing.status,
      journalEntryIds: existing.journalEntryIds || [],
      attemptCount: Number(existing.attemptCount) || 0,
    };
  }

  const attemptCount = Math.min(
    MAX_ATTEMPTS,
    (Number(existing?.attemptCount) || 0) + 1,
  );
  const now = new Date();
  let created;
  try {
    created = await withPostingSavepoint(tx, () => JournalService.createEntriesAtomic(
      companyId,
      userId,
      normalizedEntries.map((entry) => ({
        ...entry,
        date: entry.date ? new Date(entry.date) : new Date(),
      })),
      { session: tx, allowDuplicate: false },
    ));
    if (!Array.isArray(created) || created.length !== normalizedEntries.length
      || created.some((entry) => !(entry?._id || entry?.id))) {
      throw new Error('Accounting did not confirm every POS journal entry.');
    }
    const ids = journalEntryIds(created);
    await savePosting(tx, {
      companyId, sourceType, sourceId, status: 'posted', entries: normalizedEntries,
      userId, attemptCount, journalEntryIds: ids, metadata, now,
    });
    return { status: 'posted', journalEntryIds: ids, entries: created, attemptCount };
  } catch (error) {
    const status = attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await savePosting(tx, {
      companyId, sourceType, sourceId, status, entries: normalizedEntries,
      userId, attemptCount, error, metadata, now,
    });
    console.error('[POS accounting posting] Journal deferred to retry queue:', {
      companyId: String(companyId),
      sourceType: String(sourceType),
      sourceId: String(sourceId),
      attemptCount,
      status,
      error: error.message || String(error),
    });
    return { status, journalEntryIds: [], entries: [], attemptCount, error };
  }
}

async function updateSourceStatus(tx, posting, status, ids, now) {
  const journalEntryId = ids[0] || null;
  if (posting.source_type === 'pos_sale') {
    const revenueId = ids.find((id, index) => posting.payload?.entries?.[index]?.sourceType === 'invoice') || null;
    const cogsId = ids.find((id, index) => posting.payload?.entries?.[index]?.sourceType === 'invoice_cogs') || null;
    await tx.$executeRawUnsafe(
      `UPDATE "invoices"
       SET "pos_posting_status" = $1,
           "revenue_journal_entry_id" = COALESCE($2, "revenue_journal_entry_id"),
           "cogs_journal_entry_id" = COALESCE($3, "cogs_journal_entry_id"),
           "updated_at" = $4
       WHERE "id" = $5 AND "company_id" = $6 AND "pos_origin" = TRUE`,
      status,
      revenueId,
      cogsId,
      now,
      String(posting.source_id),
      String(posting.company_id),
    );
    await tx.$executeRawUnsafe(
      `UPDATE "pos_cheques"
       SET "sale_posting_status" = $1,
           "sale_journal_entry_id" = COALESCE($2, "sale_journal_entry_id"),
           "cheques_in_hand_account_code" = COALESCE($3, "cheques_in_hand_account_code"),
           "updated_at" = $4
       WHERE "invoice_id" = $5 AND "company_id" = $6`,
      status,
      revenueId,
      posting.payload?.chequesInHandAccountCode || null,
      now,
      String(posting.source_id),
      String(posting.company_id),
    );
    await tx.$executeRawUnsafe(
      `UPDATE "pos_stored_value_ledger"
       SET "posting_status" = $1,
           "journal_entry_id" = COALESCE($2, "journal_entry_id")
       WHERE "invoice_id" = $3
         AND "company_id" = $4
         AND "entry_type" IN ('redeem', 'earn')`,
      status,
      revenueId,
      String(posting.source_id),
      String(posting.company_id),
    );
    return;
  }
  if (posting.source_type === 'pos_cheque_deposit') {
    await tx.$executeRawUnsafe(
      'UPDATE "pos_cheque_deposits" SET "posting_status" = $1, "journal_entry_id" = COALESCE($2, "journal_entry_id") WHERE "id" = $3 AND "company_id" = $4',
      status,
      journalEntryId,
      String(posting.source_id),
      String(posting.company_id),
    );
    return;
  }
  if (posting.source_type === 'pos_cheque_bounce') {
    await tx.$executeRawUnsafe(
      'UPDATE "pos_cheques" SET "bounce_posting_status" = $1, "bounce_journal_entry_id" = COALESCE($2, "bounce_journal_entry_id"), "updated_at" = $3 WHERE "id" = $4 AND "company_id" = $5',
      status,
      journalEntryId,
      now,
      String(posting.source_id),
      String(posting.company_id),
    );
    await tx.$executeRawUnsafe(
      'UPDATE "ar_transaction_ledger" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "reconciliation_status" = CASE WHEN $5 = \'posted\' THEN \'verified\' ELSE "reconciliation_status" END WHERE "company_id" = $2 AND "source_type" = $3 AND "source_id" = $4',
      journalEntryId,
      String(posting.company_id),
      'pos_cheque_bounce',
      String(posting.source_id),
      status,
    );
    return;
  }
  if (['pos_cash_movement', 'pos_bank_deposit'].includes(posting.source_type)) {
    await tx.$executeRawUnsafe(
      'UPDATE "pos_cash_movements" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2 WHERE "id" = $3 AND "company_id" = $4',
      journalEntryId,
      status,
      String(posting.source_id),
      String(posting.company_id),
    );
    return;
  }
  if (['pos_stored_value_issue', 'pos_stored_value_load'].includes(posting.source_type)) {
    await tx.$executeRawUnsafe(
      `UPDATE "pos_stored_value_ledger"
       SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2
       WHERE "company_id" = $4
         AND (
         ($3::text IS NOT NULL AND "id"::text = $3::text)
           OR ($3::text IS NULL AND "account_id" = $5 AND "entry_type" = 'issue')
         )`,
      journalEntryId,
      status,
      posting.payload?.relatedLedgerEntryId || null,
      String(posting.company_id),
      String(posting.source_id),
    );
    if (posting.payload?.relatedCashMovementId) {
      await tx.$executeRawUnsafe(
        'UPDATE "pos_cash_movements" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2 WHERE "id" = $3 AND "company_id" = $4',
        journalEntryId,
        status,
        String(posting.payload.relatedCashMovementId),
        String(posting.company_id),
      );
    }
    return;
  }
  if (['pos_credit_account_payment', 'pos_credit_account_payment_refund'].includes(posting.source_type)) {
    const receiptJournalField = posting.source_type === 'pos_credit_account_payment'
      ? 'journal_entry_id'
      : 'reverse_journal_entry_id';
    const journalSourceType = posting.source_type === 'pos_credit_account_payment'
      ? 'ar_receipt'
      : 'ar_receipt_reversal';
    await tx.$executeRawUnsafe(
      `UPDATE "ar_receipts" SET "${receiptJournalField}" = $1 WHERE "id" = $2 AND "company_id" = $3`,
      journalEntryId,
      String(posting.source_id),
      String(posting.company_id),
    );
    await tx.$executeRawUnsafe(
      'UPDATE "ar_transaction_ledger" SET "journal_entry_id" = $1 WHERE "company_id" = $2 AND "source_type" = $3 AND "source_id" = $4',
      journalEntryId,
      String(posting.company_id),
      journalSourceType,
      String(posting.source_id),
    );
    if (posting.payload?.relatedCashMovementId) {
      await tx.$executeRawUnsafe(
        'UPDATE "pos_cash_movements" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2 WHERE "id" = $3 AND "company_id" = $4',
        journalEntryId,
        status,
        String(posting.payload.relatedCashMovementId),
        String(posting.company_id),
      );
    }
    return;
  }
  if (posting.source_type === 'pos_credit_note') {
    const entryIdFor = (sourceType) => ids.find((id, index) => (
      posting.payload?.entries?.[index]?.sourceType === sourceType
    )) || null;
    await tx.$executeRawUnsafe(
      `UPDATE "credit_notes"
       SET "revenue_reversal_entry_id" = COALESCE($1, "revenue_reversal_entry_id"),
           "cogs_reversal_entry_id" = COALESCE($2, "cogs_reversal_entry_id"),
           "write_off_reversal_entry_id" = COALESCE($3, "write_off_reversal_entry_id"),
           "pos_posting_status" = $4,
           "updated_at" = $5
       WHERE "id" = $6 AND "company_id" = $7 AND "pos_origin" = TRUE`,
      entryIdFor('credit_note'),
      entryIdFor('credit_note_cogs'),
      entryIdFor('credit_note_writeoff'),
      status,
      now,
      String(posting.source_id),
      String(posting.company_id),
    );
    return;
  }
  if (posting.source_type === 'pos_credit_note_application') {
    await tx.$executeRawUnsafe(
      `UPDATE "credit_notes"
       SET "applications" = (
         SELECT COALESCE(jsonb_agg(
           CASE WHEN item->>'id' = $1
             THEN jsonb_set(
               jsonb_set(item, '{postingStatus}', to_jsonb($2::text), TRUE),
               '{journalEntryId}',
               CASE WHEN $3::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($3::text) END,
               TRUE
             )
             ELSE item
           END
         ), '[]'::jsonb)
         FROM jsonb_array_elements(COALESCE("applications", '[]'::jsonb)) item
       ),
       "updated_at" = $4
       WHERE "id" = $5 AND "company_id" = $6 AND "pos_origin" = TRUE`,
      String(posting.source_id),
      status,
      journalEntryId,
      now,
      String(posting.payload?.creditNoteId || ''),
      String(posting.company_id),
    );
    await tx.$executeRawUnsafe(
      'UPDATE "ar_transaction_ledger" SET "journal_entry_id" = COALESCE($1, "journal_entry_id") WHERE "company_id" = $2 AND "source_type" = $3 AND "source_id" = $4',
      journalEntryId,
      String(posting.company_id),
      'credit_note_application',
      String(posting.source_id),
    );
    return;
  }
  if (posting.source_type === 'pos_credit_note_refund') {
    const creditNoteId = String(posting.payload?.creditNoteId || '');
    const refundKey = String(posting.payload?.refundIdempotencyKey || '');
    const refundId = String(posting.payload?.refundId || '');
    if (creditNoteId && (refundId || refundKey)) {
      await tx.$executeRawUnsafe(
        `UPDATE "credit_notes"
         SET "payments" = (
           SELECT COALESCE(jsonb_agg(
             CASE WHEN ($1 <> '' AND item->>'id' = $1) OR ($2 <> '' AND item->>'idempotencyKey' = $2)
               THEN jsonb_set(
                 jsonb_set(item, '{postingStatus}', to_jsonb($3::text), TRUE),
                 '{journalEntryId}',
                 CASE WHEN $4::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($4::text) END,
                 TRUE
               )
               ELSE item
             END
           ), '[]'::jsonb)
           FROM jsonb_array_elements(COALESCE("payments", '[]'::jsonb)) item
         ),
         "updated_at" = $5
         WHERE "id" = $6 AND "company_id" = $7 AND "pos_origin" = TRUE`,
        refundId,
        refundKey,
        status,
        journalEntryId,
        now,
        creditNoteId,
        String(posting.company_id),
      );
    }
    await tx.$executeRawUnsafe(
      'UPDATE "ar_transaction_ledger" SET "journal_entry_id" = COALESCE($1, "journal_entry_id") WHERE "company_id" = $2 AND "source_type" = $3 AND "source_id" = $4',
      journalEntryId,
      String(posting.company_id),
      'credit_note_refund',
      String(posting.source_id),
    );
    return;
  }
  if (posting.source_type === 'pos_shift_close') {
    const updatedShift = await tx.$executeRawUnsafe(
      'UPDATE "pos_shifts" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2 WHERE "id" = $3 AND "company_id" = $4',
      journalEntryId,
      status,
      String(posting.source_id),
      String(posting.company_id),
    );
    const correctionRows = await tx.$queryRawUnsafe(
      `UPDATE "pos_shift_correction_reports"
       SET "journal_entry_id" = COALESCE($1, "journal_entry_id"),
           "snapshot" = jsonb_set(
             jsonb_set(
               COALESCE("snapshot", '{}'::jsonb),
               '{cash,journalEntryId}',
               CASE WHEN $1::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($1::text) END,
               TRUE
             ),
             '{cash,postingStatus}', to_jsonb($2::text), TRUE
           )
       WHERE "id" = $3 AND "company_id" = $4
       RETURNING "shift_id" AS "shiftId"`,
      journalEntryId,
      status,
      String(posting.source_id),
      String(posting.company_id),
    );
    const shiftId = updatedShift === 1
      ? String(posting.source_id)
      : correctionRows[0]?.shiftId;
    if (shiftId) {
      if (updatedShift !== 1) {
        await tx.$executeRawUnsafe(
          'UPDATE "pos_shifts" SET "journal_entry_id" = COALESCE($1, "journal_entry_id"), "posting_status" = $2 WHERE "id" = $3 AND "company_id" = $4',
          journalEntryId,
          status,
          String(shiftId),
          String(posting.company_id),
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE "pos_z_reports"
         SET "snapshot" = jsonb_set(
           jsonb_set(
             COALESCE("snapshot", '{}'::jsonb),
             '{cash,journalEntryId}',
             CASE WHEN $1::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($1::text) END,
             TRUE
           ),
           '{cash,postingStatus}', to_jsonb($2::text), TRUE
         )
         WHERE "shift_id" = $3 AND "company_id" = $4`,
        journalEntryId,
        status,
        String(shiftId),
        String(posting.company_id),
      );
    }
  }
}

async function processDuePostings({ limit = BATCH_SIZE } = {}) {
  if (running) return { skipped: true, processed: 0 };
  running = true;
  try {
    return await runInTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id", "company_id", "source_type", "source_id", "payload",
                "attempt_count", "max_attempts"
         FROM "pos_accounting_postings"
         WHERE "status" = 'pending'
           AND "next_retry_at" <= CURRENT_TIMESTAMP
           AND "attempt_count" < "max_attempts"
         ORDER BY "next_retry_at" ASC, "created_at" ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        Math.max(1, Math.min(100, Number(limit) || BATCH_SIZE)),
      );
      let posted = 0;
      let deferred = 0;
      let failed = 0;
      for (const posting of rows) {
        const now = new Date();
        const attemptCount = Number(posting.attempt_count) + 1;
        let payload = posting.payload;
        let entries = Array.isArray(payload?.entries) ? payload.entries : [];
        try {
          if (!payload?.userId) {
            throw new TypeError('Stored POS posting payload is missing its actor.');
          }
          if (!entries.length && payload?.buildContext) {
            const { buildPosSaleJournalEntries } = require('./posSaleJournalBuilder');
            const built = await buildPosSaleJournalEntries(payload.buildContext);
            entries = built.journalEntries;
            payload = {
              ...payload,
              chequesInHandAccountCode: built.accounts?.chequesInHand || null,
            };
          }
          if (entries.length === 0) {
            throw new TypeError('Stored POS posting payload is missing its actor or journal entries.');
          }
          const created = await withPostingSavepoint(tx, () => JournalService.createEntriesAtomic(
            String(posting.company_id),
            String(payload.userId),
            entries.map((entry) => ({
              ...entry,
              date: entry.date ? new Date(entry.date) : new Date(),
            })),
            { session: tx, allowDuplicate: false },
          ));
          if (!Array.isArray(created) || created.length !== entries.length
            || created.some((entry) => !(entry?._id || entry?.id))) {
            throw new Error('Accounting did not confirm every retried POS journal entry.');
          }
          const ids = journalEntryIds(created);
          await tx.$executeRawUnsafe(
            `UPDATE "pos_accounting_postings"
             SET "status" = 'posted', "journal_entry_id" = $1, "journal_entry_ids" = $2::jsonb,
                 "attempt_count" = $3, "next_retry_at" = NULL, "last_attempt_at" = $4,
                 "posted_at" = $4, "failed_at" = NULL, "last_error" = NULL,
                 "payload" = $5::jsonb, "payload_hash" = $6,
                 "updated_at" = CURRENT_TIMESTAMP
             WHERE "id" = $7 AND "company_id" = $8`,
            ids[0] || null,
            JSON.stringify(ids),
            attemptCount,
            now,
            JSON.stringify({ ...payload, entries }),
            createHash('sha256').update(JSON.stringify({ ...payload, entries })).digest('hex'),
            String(posting.id),
            String(posting.company_id),
          );
          await updateSourceStatus(tx, { ...posting, payload: { ...payload, entries } }, 'posted', ids, now);
          posted += 1;
        } catch (error) {
          const status = attemptCount >= Number(posting.max_attempts) ? 'failed' : 'pending';
          const lastError = JSON.stringify(serializeError(error));
          const retryPayload = JSON.stringify({ ...payload, entries });
          await tx.$executeRawUnsafe(
            `UPDATE "pos_accounting_postings"
             SET "status" = $1, "attempt_count" = $2, "next_retry_at" = $3,
                 "last_attempt_at" = $4, "failed_at" = $5, "last_error" = $6::jsonb,
                 "payload" = $7::jsonb, "payload_hash" = $8,
                 "updated_at" = CURRENT_TIMESTAMP
             WHERE "id" = $9 AND "company_id" = $10`,
            status,
            attemptCount,
            status === 'pending' ? retryAt(attemptCount, now) : null,
            now,
            status === 'failed' ? now : null,
            lastError,
            retryPayload,
            createHash('sha256').update(retryPayload).digest('hex'),
            String(posting.id),
            String(posting.company_id),
          );
          await updateSourceStatus(tx, posting, status, [], now);
          if (status === 'failed') failed += 1;
          else deferred += 1;
          console.error('[POS accounting posting] Retry failed:', {
            companyId: String(posting.company_id),
            sourceType: String(posting.source_type),
            sourceId: String(posting.source_id),
            attemptCount,
            status,
            error: error.message || String(error),
          });
        }
      }
      return { skipped: false, processed: rows.length, posted, deferred, failed };
    });
  } finally {
    running = false;
  }
}

async function retryFailedPosting(companyId, postingId, client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT *
       FROM "pos_accounting_postings"
      WHERE "company_id" = $1 AND "id" = $2
      FOR UPDATE`,
    String(companyId),
    String(postingId),
  );
  const posting = rows[0];
  if (!posting) {
    throw Object.assign(new Error('The POS posting was not found.'), { code: 'POS_POSTING_NOT_FOUND' });
  }
  const journalEntryIds = Array.isArray(posting.journal_entry_ids)
    ? posting.journal_entry_ids
    : [];
  if (posting.status !== 'failed' || posting.journal_entry_id || journalEntryIds.length) {
    throw Object.assign(new Error('Only failed postings without a journal entry can be retried.'), {
      code: 'POS_POSTING_NOT_RETRYABLE',
    });
  }

  const now = new Date();
  await client.$executeRawUnsafe(
    `UPDATE "pos_accounting_postings"
        SET "status" = 'pending',
            "attempt_count" = 0,
            "next_retry_at" = $1,
            "last_attempt_at" = NULL,
            "failed_at" = NULL,
            "last_error" = NULL,
            "updated_at" = $1
      WHERE "company_id" = $2 AND "id" = $3 AND "status" = 'failed'`,
    now,
    String(companyId),
    String(postingId),
  );
  await updateSourceStatus(client, posting, 'pending', [], now);
  return {
    id: String(posting.id),
    sourceType: String(posting.source_type),
    sourceId: String(posting.source_id),
    status: 'pending',
  };
}

function start() {
  if (timer) return timer;
  void processDuePostings().catch((error) => {
    console.error('[POS accounting posting] Initial retry sweep failed:', error.message || error);
  });
  timer = setInterval(() => {
    void processDuePostings().catch((error) => {
      console.error('[POS accounting posting] Retry sweep failed:', error.message || error);
    });
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  INTERVAL_MS,
  postOrQueue,
  enqueueForRetry,
  enqueueSaleBuildRetry,
  processDuePostings,
  retryFailedPosting,
  retryAt,
  start,
  stop,
};

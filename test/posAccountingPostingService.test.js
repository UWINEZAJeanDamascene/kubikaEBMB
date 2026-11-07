jest.mock('../services/journalService', () => ({
  createEntriesAtomic: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));
jest.mock('../services/posSaleJournalBuilder', () => ({
  buildPosSaleJournalEntries: jest.fn(),
}));

const JournalService = require('../services/journalService');
const { runInTransaction } = require('../services/transactionService');
const { buildPosSaleJournalEntries } = require('../services/posSaleJournalBuilder');
const postingService = require('../services/posAccountingPostingService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const SOURCE_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const entry = {
  date: '2026-11-06T09:00:00.000Z',
  description: 'POS test sale',
  sourceType: 'invoice',
  sourceId: SOURCE_ID,
  lines: [
    { accountCode: '1000', debit: 100, credit: 0 },
    { accountCode: '4000', debit: 0, credit: 100 },
  ],
};

function transactionClient(queryImplementation = async () => []) {
  return {
    $queryRawUnsafe: jest.fn(queryImplementation),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
}

describe('POS accounting posting retry service', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    buildPosSaleJournalEntries.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('uses exponential backoff and caps the delay', () => {
    const now = new Date('2026-11-06T10:00:00.000Z');

    expect(postingService.retryAt(1, now).getTime() - now.getTime())
      .toBe(postingService.BASE_BACKOFF_MS);
    expect(postingService.retryAt(2, now).getTime() - now.getTime())
      .toBe(Math.min(postingService.MAX_BACKOFF_MS, postingService.BASE_BACKOFF_MS * 2));
    expect(postingService.retryAt(100, now).getTime() - now.getTime())
      .toBe(postingService.MAX_BACKOFF_MS);
  });

  test('allows an explicit retry only for a failed posting without a journal', async () => {
    const tx = transactionClient(async () => [{
      id: '507f1f77bcf86cd799439040',
      company_id: COMPANY_ID,
      source_type: 'pos_sale',
      source_id: SOURCE_ID,
      status: 'failed',
      journal_entry_id: null,
      journal_entry_ids: [],
      payload: { entries: [entry] },
    }]);

    await expect(postingService.retryFailedPosting(COMPANY_ID, '507f1f77bcf86cd799439040', tx))
      .resolves.toMatchObject({ status: 'pending', sourceType: 'pos_sale', sourceId: SOURCE_ID });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "company_id" = $1 AND "id" = $2'),
      COMPANY_ID,
      '507f1f77bcf86cd799439040',
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`SET "status" = 'pending'`),
      expect.any(Date),
      COMPANY_ID,
      '507f1f77bcf86cd799439040',
    );
  });

  test('rejects manual retry for a posting that is not failed or already has a journal', async () => {
    const tx = transactionClient(async () => [{
      id: '507f1f77bcf86cd799439040',
      company_id: COMPANY_ID,
      source_type: 'pos_sale',
      source_id: SOURCE_ID,
      status: 'posted',
      journal_entry_id: '507f1f77bcf86cd799439041',
      journal_entry_ids: ['507f1f77bcf86cd799439041'],
      payload: { entries: [entry] },
    }]);

    await expect(postingService.retryFailedPosting(COMPANY_ID, '507f1f77bcf86cd799439040', tx))
      .rejects.toMatchObject({ code: 'POS_POSTING_NOT_RETRYABLE' });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('persists a tenant-scoped retry record when journal creation fails', async () => {
    const tx = transactionClient();
    JournalService.createEntriesAtomic.mockRejectedValueOnce(
      Object.assign(new Error('Accounting period is closed'), { code: 'PERIOD_CLOSED' }),
    );

    const result = await postingService.postOrQueue({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      sourceType: 'pos_sale',
      sourceId: SOURCE_ID,
      entries: [entry],
    });

    expect(result).toMatchObject({ status: 'pending', journalEntryIds: [], attemptCount: 1 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SAVEPOINT pos_accounting_posting_attempt');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT pos_accounting_posting_attempt');
    const insert = tx.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "pos_accounting_postings"'));
    expect(insert).toBeDefined();
    expect(insert[1]).toHaveLength(24);
    expect(insert[2]).toBe(COMPANY_ID);
    expect(insert[3]).toBe('pos_sale');
    expect(insert[4]).toBe(SOURCE_ID);
    expect(insert[5]).toBe('pending');
    expect(insert[14]).toContain('PERIOD_CLOSED');
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"company_id" = $1 AND "source_type" = $2 AND "source_id" = $3'),
      COMPANY_ID,
      'pos_sale',
      SOURCE_ID,
    );
  });

  test('marks a successful first attempt posted with its journal IDs', async () => {
    const tx = transactionClient();
    JournalService.createEntriesAtomic.mockResolvedValueOnce([{ _id: '507f1f77bcf86cd799439014' }]);

    const result = await postingService.postOrQueue({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      sourceType: 'pos_sale',
      sourceId: SOURCE_ID,
      entries: [entry],
    });

    expect(result).toMatchObject({
      status: 'posted',
      journalEntryIds: ['507f1f77bcf86cd799439014'],
      attemptCount: 1,
    });
    const insert = tx.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "pos_accounting_postings"'));
    expect(insert[5]).toBe('posted');
    expect(insert[6]).toBe('507f1f77bcf86cd799439014');
  });

  test('does not duplicate a previously posted credit note reversal', async () => {
    const journalId = '507f1f77bcf86cd799439024';
    const tx = transactionClient(async () => [{
      status: 'posted',
      journalEntryIds: [journalId],
      attemptCount: 1,
      maxAttempts: 8,
    }]);

    const result = await postingService.postOrQueue({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      sourceType: 'pos_credit_note',
      sourceId: SOURCE_ID,
      entries: [{ ...entry, sourceType: 'credit_note' }],
    });

    expect(result).toMatchObject({ status: 'posted', journalEntryIds: [journalId] });
    expect(JournalService.createEntriesAtomic).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('queues sale context when journal construction fails before entries exist', async () => {
    const tx = transactionClient();
    const buildContext = { companyId: COMPANY_ID, userId: USER_ID, invoice: { id: SOURCE_ID } };
    const error = Object.assign(new Error('POS accounting profile is unavailable'), {
      accountingPostingFailure: true,
    });

    const result = await postingService.enqueueSaleBuildRetry({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      sourceId: SOURCE_ID,
      buildContext,
      error,
    });

    expect(result).toMatchObject({ status: 'pending', attemptCount: 0 });
    const insert = tx.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "pos_accounting_postings"'));
    expect(JSON.parse(insert[15])).toMatchObject({
      userId: USER_ID,
      entries: [],
      buildContext,
    });
  });

  test('rebuilds and persists sale entries from a deferred build context', async () => {
    const builtEntry = { ...entry, sourceType: 'invoice' };
    const buildContext = { companyId: COMPANY_ID, userId: USER_ID, invoice: { id: SOURCE_ID } };
    const due = {
      id: '507f1f77bcf86cd799439018',
      company_id: COMPANY_ID,
      source_type: 'pos_sale',
      source_id: SOURCE_ID,
      payload: { userId: USER_ID, entries: [], buildContext },
      attempt_count: 0,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    buildPosSaleJournalEntries.mockResolvedValue({ journalEntries: [builtEntry] });
    JournalService.createEntriesAtomic.mockResolvedValueOnce([{ _id: '507f1f77bcf86cd799439019' }]);

    const result = await postingService.processDuePostings();

    expect(result).toMatchObject({ processed: 1, posted: 1 });
    expect(buildPosSaleJournalEntries).toHaveBeenCalledWith(buildContext);
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledWith(
      COMPANY_ID,
      USER_ID,
      [expect.objectContaining({ sourceType: 'invoice' })],
      { session: tx, allowDuplicate: false },
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"payload" = $5::jsonb'),
      expect.any(String),
      expect.any(String),
      1,
      expect.any(Date),
      expect.stringContaining('"buildContext"'),
      expect.any(String),
      '507f1f77bcf86cd799439018',
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "invoices"'),
      'posted',
      '507f1f77bcf86cd799439019',
      null,
      expect.any(Date),
      SOURCE_ID,
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "pos_stored_value_ledger"'),
      'posted',
      '507f1f77bcf86cd799439019',
      SOURCE_ID,
      COMPANY_ID,
    );
  });

  test('claims due work with SKIP LOCKED and does not process it twice concurrently', async () => {
    const due = {
      id: '507f1f77bcf86cd799439015',
      company_id: COMPANY_ID,
      source_type: 'pos_sale',
      source_id: SOURCE_ID,
      payload: { userId: USER_ID, entries: [entry] },
      attempt_count: 1,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    let releasePosting;
    JournalService.createEntriesAtomic.mockImplementationOnce(() => new Promise((resolve) => {
      releasePosting = () => resolve([{ _id: '507f1f77bcf86cd799439016' }]);
    }));

    const first = postingService.processDuePostings();
    while (!releasePosting) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const concurrent = await postingService.processDuePostings();
    releasePosting();
    const result = await first;

    expect(concurrent).toEqual({ skipped: true, processed: 0 });
    expect(result).toMatchObject({ processed: 1, posted: 1 });
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledTimes(1);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "invoices"'),
      'posted',
      '507f1f77bcf86cd799439016',
      null,
      expect.any(Date),
      SOURCE_ID,
      COMPANY_ID,
    );
  });

  test('updates cheque and receivable posting status after a deferred bounce journal posts', async () => {
    const chequeId = '507f1f77bcf86cd799439020';
    const due = {
      id: '507f1f77bcf86cd799439021',
      company_id: COMPANY_ID,
      source_type: 'pos_cheque_bounce',
      source_id: chequeId,
      payload: { userId: USER_ID, entries: [entry] },
      attempt_count: 1,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockResolvedValueOnce([{ _id: '507f1f77bcf86cd799439022' }]);

    await postingService.processDuePostings();

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "pos_cheques" SET "bounce_posting_status" = $1'),
      'posted',
      '507f1f77bcf86cd799439022',
      expect.any(Date),
      chequeId,
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"reconciliation_status" = CASE WHEN $5'),
      '507f1f77bcf86cd799439022',
      COMPANY_ID,
      'pos_cheque_bounce',
      chequeId,
      'posted',
    );
  });

  test('updates stored-value ledger and cash movement status after issue posting retry', async () => {
    const ledgerId = '507f1f77bcf86cd799439045';
    const movementId = '507f1f77bcf86cd799439046';
    const due = {
      id: '507f1f77bcf86cd799439047',
      company_id: COMPANY_ID,
      source_type: 'pos_stored_value_issue',
      source_id: ledgerId,
      payload: {
        userId: USER_ID,
        relatedLedgerEntryId: ledgerId,
        relatedCashMovementId: movementId,
        entries: [entry],
      },
      attempt_count: 0,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockResolvedValueOnce([{ _id: '507f1f77bcf86cd799439048' }]);

    await postingService.processDuePostings();

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "pos_stored_value_ledger"'),
      '507f1f77bcf86cd799439048',
      'posted',
      ledgerId,
      COMPANY_ID,
      due.source_id,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "pos_cash_movements"'),
      '507f1f77bcf86cd799439048',
      'posted',
      movementId,
      COMPANY_ID,
    );
  });

  test('updates shift and Z-report snapshots to failed when a variance retry reaches its cap', async () => {
    const shiftId = '507f1f77bcf86cd799439049';
    const due = {
      id: '507f1f77bcf86cd799439050',
      company_id: COMPANY_ID,
      source_type: 'pos_shift_close',
      source_id: shiftId,
      payload: { userId: USER_ID, entries: [entry] },
      attempt_count: 7,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockRejectedValueOnce(new Error('Closed accounting period'));

    const result = await postingService.processDuePostings();

    expect(result).toMatchObject({ processed: 1, failed: 1 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "pos_shifts" SET "journal_entry_id" = COALESCE($1'),
      null,
      'failed',
      shiftId,
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("'{cash,postingStatus}'"),
      null,
      'failed',
      shiftId,
      COMPANY_ID,
    );
  });

  test('updates credit note, application, and refund event records after retry succeeds', async () => {
    const creditNoteId = '507f1f77bcf86cd799439025';
    const applicationId = '507f1f77bcf86cd799439026';
    const refundId = '507f1f77bcf86cd799439027';
    const journalIds = [
      '507f1f77bcf86cd799439028',
      '507f1f77bcf86cd799439029',
      '507f1f77bcf86cd799439030',
      '507f1f77bcf86cd799439031',
      '507f1f77bcf86cd799439032',
    ];
    const dueRows = [
      {
        id: '507f1f77bcf86cd799439033',
        company_id: COMPANY_ID,
        source_type: 'pos_credit_note',
        source_id: creditNoteId,
        payload: { userId: USER_ID, entries: [
          { ...entry, sourceType: 'credit_note' },
          { ...entry, sourceType: 'credit_note_cogs' },
          { ...entry, sourceType: 'credit_note_writeoff' },
        ] },
        attempt_count: 0,
        max_attempts: 8,
      },
      {
        id: '507f1f77bcf86cd799439034',
        company_id: COMPANY_ID,
        source_type: 'pos_credit_note_application',
        source_id: applicationId,
        payload: { userId: USER_ID, creditNoteId, entries: [entry] },
        attempt_count: 0,
        max_attempts: 8,
      },
      {
        id: '507f1f77bcf86cd799439035',
        company_id: COMPANY_ID,
        source_type: 'pos_credit_note_refund',
        source_id: refundId,
        payload: {
          userId: USER_ID,
          creditNoteId,
          refundId,
          refundIdempotencyKey: 'refund-key-123456',
          entries: [entry],
        },
        attempt_count: 0,
        max_attempts: 8,
      },
    ];
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? dueRows : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic
      .mockResolvedValueOnce(journalIds.slice(0, 3).map((_id, index) => ({ _id: journalIds[index] })))
      .mockResolvedValueOnce([{ _id: journalIds[3] }])
      .mockResolvedValueOnce([{ _id: journalIds[4] }]);

    const result = await postingService.processDuePostings();

    expect(result).toMatchObject({ processed: 3, posted: 3 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"pos_posting_status" = $4'),
      journalIds[0],
      journalIds[1],
      journalIds[2],
      'posted',
      expect.any(Date),
      creditNoteId,
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(COALESCE(\"applications\""),
      applicationId,
      'posted',
      journalIds[3],
      expect.any(Date),
      creditNoteId,
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "ar_transaction_ledger"'),
      journalIds[3],
      COMPANY_ID,
      'credit_note_application',
      applicationId,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(COALESCE(\"payments\""),
      refundId,
      'refund-key-123456',
      'posted',
      journalIds[4],
      expect.any(Date),
      creditNoteId,
      COMPANY_ID,
    );
  });

  test('keeps a deferred POS refund marked pending when a retry still fails', async () => {
    const refundId = '507f1f77bcf86cd799439036';
    const creditNoteId = '507f1f77bcf86cd799439037';
    const due = {
      id: '507f1f77bcf86cd799439038',
      company_id: COMPANY_ID,
      source_type: 'pos_credit_note_refund',
      source_id: refundId,
      payload: {
        userId: USER_ID,
        creditNoteId,
        refundId,
        refundIdempotencyKey: 'refund-key-654321',
        entries: [entry],
      },
      attempt_count: 1,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockRejectedValueOnce(new Error('Accounting period is closed'));

    const result = await postingService.processDuePostings();

    expect(result).toMatchObject({ processed: 1, deferred: 1, posted: 0 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(COALESCE(\"payments\""),
      refundId,
      'refund-key-654321',
      'pending',
      null,
      expect.any(Date),
      creditNoteId,
      COMPANY_ID,
    );
  });

  test('matches deferred refund events by idempotency key when legacy payload has no refund ID', async () => {
    const creditNoteId = '507f1f77bcf86cd799439039';
    const due = {
      id: '507f1f77bcf86cd799439040',
      company_id: COMPANY_ID,
      source_type: 'pos_credit_note_refund',
      source_id: '507f1f77bcf86cd799439041',
      payload: {
        userId: USER_ID,
        creditNoteId,
        refundIdempotencyKey: 'refund-key-legacy',
        entries: [entry],
      },
      attempt_count: 1,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockResolvedValueOnce([{ _id: '507f1f77bcf86cd799439042' }]);

    await postingService.processDuePostings();

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(COALESCE(\"payments\""),
      '',
      'refund-key-legacy',
      'posted',
      '507f1f77bcf86cd799439042',
      expect.any(Date),
      creditNoteId,
      COMPANY_ID,
    );
  });

  test('stops retrying at the cap and records the closed-period error', async () => {
    const due = {
      id: '507f1f77bcf86cd799439017',
      company_id: COMPANY_ID,
      source_type: 'pos_sale',
      source_id: SOURCE_ID,
      payload: { userId: USER_ID, entries: [entry] },
      attempt_count: 7,
      max_attempts: 8,
    };
    const tx = transactionClient(async (sql) => (
      String(sql).includes('FOR UPDATE SKIP LOCKED') ? [due] : []
    ));
    runInTransaction.mockImplementation((operation) => operation(tx));
    JournalService.createEntriesAtomic.mockRejectedValueOnce(
      Object.assign(new Error('Target accounting period is closed'), { code: 'PERIOD_CLOSED' }),
    );

    const result = await postingService.processDuePostings();

    expect(result).toMatchObject({ processed: 1, failed: 1, deferred: 0 });
    const update = tx.$executeRawUnsafe.mock.calls.find(([sql]) => (
      String(sql).includes('SET "status" = $1, "attempt_count"')
    ));
    expect(update.slice(1, 4)).toEqual(['failed', 8, null]);
    expect(update[6]).toContain('PERIOD_CLOSED');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "invoices"'),
      'failed',
      null,
      null,
      expect.any(Date),
      SOURCE_ID,
      COMPANY_ID,
    );
  });
});

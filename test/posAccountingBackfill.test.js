jest.mock('../lib/prisma', () => ({
  prisma: {
    invoice: { findMany: jest.fn() },
    posAccountingPosting: { findFirst: jest.fn() },
    posRegister: { findFirst: jest.fn() },
    $queryRawUnsafe: jest.fn(),
  },
  connectPrisma: jest.fn(),
  disconnectPrisma: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posSaleJournalBuilder', () => ({
  buildPosSaleJournalEntries: jest.fn(),
}));
jest.mock('../services/posAccountingPostingService', () => ({
  enqueueForRetry: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { buildPosSaleJournalEntries } = require('../services/posSaleJournalBuilder');
const { enqueueForRetry } = require('../services/posAccountingPostingService');
const { parseArgs, backfill } = require('../scripts/backfill-pos-accounting-postings');

const invoice = {
  id: '507f1f77bcf86cd799439011',
  companyId: '507f1f77bcf86cd799439012',
  cashierId: '507f1f77bcf86cd799439013',
  status: 'fully_paid',
  posOrigin: true,
  revenueJournalEntryId: null,
  registerId: '507f1f77bcf86cd799439014',
  lines: [],
  payments: [],
};

describe('POS accounting posting backfill', () => {
  beforeEach(() => {
    prisma.invoice.findMany.mockReset();
    prisma.posAccountingPosting.findFirst.mockReset();
    prisma.posRegister.findFirst.mockReset();
    prisma.$queryRawUnsafe.mockReset();
    runInTransaction.mockReset();
    enqueueForRetry.mockReset();
    buildPosSaleJournalEntries.mockReset();
    prisma.invoice.findMany
      .mockResolvedValueOnce([invoice])
      .mockResolvedValueOnce([]);
    prisma.posAccountingPosting.findFirst.mockResolvedValue(null);
    prisma.posRegister.findFirst.mockResolvedValue(null);
    prisma.$queryRawUnsafe.mockResolvedValue([{ earned: '0' }]);
    buildPosSaleJournalEntries.mockResolvedValue({ journalEntries: [{ sourceType: 'invoice' }] });
  });

  test('defaults to dry-run and parses an optional tenant filter', () => {
    expect(parseArgs([])).toEqual({ apply: false, companyId: null });
    expect(parseArgs(['--dry-run', '--company-id', invoice.companyId])).toEqual({
      apply: false,
      companyId: invoice.companyId,
    });
    expect(() => parseArgs(['--company-id', 'not-an-id'])).toThrow('--company-id must be a 24-character company ID.');
  });

  test('dry-run reports eligible invoices without enqueuing or updating anything', async () => {
    const result = await backfill({ logger: { error: jest.fn() } });

    expect(result).toEqual({
      mode: 'dry-run',
      examined: 1,
      wouldQueue: 1,
      queued: 0,
      skipped: 0,
      failed: 0,
    });
    expect(enqueueForRetry).not.toHaveBeenCalled();
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('apply enqueues only within a tenant-scoped transaction and marks the invoice pending', async () => {
    const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
    runInTransaction.mockImplementation(async (operation) => operation(tx));

    const result = await backfill({ apply: true, companyId: invoice.companyId, logger: { error: jest.fn() } });

    expect(result).toMatchObject({ mode: 'apply', examined: 1, queued: 1, failed: 0 });
    expect(enqueueForRetry).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      companyId: invoice.companyId,
      userId: invoice.cashierId,
      sourceType: 'pos_sale',
      sourceId: invoice.id,
    }));
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "id" = $1 AND "company_id" = $2'),
      invoice.id,
      invoice.companyId,
    );
  });
});

'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: {
    client: { findMany: jest.fn() },
    posVoucher: { findMany: jest.fn() },
    posStoredValueAccount: { findMany: jest.fn() },
    posPublicReceiptToken: { findMany: jest.fn() },
  },
}));

const { prisma } = require('../lib/prisma');
const { getPosScannerOfflineIndex, MAX_INDEX_ROWS, readIndexRows } = require('../services/posScannerOfflineIndexService');

describe('POS scanner offline index', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.client.findMany.mockResolvedValue([{
      id: 'customer-1',
      name: 'Aline',
      code: 'CLI-001',
      customFields: { loyaltyCardCodes: [' CARD-1 ', 'CARD-1', ''] },
    }]);
    prisma.posVoucher.findMany.mockResolvedValue([{ codeHash: 'a'.repeat(64) }]);
    prisma.posStoredValueAccount.findMany.mockResolvedValue([{ codeHash: 'b'.repeat(64) }]);
    prisma.posPublicReceiptToken.findMany.mockResolvedValue([{
      tokenHash: 'c'.repeat(64),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      invoice: { id: 'invoice-1', referenceNo: 'INV-001', invoiceDate: new Date('2026-11-14T00:00:00.000Z') },
    }]);
  });

  it('returns minimal customer data and hashes, never voucher or gift-card plaintext codes', async () => {
    const index = await getPosScannerOfflineIndex('company-1', new Date('2026-11-14T00:00:00.000Z'));

    expect(index.customers).toEqual([{ id: 'customer-1', name: 'Aline', code: 'CLI-001', cardCodes: ['CARD-1'] }]);
    expect(index.voucherCodeHashes).toEqual(['a'.repeat(64)]);
    expect(index.giftCardCodeHashes).toEqual(['b'.repeat(64)]);
    expect(index.receipts).toEqual([{
      tokenHash: 'c'.repeat(64),
      expiresAt: '2026-12-01T00:00:00.000Z',
      invoiceId: 'invoice-1',
      receiptNumber: 'INV-001',
      invoiceDate: '2026-11-14T00:00:00.000Z',
    }]);
    expect(prisma.client.findMany.mock.calls[0][0].where.companyId).toBe('company-1');
    expect(JSON.stringify(index)).not.toMatch(/gift-card-code|voucher-code/i);
  });

  it('rejects an oversized index instead of returning a partial offline cache', async () => {
    prisma.client.findMany.mockResolvedValue(Array.from({ length: MAX_INDEX_ROWS + 1 }, (_, index) => ({
      id: `customer-${index}`,
      name: 'Customer',
      code: `CLI-${index}`,
      customFields: {},
    })));

    await expect(getPosScannerOfflineIndex('company-1')).rejects.toMatchObject({
      status: 413,
      code: 'POS_SCANNER_OFFLINE_INDEX_TOO_LARGE',
    });
  });

  it('paginates bounded reads without exceeding the HTTP query limit', async () => {
    const model = {
      findMany: jest.fn(({ skip, take }) => Promise.resolve(
        skip === 0 ? Array.from({ length: take }, (_, index) => ({ id: `row-${index}` })) : [],
      )),
    };

    const rows = await readIndexRows(model, { orderBy: { id: 'asc' } }, 'customer');

    expect(rows).toHaveLength(500);
    expect(model.findMany).toHaveBeenCalledTimes(2);
    expect(model.findMany.mock.calls.map(([query]) => query.take)).toEqual([500, 500]);
  });
});

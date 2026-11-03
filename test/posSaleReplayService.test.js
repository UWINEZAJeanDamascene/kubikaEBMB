jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const Invoice = require('../models/Invoice');
const { dbClient } = require('../lib/prisma');
const { replayPosSale } = require('../services/posSaleReplayService');

describe('shared POS sale replay service', () => {
  const query = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.mockReturnValue({ $queryRawUnsafe: query });
  });

  test('does no lookup when the request has no idempotency key', async () => {
    await expect(replayPosSale({ requestKey: '', companyId: 'co' })).resolves.toEqual({ handled: false });
    expect(query).not.toHaveBeenCalled();
  });

  test('rejects reuse by a different cashier or payload', async () => {
    query.mockResolvedValue([{ createdById: 'cashier-1', payloadHash: 'hash-1', status: 'completed', invoiceId: 'invoice-1' }]);
    const result = await replayPosSale({
      companyId: 'co', requestKey: 'key', payloadHash: 'hash-2', cashierId: 'cashier-1', body: {},
    });
    expect(result).toMatchObject({ handled: true, status: 409, body: { code: 'POS_IDEMPOTENCY_KEY_CONFLICT' } });
    expect(Invoice.findOne).not.toHaveBeenCalled();
  });

  test('replays completed sale data and calculates the same cash change response', async () => {
    const invoice = { grandTotal: 90, totalAmount: 95 };
    const populate = jest.fn().mockResolvedValue(invoice);
    Invoice.findOne.mockReturnValue({ populate });
    query.mockResolvedValue([{ createdById: 'cashier-1', payloadHash: 'hash-1', status: 'completed', invoiceId: 'invoice-1' }]);

    const result = await replayPosSale({
      companyId: 'co', requestKey: 'key', payloadHash: 'hash-1', cashierId: 'cashier-1',
      body: { payments: [{ paymentMethod: 'cash', amount: 100 }] },
    });

    expect(Invoice.findOne).toHaveBeenCalledWith({ _id: 'invoice-1', company: 'co' });
    expect(populate).toHaveBeenCalledWith('client lines.product createdBy');
    expect(result).toEqual({ handled: true, status: 200, body: {
      success: true, message: 'This checkout was already completed.', data: invoice, changeDue: 10, replayed: true,
    } });
  });

  test('keeps unfinished requests blocked from creating a duplicate sale', async () => {
    query.mockResolvedValue([{ createdById: 'cashier-1', payloadHash: 'hash-1', status: 'pending', invoiceId: null }]);
    const result = await replayPosSale({
      companyId: 'co', requestKey: 'key', payloadHash: 'hash-1', cashierId: 'cashier-1', body: {},
    });
    expect(result).toMatchObject({ handled: true, status: 409, body: { code: 'POS_SALE_STILL_PROCESSING' } });
    expect(Invoice.findOne).not.toHaveBeenCalled();
  });
});

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../models/ARTransactionLedger', () => ({}));
jest.mock('../services/arTrackingService', () => ({}));
jest.mock('../services/ledgerReadService', () => ({ getARTransactions: jest.fn() }));
jest.mock('../models/Invoice', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));

const { dbClient } = require('../lib/prisma');
const Invoice = require('../models/Invoice');
const { getCurrentReceivables } = require('../controllers/arReconciliationController');

describe('AR current receivables', () => {
  let queryRaw;

  beforeEach(() => {
    jest.clearAllMocks();
    Invoice.countDocuments.mockResolvedValue(0);
    Invoice.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    queryRaw = jest.fn((sql) => sql.includes('SELECT "_id", name, code')
      ? Promise.resolve([{
          _id: 'client-1',
          name: 'Imported Customer',
          code: 'CLI-1',
          totalOutstanding: '2840000',
          invoiceCount: 0,
        }])
      : Promise.resolve([{
          totalOutstanding: '2840000',
          totalInvoices: 0,
          overdueAmount: '0',
          overdueCount: 0,
        }]));
    dbClient.mockReturnValue({ $queryRawUnsafe: queryRaw });
  });

  test('includes imported client balances in AR totals without inventing invoices', async () => {
    const req = { user: { company: { _id: 'company-1' } }, query: {} };
    const res = { json: jest.fn() };

    await getCurrentReceivables(req, res, (error) => { throw error; });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        invoices: [],
        summary: expect.objectContaining({
          totalOutstanding: 2840000,
          totalInvoices: 0,
          overdueAmount: 0,
        }),
        clientSummary: [{
          _id: 'client-1',
          client: { _id: 'client-1', name: 'Imported Customer', code: 'CLI-1' },
          totalOutstanding: 2840000,
          invoiceCount: 0,
        }],
      }),
    }));

    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const [sql, companyId] of queryRaw.mock.calls) {
      expect(sql).toContain('c.outstanding_balance');
      expect(sql).toContain('WHERE c.company_id = $1');
      expect(sql).toContain('FROM client_balances');
      expect(companyId).toBe('company-1');
    }
  });
});

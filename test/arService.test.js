jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/periodService', () => ({}));
jest.mock('../services/cacheService', () => ({}));
jest.mock('../services/arTrackingService', () => ({}));
jest.mock('../models/Client', () => ({ findOne: jest.fn() }));
jest.mock('../models/Invoice', () => ({ find: jest.fn() }));
jest.mock('../models/ARReceipt', () => ({ find: jest.fn() }));
jest.mock('../models/ARReceiptAllocation', () => ({ find: jest.fn() }));
jest.mock('../models/ARTransactionLedger', () => ({ find: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const ARReceipt = require('../models/ARReceipt');
const ARTransactionLedger = require('../models/ARTransactionLedger');
const ARService = require('../services/arService');

describe('AR service aging report', () => {
  let queryRaw;

  beforeEach(() => {
    jest.clearAllMocks();
    queryRaw = jest.fn().mockResolvedValue([]);
    dbClient.mockReturnValue({ $queryRawUnsafe: queryRaw });
  });

  test('shows an imported customer balance in the statement without an invoice', async () => {
    const client = {
      _id: 'client-1',
      name: 'Rubavu Lakeside Lodge',
      code: 'CLI-1',
      outstandingBalance: 1426000,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    };
    Client.findOne.mockResolvedValue(client);
    Invoice.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockResolvedValue([]),
    });
    ARReceipt.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
    ARTransactionLedger.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    const statement = await ARService.getClientStatement('company-1', 'client-1');

    expect(statement.data.summary).toMatchObject({
      totalInvoiced: 0,
      totalPaid: 0,
      totalOutstanding: 1426000,
      balance: 1426000,
      invoiceCount: 0,
    });
    expect(statement.data.transactions).toEqual([expect.objectContaining({
      reference: 'OPENING BALANCE',
      description: 'Imported opening balance for Rubavu Lakeside Lodge',
      debit: 1426000,
      credit: 0,
      runningBalance: 1426000,
      type: 'opening_balance',
    })]);
    expect(ARTransactionLedger.find).toHaveBeenCalledWith({
      client: 'client-1',
      company: 'company-1',
      transactionType: 'opening_balance',
      sourceType: 'opening_ar',
    });
  });

  test('shows only the portion of a client balance not covered by invoice balances', async () => {
    Client.findOne.mockResolvedValue({
      _id: 'client-1',
      name: 'Customer',
      code: 'CLI-1',
      outstandingBalance: 300,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    Invoice.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockResolvedValue([{
        _id: 'invoice-1',
        totalAmount: 300,
        amountOutstanding: 250,
        amountPaid: 50,
        invoiceDate: new Date('2026-10-02T00:00:00.000Z'),
        referenceNo: 'INV-1',
        status: 'partially_paid',
        payments: [{ amount: 50, date: new Date('2026-10-03T00:00:00.000Z') }],
      }]),
    });
    ARReceipt.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
    ARTransactionLedger.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    const statement = await ARService.getClientStatement('company-1', 'client-1');

    expect(statement.data.transactions).toHaveLength(3);
    expect(statement.data.transactions[0]).toMatchObject({
      type: 'opening_balance',
      debit: 50,
      runningBalance: 50,
    });
    expect(statement.data.transactions[1]).toMatchObject({
      type: 'invoice',
      debit: 300,
      runningBalance: 350,
    });
    expect(statement.data.transactions[2]).toMatchObject({
      type: 'payment',
      credit: 50,
      runningBalance: 300,
    });
    expect(statement.data.summary.balance).toBe(300);
  });

  test('includes imported client balances not represented by open invoices', async () => {
    queryRaw.mockResolvedValue([{
      clientId: 'client-1',
      clientName: 'Imported Customer',
      clientCode: 'CLI-1',
      current: 2840000,
      '1-30': 0,
      '31-60': 0,
      '61-90': 0,
      '90+': 0,
    }]);

    const report = await ARService.getAgingReport('company-1', {
      asOfDate: '2026-11-02',
    });

    expect(report.data).toEqual([{
      client: { _id: 'client-1', name: 'Imported Customer', code: 'CLI-1' },
      current: '2840000.00',
      '1-30': '0.00',
      '31-60': '0.00',
      '61-90': '0.00',
      '90+': '0.00',
      totalBalance: '2840000.00',
    }]);

    const [sql, companyId] = queryRaw.mock.calls[0];
    expect(sql).toContain('c.outstanding_balance');
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain('WHERE c.company_id = $1');
    expect(companyId).toBe('company-1');
  });

  test('keeps invoice aging and scopes a client-filtered report', async () => {
    queryRaw.mockResolvedValue([{
      clientId: 'client-1',
      clientName: 'Customer',
      clientCode: 'CLI-1',
      current: 220,
      '1-30': 80,
      '31-60': 0,
      '61-90': 0,
      '90+': 0,
    }]);

    const report = await ARService.getAgingReport('company-1', {
      clientId: 'client-1',
      asOfDate: '2026-11-02',
    });

    expect(report.data[0]).toMatchObject({
      current: '220.00',
      '1-30': '80.00',
      totalBalance: '300.00',
    });

    const [sql, companyId, asOfDate, clientId] = queryRaw.mock.calls[0];
    expect(sql).toContain('AND c.id = $3');
    expect(sql).toContain('AND i.client_id = $3');
    expect(companyId).toBe('company-1');
    expect(asOfDate).toBeInstanceOf(Date);
    expect(clientId).toBe('client-1');
  });
});

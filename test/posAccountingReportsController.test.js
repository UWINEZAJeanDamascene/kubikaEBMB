jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: {},
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(),
  writePosAuditLog: jest.fn(),
}));
jest.mock('../services/posAccountingPostingService', () => ({
  retryFailedPosting: jest.fn(),
}));
jest.mock('../services/posAccountingProfileService', () => ({
  getProfile: jest.fn(),
  resolveAccount: jest.fn(),
}));
jest.mock('../services/posBankDepositClearingService', () => ({
  getBankDepositClearingBalances: jest.fn(),
}));

const { dbClient } = require('../lib/prisma');
const controller = require('../controllers/posAccountingReportsController');
const accountingProfileService = require('../services/posAccountingProfileService');
const { getBankDepositClearingBalances } = require('../services/posBankDepositClearingService');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('POS accounting reports controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists only the authenticated company postings with the supplied filters', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'posting-1', status: 'failed' }])
      .mockResolvedValueOnce([{ total: 1 }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });
    const res = response();

    await controller.listPostings({
      user: { companyId: 'company-a' },
      query: { status: 'failed', sourceType: 'pos_sale', registerId: 'register-a', tillType: 'retail', page: '1' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.postings).toEqual([{ id: 'posting-1', status: 'failed' }]);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('p."company_id" = $1'),
      'company-a',
      null,
      null,
      'failed',
      'pos_sale',
      'register-a',
      'retail',
      50,
      0,
    );
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('p."company_id" = $1'), 'company-a', null, null, 'failed', 'pos_sale', 'register-a', 'retail');
  });

  test('rejects invalid date ranges before issuing report queries', async () => {
    const client = { posRegister: { findMany: jest.fn() } };
    dbClient.mockReturnValue(client);
    const res = response();

    await controller.getReport({
      user: { companyId: 'company-a' },
      query: { report: 'reconciliation', from: 'not-a-date' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REPORT_DATE_INVALID');
    expect(client.posRegister.findMany).not.toHaveBeenCalled();
  });

  test('rejects unsupported report names', async () => {
    const res = response();
    await controller.getReport({
      user: { companyId: 'company-a' },
      query: { report: 'not-a-report' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REPORT_TYPE_INVALID');
    expect(dbClient).not.toHaveBeenCalled();
  });

  test('returns register-level reconciliation differences and current clearing and gift-card balances', async () => {
    const client = {
      posRegister: {
        findMany: jest.fn().mockResolvedValue([{ id: 'register-a', name: 'Front till', systemTillType: 'retail' }]),
      },
      posStoredValueAccount: {
        findMany: jest.fn().mockResolvedValue([{ balance: 75, isActive: true, currencyCode: 'RWF' }]),
      },
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          registerId: 'register-a',
          registerName: 'Front till',
          tillType: 'retail',
          saleCount: 1,
          posTotal: 100,
        }])
        .mockResolvedValueOnce([{ registerId: 'register-a', ledgerTotal: 100 }])
        .mockResolvedValueOnce([{ accountCode: '2230', balance: 75 }])
        .mockResolvedValueOnce([{ accountCode: '2230', balance: 75 }]),
    };
    dbClient.mockReturnValue(client);
    accountingProfileService.getProfile.mockResolvedValue({ companyDefaults: {} });
    accountingProfileService.resolveAccount.mockReturnValue('2230');
    getBankDepositClearingBalances.mockResolvedValue(new Map([['register-a', 40]]));
    const res = response();

    await controller.getReport({
      user: { companyId: 'company-a' },
      query: { report: 'reconciliation', from: '2026-11-01', to: '2026-11-30' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.rows[0]).toMatchObject({
      registerId: 'register-a',
      posSalesTotal: 100,
      ledgerSalesTotal: 100,
      difference: 0,
      isZeroDifference: true,
      bankDepositClearingBalance: 40,
    });
    expect(res.body.data.giftCardLiability).toMatchObject({
      storedValueBalance: 75,
      ledgerLiabilityBalance: 75,
      difference: 0,
      isZeroDifference: true,
    });
    expect(res.body.data.clearingBalances).toContainEqual({
      accountCode: '2230',
      mappings: expect.arrayContaining(['cardClearing']),
      balance: 75,
    });
    expect(res.body.data.totals.isZeroDifference).toBe(true);
    expect(res.body.registers).toEqual([{ id: 'register-a', name: 'Front till', systemTillType: 'retail' }]);
    expect(client.$queryRawUnsafe.mock.calls[0][0]).toContain('UNION ALL');
    expect(client.$queryRawUnsafe.mock.calls[0][0]).not.toContain('FULL OUTER JOIN');
    expect(client.$queryRawUnsafe.mock.calls[1][0]).toContain('UNION ALL');
    expect(client.$queryRawUnsafe.mock.calls[1][0]).not.toContain('FULL OUTER JOIN');
    expect(client.$queryRawUnsafe.mock.calls[3][0]).toContain('FROM "pos_stored_value_ledger" ledger');
    expect(client.$queryRawUnsafe.mock.calls[3][0]).toContain(`stored_value."kind" = 'gift_card'`);
    expect(client.$queryRawUnsafe.mock.calls[3][0]).toContain('ledger."posting_status" = \'posted\'');
  });
});

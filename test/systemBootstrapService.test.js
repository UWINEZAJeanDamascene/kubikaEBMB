jest.mock('../lib/prisma', () => ({
  prisma: {
    chartOfAccount: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));
jest.mock('../constants/chartOfAccounts', () => ({
  CHART_OF_ACCOUNTS: {
    '1000': { name: 'Cash', type: 'asset' },
  },
}));
jest.mock('../scripts/seedSystemRoles', () => ({
  syncSystemRoles: jest.fn(),
}));
jest.mock('../services/CurrencyService', () => ({
  seedCurrencies: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { syncCompanyChartOfAccounts } = require('../services/systemBootstrapService');

describe('system bootstrap chart-of-accounts sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chartOfAccount.findUnique.mockResolvedValue(null);
    prisma.chartOfAccount.upsert.mockResolvedValue({});
  });

  it('reconciles a retry-safe upsert when the database closes its connection', async () => {
    prisma.chartOfAccount.upsert
      .mockRejectedValueOnce(Object.assign(new Error('Server has closed the connection'), { code: 'P1017' }))
      .mockResolvedValueOnce({});

    await expect(syncCompanyChartOfAccounts('company-1')).resolves.toEqual({
      created: 1,
      updated: 0,
    });

    expect(prisma.chartOfAccount.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.chartOfAccount.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { companyId_code: { companyId: 'company-1', code: '1000' } },
      create: expect.objectContaining({
        companyId: 'company-1',
        code: '1000',
        name: 'Cash',
      }),
      update: expect.objectContaining({ name: 'Cash' }),
    }));
  });

  it('does not retry non-connection errors', async () => {
    const error = Object.assign(new Error('Permission denied'), { code: 'P2003' });
    prisma.chartOfAccount.upsert.mockRejectedValue(error);

    await expect(syncCompanyChartOfAccounts('company-1')).rejects.toBe(error);
    expect(prisma.chartOfAccount.upsert).toHaveBeenCalledTimes(1);
  });
});

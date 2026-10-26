const mockDevice = { findOne: jest.fn(), EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' } };
const mockStateModel = { findOneAndUpdate: jest.fn() };
const mockInvoice = { find: jest.fn() };
const mockService = {
  getConfig: jest.fn(() => ({ mode: 'sandbox' })),
  selectSales: jest.fn(),
};

jest.mock('../models/EBMDevice', () => mockDevice);
jest.mock('../models/EBMSyncState', () => mockStateModel);
jest.mock('../models/Invoice', () => mockInvoice);
jest.mock('../services/ebmService', () => mockService);

const EBMSalesSyncService = require('../services/ebmSalesSyncService');

describe('EBM sales-summary cursor safety', () => {
  const priorFlag = process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED;
  let syncState;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED;
    mockService.getConfig.mockReturnValue({ mode: 'sandbox' });
    mockDevice.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ tin: '999991130' }) });
    syncState = { lastReqDt: '20261001000000', save: jest.fn().mockResolvedValue(undefined) };
    mockStateModel.findOneAndUpdate.mockResolvedValue(syncState);
    mockService.selectSales.mockResolvedValue({
      resultDt: '20261012120000', data: { saleList: [] },
    });
    mockInvoice.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
  });

  afterAll(() => {
    if (priorFlag === undefined) delete process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED;
    else process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED = priorFlag;
  });

  it('replays the baseline and does not advance an unconfirmed live cursor', async () => {
    const result = await EBMSalesSyncService.syncSalesSummaries('company-1');
    expect(mockService.selectSales).toHaveBeenCalledWith(expect.objectContaining({ lastReqDt: '20000101000000' }));
    expect(syncState.lastReqDt).toBe('20000101000000');
    expect(result.summary).toMatchObject({ cursorAdvanced: false, cursorPolicy: 'fixed_baseline_replay_unconfirmed' });
  });

  it('advances only when cursor semantics are explicitly confirmed and resultDt is monotonic', async () => {
    process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED = 'true';
    const result = await EBMSalesSyncService.syncSalesSummaries('company-1');
    expect(mockService.selectSales).toHaveBeenCalledWith(expect.objectContaining({ lastReqDt: '20261001000000' }));
    expect(syncState.lastReqDt).toBe('20261012120000');
    expect(result.summary).toMatchObject({ cursorAdvanced: true, cursorPolicy: 'incremental_confirmed' });
  });

  it('rejects malformed resultDt before cursor persistence', async () => {
    process.env.EBM_SALES_CURSOR_SEMANTICS_CONFIRMED = 'true';
    mockService.selectSales.mockResolvedValue({ resultDt: '20260230000000', data: { saleList: [] } });
    await expect(EBMSalesSyncService.syncSalesSummaries('company-1'))
      .rejects.toMatchObject({ code: 'EBM_LOOKUP_CURSOR_REGRESSION' });
    expect(syncState.lastReqDt).toBe('20261001000000');
    expect(syncState.save).not.toHaveBeenCalled();
  });
});

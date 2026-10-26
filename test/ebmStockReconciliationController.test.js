jest.mock('../services/ebmStockService', () => ({
  reconcileStockMaster: jest.fn(),
  resubmitStockMasterFromReconciliation: jest.fn(),
}));

const EBMStockService = require('../services/ebmStockService');
const controller = require('../controllers/ebmController');

describe('EBM stock reconciliation controller boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses authenticated tenant context and forwards only branch/cursor selectors', async () => {
    const result = { status: 'movement_history_only', branchId: '12', localStockCompared: false };
    EBMStockService.reconcileStockMaster.mockResolvedValue(result);
    const req = {
      companyId: 'authenticated-tenant',
      body: { branchId: '12', lastReqDt: '20261020120000', companyId: 'attacker-tenant', tin: '999999999' },
    };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await controller.reconcileStockMaster(req, res, next);

    expect(EBMStockService.reconcileStockMaster).toHaveBeenCalledWith('authenticated-tenant', {
      branchId: '12', lastReqDt: '20261020120000',
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: result });
    expect(next).not.toHaveBeenCalled();
  });

  it('routes backend retrieval failures to common error handling without swallowing them', async () => {
    const error = Object.assign(new Error('select failed'), { code: 'EBM_STOCK_SELECT_FAILED' });
    EBMStockService.reconcileStockMaster.mockRejectedValue(error);
    const next = jest.fn();

    await controller.reconcileStockMaster({ companyId: 'tenant-1', body: {} }, { json: jest.fn() }, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});

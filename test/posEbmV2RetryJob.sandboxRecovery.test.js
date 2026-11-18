jest.mock('../services/posEbmV2RecoveryService', () => ({
  sweepExpiredLeases: jest.fn(),
  claimDueIds: jest.fn(),
}));
jest.mock('../services/fiscalService', () => ({
  applyResolvedV2Receipt: jest.fn(),
  submitCreditNote: jest.fn(),
  submitInvoice: jest.fn(),
}));

const recovery = require('../services/posEbmV2RecoveryService');
const fiscalService = require('../services/fiscalService');
const retryJob = require('../services/posEbmV2RetryJob');

describe('POS EBM V2 sandbox-off receipt recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recovery.sweepExpiredLeases.mockResolvedValue([]);
    recovery.claimDueIds.mockResolvedValue([]);
  });

  test('applies a persisted signed receipt locally without submitting fiscal dependents', async () => {
    recovery.claimDueIds.mockResolvedValue([{
      id: 'outbox-1',
      companyId: 'company-1',
      documentId: 'invoice-1',
      documentType: 'pos',
      signedAt: new Date(),
      sourceAppliedAt: null,
      sourceOnly: true,
    }]);

    const result = await retryJob.runOnce();

    expect(fiscalService.applyResolvedV2Receipt).toHaveBeenCalledWith(
      'invoice-1', 'company-1', 'outbox-1',
    );
    expect(fiscalService.submitInvoice).not.toHaveBeenCalled();
    expect(result.results).toEqual([{ id: 'outbox-1', status: 'source_recovered' }]);
  });
});

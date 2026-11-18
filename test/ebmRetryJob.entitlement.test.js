'use strict';

jest.mock('../models/EBMSubmissionQueue', () => ({
  find: jest.fn(),
}));

jest.mock('../services/ebmQueueService', () => ({
  getCompanyEbmSetting: jest.fn(),
  getMaxRetries: jest.fn(() => 5),
}));

const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const EBMQueueService = require('../services/ebmQueueService');
const { runOnce } = require('../services/ebmRetryJob');

describe('EBM retry job entitlement gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not process a submitting queue row for a disabled company', async () => {
    const record = {
      _id: 'queue-row-1',
      companyId: 'company-1',
      ebmStatus: 'submitting',
    };
    EBMSubmissionQueue.find.mockImplementation(() => ({
      sort() {
        return this;
      },
      limit: jest.fn().mockResolvedValue([record]),
    }));
    EBMQueueService.getCompanyEbmSetting.mockResolvedValue({ enabled: false });

    const result = await runOnce();

    expect(EBMQueueService.getCompanyEbmSetting).toHaveBeenCalledWith('company-1');
    expect(result.results).toEqual([
      expect.objectContaining({ id: 'queue-row-1', status: 'skipped' }),
    ]);
  });
});

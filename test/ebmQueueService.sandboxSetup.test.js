jest.mock('../services/moduleEntitlementService', () => ({
  getEntitlement: jest.fn(),
}));
jest.mock('../services/ebmService', () => ({
  isSandboxMode: jest.fn(),
  getConfig: jest.fn(() => ({ mode: 'sandbox' })),
}));

const moduleEntitlementService = require('../services/moduleEntitlementService');
const ebmService = require('../services/ebmService');
const ebmQueueService = require('../services/ebmQueueService');

describe('EBM queue sandbox setup policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 1 });
  });

  test('allows explicit EBM operations while the company is off in sandbox mode', async () => {
    ebmService.isSandboxMode.mockReturnValue(true);

    await expect(ebmQueueService.assertEbmEnabled('company-1')).resolves.toEqual({
      enabled: false,
      version: 1,
    });
  });

  test('keeps EBM operations blocked while the company is off outside sandbox mode', async () => {
    ebmService.isSandboxMode.mockReturnValue(false);

    await expect(ebmQueueService.assertEbmEnabled('company-1')).rejects.toMatchObject({
      code: 'EBM_DISABLED',
      statusCode: 403,
    });
  });
});

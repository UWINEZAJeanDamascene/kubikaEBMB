const { VSDC_ENDPOINTS } = require('../services/ebmService');
const { __test__ } = require('../services/ebmQueueService');

describe('branch-user retry queue guard', () => {
  it('rejects queue persistence for credential-bearing branch-user requests', () => {
    expect(() => __test__.assertCredentialEndpointNotQueued(VSDC_ENDPOINTS.SAVE_BRANCH_USER))
      .toThrow(expect.objectContaining({
        code: 'EBM_BRANCH_USER_QUEUE_FORBIDDEN',
        statusCode: 422,
        retryable: false,
      }));
  });

  it('leaves non-credential-bearing endpoints eligible for existing queue behavior', () => {
    expect(() => __test__.assertCredentialEndpointNotQueued(VSDC_ENDPOINTS.SAVE_SALES)).not.toThrow();
  });
});

jest.mock('../services/posIdempotencyService', () => ({
  idempotentHandler: (handler) => handler,
}));

const { __test__ } = require('../routes/ebmRoutes');

describe('EBM sandbox-off route access', () => {
  it.each([
    ['GET', '/readiness'],
    ['GET', '/devices'],
    ['GET', '/codes'],
    ['POST', '/devices/initialize'],
    ['POST', '/codes/sync'],
    ['POST', '/branches/register'],
  ])('allows sandbox setup route %s %s', (method, path) => {
    expect(__test__.isSandboxSetupRoute({ method, path })).toBe(true);
  });

  it.each([
    ['GET', '/queue'],
    ['GET', '/queue/v2'],
    ['POST', '/queue/bulk-retry'],
    ['POST', '/purchases/sync'],
    ['POST', '/sales/sync'],
    ['POST', '/imports/sync'],
    ['POST', '/customers/verify-tin'],
  ])('keeps operational route gated %s %s', (method, path) => {
    expect(__test__.isSandboxSetupRoute({ method, path })).toBe(false);
  });
});

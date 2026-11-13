'use strict';

function findRoute(router, path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.filter((entry) => entry.method === method).map((entry) => entry.handle.name);
}

describe('customer financial mutations use the shared idempotency boundary', () => {
  test('loyalty adjustments use shared request replay before the mutation handler', () => {
    const router = require('../routes/customerMasterRoutes');
    const handlers = findRoute(router, '/:id/loyalty-adjustments', 'post');

    expect(handlers).toContain('guardedPosMutation');
    expect(handlers.indexOf('guardedPosMutation')).toBeGreaterThan(0);
  });

  test('client account edits reserve a shared key before cache and audit middleware', () => {
    const router = require('../routes/clientRoutes');
    const handlers = findRoute(router, '/:id', 'put');
    const guardIndex = handlers.indexOf('posIdempotencyMiddleware');

    expect(guardIndex).toBeGreaterThan(0);
    expect(handlers).toHaveLength(6);
    expect(guardIndex).toBeLessThan(handlers.length - 1);
  });
});

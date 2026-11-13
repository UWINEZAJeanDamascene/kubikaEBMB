'use strict';

const router = require('../routes/salesLegacyRoutes');

describe('POS offline sync route authentication', () => {
  test('push and pull use POS-session middleware before ERP authentication', () => {
    const protectIndex = router.stack.findIndex((layer) => layer.name === 'protect');
    const syncRoutes = router.stack.filter((layer) => (
      layer.route && ['/offline-sync/push', '/offline-sync/pull'].includes(layer.route.path)
    ));

    expect(protectIndex).toBeGreaterThanOrEqual(0);
    expect(syncRoutes).toHaveLength(2);
    const pushRoute = syncRoutes.find((layer) => layer.route.path === '/offline-sync/push');
    const pullRoute = syncRoutes.find((layer) => layer.route.path === '/offline-sync/pull');
    expect(router.stack.indexOf(pushRoute)).toBeLessThan(protectIndex);
    expect(router.stack.indexOf(pullRoute)).toBeLessThan(protectIndex);
    expect(pushRoute.route.stack).toHaveLength(3);
    expect(pushRoute.route.stack[1].name).toBe('offlineSyncDeviceAccess');
    expect(pullRoute.route.stack).toHaveLength(4);
  });
});

'use strict';

const { audit, ROUTERS } = require('../scripts/check-pos-route-security');

describe('POS route security inventory', () => {
  const routes = audit();

  test('scans every configured POS, till, sales, credit-note, payment-settings, and print-agent router', () => {
    expect(ROUTERS.map(({ file }) => file)).toEqual(expect.arrayContaining([
      'routes/posRoutes.js',
      'routes/tillRoutes.js',
      'routes/salesLegacyRoutes.js',
      'routes/creditNoteRoutes.js',
      'routes/posPaymentSettingsRoutes.js',
      'routes/posPrintAgentRoutes.js',
    ]));
    expect(routes.length).toBeGreaterThan(100);
  });

  test('every declared route has an authentication and authorization boundary', () => {
    const uncovered = routes.filter((route) => (
      route.authentication === 'MISSING'
      || route.authorization === 'MISSING'
      || route.finding === 'DUPLICATE_ROUTE_DECLARATION'
    ));
    expect(uncovered).toEqual([]);
  });

  test('POS audit and security endpoints use distinct least-privilege capabilities', () => {
    const expected = {
      'GET /api/pos/admin/audit': 'canReadPosAudit',
      'GET /api/pos/admin/audit/export.csv': 'canExportPosAudit',
      'GET /api/pos/admin/security/settings': 'canReadPosSecurity',
      'PUT /api/pos/admin/security/settings': 'canUpdatePosSecurity',
      'GET /api/pos/admin/security/sessions': 'canReadPosSecuritySessions',
      'POST /api/pos/admin/security/sessions/:sessionId/revoke': 'canRevokePosSecuritySessions',
      'GET /api/pos/admin/security/audit-integrity': 'canVerifyPosAudit',
      'GET /api/pos/admin/security/duplicate-attempts': 'canReadPosSecurity',
      'GET /api/pos/admin/security/risk-report': 'canReadPosSecurity',
    };
    for (const [key, middlewareName] of Object.entries(expected)) {
      expect(routes.find((route) => route.key === key)?.middleware).toContain(middlewareName);
    }
  });

  test('every declared mutation has shared idempotency or an explicitly documented native boundary', () => {
    const mutationsWithoutReplayBoundary = routes.filter((route) => (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
      && route.idempotency === 'MISSING'
    ));
    expect(mutationsWithoutReplayBoundary).toEqual([]);
    expect(routes.filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)).length).toBeGreaterThan(50);
  });

  test('journal-producing till mutations are guarded by the shared request/result record', () => {
    const journalBackedMutations = [
      'POST /api/pos/payments-v2/direct-sale',
      'POST /api/pos/payments-v2/sales/:saleId/complete',
      'POST /api/pos/payments/sales/:saleId/payments',
      'POST /api/pos/payments/refunds',
      'POST /api/pos/cheques/deposits',
      'POST /api/pos/cheques/:chequeId/bounce',
      'PUT /api/pos/credit-accounts/:clientId',
      'POST /api/pos/credit-accounts/:clientId/payments',
      'POST /api/pos/credit-accounts/payments/:receiptId/refund',
      'POST /api/pos/credit-accounts/:clientId/adjustments',
      'POST /api/pos/credit-accounts/:clientId/write-offs',
      'POST /api/pos/payments/gift-cards/issue',
      'POST /api/sales-legacy/stored-value/issue',
      'POST /api/sales-legacy/direct-sale',
      'POST /api/credit-notes',
      'POST /api/credit-notes/:id/confirm',
      'POST /api/credit-notes/:id/refund',
    ];

    for (const key of journalBackedMutations) {
      expect(routes.find((route) => route.key === key)?.idempotency).toBe('SHARED_IDEMPOTENCY');
    }
  });

  test('every POS route inherits a request cap and credential endpoints have tighter limits', () => {
    const withoutRateLimit = routes.filter((route) => (
      route.rateLimit === 'NO_ROUTE_RATE_LIMIT'
      || route.rateLimit === 'LOCAL_LOCKOUT_ONLY_NO_REQUEST_LIMIT'
    ));
    expect(withoutRateLimit).toEqual([]);

    for (const key of [
      'POST /api/pos/auth/pin-login',
      'POST /api/pos/auth/offline-attempts',
      'POST /api/pos/auth/unlock',
      'POST /api/pos/auth/switch',
    ]) {
      expect(routes.find((route) => route.key === key)?.rateLimit).toBe('STRICT_CREDENTIAL_LIMIT');
    }
    expect(routes.find((route) => route.key === 'POST /api/pos/print-agent/pair')?.rateLimit)
      .toBe('STRICT_PAIRING_LIMIT');
  });

  test('read-only cashier-session routes do not require a mutation idempotency key', () => {
    const readsWithMutationBoundary = routes.filter((route) => (
      ['GET', 'HEAD'].includes(route.method)
      && route.idempotency !== 'READ_ONLY'
    ));
    expect(readsWithMutationBoundary).toEqual([]);

    for (const key of [
      'GET /api/tills/active',
      'GET /api/tills/shifts',
      'GET /api/tills/shifts/:tillSessionId/z-report',
      'GET /api/tills/checkout-requests/:requestKey',
    ]) {
      expect(routes.find((route) => route.key === key)).toMatchObject({
        authentication: 'POS_SESSION',
        authorization: 'ROUTE_PERMISSION',
        idempotency: 'READ_ONLY',
      });
    }
  });

  test('till operations and sale/payment writes require a bound cashier session', () => {
    const tillOperations = routes.filter((route) => route.path.startsWith('/api/tills/')
      && !/\/(registers|devices)(\/|$)/.test(route.path)
      && !route.path.startsWith('/api/tills/manager-')
      && route.path !== '/api/tills/shifts/:tillSessionId');
    expect(tillOperations.length).toBeGreaterThan(5);
    expect(tillOperations.filter((route) => route.authentication !== 'POS_SESSION')).toEqual([]);
    expect(tillOperations.filter((route) => !/bindSessionIdentity|\.\.\.posSession(?:Read)?\(/.test(route.middleware))).toEqual([]);

    for (const key of [
      'POST /api/sales-legacy/direct-sale',
      'POST /api/pos/payments-v2/direct-sale',
      'POST /api/pos/payments-v2/sales/:saleId/complete',
      'POST /api/pos/shifts/open',
      'POST /api/pos/shifts/:shiftId/close',
      'POST /api/pos/shifts/:shiftId/cash-movements',
    ]) {
      expect(routes.find((route) => route.key === key)).toMatchObject({
        tenantScope: 'POS_SESSION_COMPANY_BOUND',
        registerScope: 'POS_SESSION_REGISTER_BOUND',
      });
      expect(routes.find((route) => route.key === key)?.authentication).toContain('POS_SESSION');
    }
  });

  test('legacy routes distinguish ERP plus POS-session gates from single-auth routes', () => {
    expect(routes.find((route) => route.key === 'POST /api/sales-legacy/direct-sale')).toMatchObject({
      authentication: 'ERP_SESSION+POS_SESSION',
      authorization: 'ROUTE_PERMISSION',
      handler: 'createDirectSale',
    });
    expect(routes.find((route) => route.key === 'GET /api/sales-legacy/receipt/:invoiceId')?.authentication)
      .toBe('ERP_SESSION');
    expect(routes.find((route) => route.key === 'POST /api/sales-legacy/offline-sync/push')?.authentication)
      .toBe('POS_SESSION+DEVICE_OR_PROTOCOL');
    // Credit-note routes select ERP permission or POS cashier identity inside
    // controller middleware according to posOrigin; the scanner reports the
    // inherited ERP boundary and the route test documents this dynamic gate.
    expect(routes.find((route) => route.key === 'POST /api/credit-notes')?.authentication)
      .toBe('ERP_SESSION');
    expect(routes.find((route) => route.key === 'POST /api/credit-notes')?.middleware)
      .toContain('authorizeCreditNoteDraft');
  });

  test('offline protocol routes require device identity and cashier authorization before sync', () => {
    for (const key of [
      'POST /api/sales-legacy/offline-sync/push',
      'GET /api/sales-legacy/offline-sync/device-state',
      'POST /api/sales-legacy/offline-sync/device-state/wipe-ack',
      'GET /api/sales-legacy/offline-sync/pull',
    ]) {
      const route = routes.find((entry) => entry.key === key);
      expect(route).toBeDefined();
      expect(route.authentication).not.toBe('MISSING');
      expect(route.authorization).not.toBe('MISSING');
      expect(route.rateLimit).toBe('ROUTE_RATE_LIMITED');
    }
  });

  test('provider webhook and offline/device admin routes have explicit protocol or ERP gates and replay boundaries', () => {
    const keys = [
      'POST /api/pos/payments-v2/provider-webhooks/:provider/:companyId',
      'POST /api/sales-legacy/offline-sync/push',
      'GET /api/sales-legacy/offline-sync/device-state',
      'POST /api/sales-legacy/offline-sync/device-state/wipe-ack',
      'GET /api/sales-legacy/offline-sync/pull',
      'GET /api/pos/admin/offline-exceptions',
      'POST /api/pos/admin/offline-exceptions/:exceptionId/resolve',
      'GET /api/pos/admin/offline-monitoring',
    ];
    for (const key of keys) {
      const route = routes.find((entry) => entry.key === key);
      expect(route).toBeDefined();
      expect(route.authentication).not.toBe('MISSING');
      expect(route.authorization).not.toBe('MISSING');
      expect(route.rateLimit).toBe('ROUTE_RATE_LIMITED');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
        expect(route.idempotency).not.toBe('MISSING');
      }
    }
    expect(routes.find((entry) => entry.key === keys[0])).toMatchObject({
      authorization: 'ACTION_GATED',
      idempotency: 'NATIVE_BOUNDARY',
    });
    expect(routes.find((entry) => entry.key === keys[1]).authentication)
      .toBe('POS_SESSION+DEVICE_OR_PROTOCOL');
    expect(routes.find((entry) => entry.key === keys[4])).toMatchObject({
      authentication: 'POS_SESSION+DEVICE_OR_PROTOCOL',
      authorization: 'ROUTE_PERMISSION',
    });
    expect(routes.find((entry) => entry.key === keys[6]).authentication).toBe('ERP_SESSION');
  });
});

'use strict';

jest.mock('../middleware/auth', () => ({ protect: (req, res, next) => next() }));
jest.mock('../middleware/rbacMiddleware', () => ({
  requirePermissionOrRoles: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../controllers/tillController', () => {
  const handler = (req, res) => res.json({ reached: true });
  return {
    openTill: handler, closeTill: handler, recordNoSale: handler, managerCloseTill: handler,
    getActiveTill: handler, getTillShifts: handler, deleteEmptyTillShift: handler,
  };
});
jest.mock('../controllers/posCheckoutSupportController', () => ({
  getCheckoutRequest: (req, res) => res.json({ reached: true }),
  recoverCheckoutRequest: (req, res) => res.json({ reached: true }),
}));
jest.mock('../controllers/tillZReportController', () => ({ getTillZReport: (req, res) => res.json({ reached: true }) }));
jest.mock('../controllers/posManagerApprovalController', () => ({
  createApproval: (req, res) => res.json({ reached: true }),
  listApprovals: (req, res) => res.json({ reached: true }),
}));
jest.mock('../controllers/posRegisterController', () => new Proxy({}, { get: () => (req, res) => res.json({ reached: true }) }));

const express = require('express');
const request = require('supertest');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const tillRoutes = require('../routes/tillRoutes');

function appWithTillRoutes() {
  const app = express();
  app.use(express.json());
  app.use('/api/tills', tillRoutes);
  return app;
}

describe('legacy till operational routes require a POS session', () => {
  const erpOnly = { Authorization: 'Bearer an-erp-access-token' };
  const cases = [
    ['post', '/api/tills/open'],
    ['post', '/api/tills/close'],
    ['post', '/api/tills/no-sale'],
    ['get', '/api/tills/active'],
    ['get', '/api/tills/shifts'],
    ['get', '/api/tills/shifts/507f1f77bcf86cd799439011/z-report'],
    ['get', '/api/tills/checkout-requests/abcdefghijklmnop'],
    ['post', '/api/tills/checkout-requests/abcdefghijklmnop/recover'],
    ['post', '/api/tills/manager-approvals'],
  ];

  test.each(cases)('%s %s rejects ERP authentication without a device/session token', async (method, url) => {
    const response = await request(appWithTillRoutes())[method](url).set(erpOnly).send({});
    expect(response.status).toBe(401);
    expect(response.body.code).toMatch(/^POS_SESSION_/);
    expect(response.body.reached).toBeUndefined();
  });

  test('register administration remains an ERP-authenticated management route', async () => {
    const response = await request(appWithTillRoutes()).get('/api/tills/registers').set(erpOnly);
    expect(response.status).toBe(200);
    expect(response.body.reached).toBe(true);
  });

  test('cashiers can resolve the register assigned to this device', async () => {
    expect(requirePermissionOrRoles).toHaveBeenCalledWith(
      'tills',
      'read',
      ['admin', 'accountant', 'manager', 'sales', 'viewer', 'cashier'],
    );
    const response = await request(appWithTillRoutes())
      .get('/api/tills/registers/device/77777777-7777-4777-8777-777777777777')
      .set(erpOnly);

    expect(response.status).toBe(200);
    expect(response.body.reached).toBe(true);
  });

  test('POS device security routes retain the built-in admin role fallback', () => {
    const adminRoles = ['admin', 'manager', 'store_manager', 'owner', 'platform_admin', 'super_admin'];
    expect(requirePermissionOrRoles).toHaveBeenCalledWith(
      'pos.admin.security.sessions',
      'read',
      adminRoles,
    );
    expect(requirePermissionOrRoles).toHaveBeenCalledWith(
      'pos.admin.security.sessions',
      'revoke',
      adminRoles,
    );
  });
});

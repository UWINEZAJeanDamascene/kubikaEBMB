jest.mock('../controllers/ebmController', () => new Proxy({}, {
  get: () => jest.fn(),
}));
jest.mock('../controllers/clientController', () => new Proxy({}, {
  get: () => jest.fn(),
}));
jest.mock('../controllers/invoiceController', () => new Proxy({}, {
  get: () => jest.fn(),
}));
jest.mock('../middleware/auth', () => ({ protect: (_req, _res, next) => next() }));
jest.mock('../middleware/companyContext', () => ({ attachCompanyId: (_req, _res, next) => next() }));
jest.mock('../middleware/rbacMiddleware', () => ({
  requirePermission: (resource, action) => {
    const middleware = (_req, _res, next) => next();
    middleware.policy = { resource, action };
    return middleware;
  },
  requirePermissionOrRoles: (resource, action, allowedRoles = []) => {
    const middleware = (_req, _res, next) => next();
    middleware.policy = { resource, action, allowedRoles };
    return middleware;
  },
}));

const router = require('../routes/ebmRoutes');
const clientRouter = require('../routes/clientRoutes');
const invoiceRouter = require('../routes/invoiceRoutes');

function routePolicies(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer) throw new Error(`Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.map((entry) => entry.handle.policy).filter(Boolean);
}

describe('EBM lookup route permissions', () => {
  it('requires invoice update permission for fiscal sales submission', () => {
    expect(routePoliciesFrom(invoiceRouter, '/:id/ebm/submit', 'post')).toContainEqual({
      resource: 'sales_invoices', action: 'update',
    });
  });

  it('separates cached reads, manual sync, and live customer verification privileges', () => {
    expect(routePolicies('/codes', 'get')).toContainEqual({
      resource: 'ebm',
      action: 'read',
      allowedRoles: ['admin', 'stock_manager'],
    });
    expect(routePolicies('/codes/sync', 'post')).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin'],
    });
    expect(routePolicies('/customers/verify-tin', 'post')).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin', 'stock_manager', 'sales'],
    });
  });

  it.each([
    ['/branches/register', router],
    ['/branches/insurance/submit', router],
  ])('requires EBM update permission for %s', (path, routeRouter) => {
    expect(routePoliciesFrom(routeRouter, path, 'post')).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin', 'stock_manager'],
    });
  });

  it('requires both client update and EBM update permission for branch customer submission', () => {
    expect(routePoliciesFrom(clientRouter, '/:id/ebm/branch-customer', 'post')).toEqual(expect.arrayContaining([
      { resource: 'clients', action: 'update' },
      { resource: 'ebm', action: 'update', allowedRoles: ['admin', 'stock_manager'] },
    ]));
    expect(routePoliciesFrom(clientRouter, '/:id/ebm/branch-customer/status', 'get')).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin', 'stock_manager'],
    });
  });

  it('requires EBM update permission to read branch-insurance diagnostics', () => {
    expect(routePoliciesFrom(router, '/branches/insurance/status', 'get')).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin', 'stock_manager'],
    });
  });

  it.each([
    ['/stock/reconcile', 'post'],
    ['/stock/reconcile/resubmit', 'post'],
  ])('requires EBM update permission for stock reconciliation action %s', (path, method) => {
    expect(routePolicies(path, method)).toContainEqual({
      resource: 'ebm', action: 'update', allowedRoles: ['admin', 'stock_manager'],
    });
  });

  it.each([
    ['/', 'post'],
    ['/:id', 'put'],
  ])('conditionally requires EBM update permission for branch-customer auto-submission on %s %s', (path, method) => {
    expect(routePoliciesFrom(clientRouter, path, method)).toContainEqual({
      resource: 'ebm',
      action: 'update',
      allowedRoles: ['admin', 'stock_manager'],
    });
  });
});

function routePoliciesFrom(targetRouter, path, method) {
  const layer = targetRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer) throw new Error(`Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack
    .map((entry) => entry.handle.policy || entry.handle.conditionalPermission)
    .filter(Boolean);
}

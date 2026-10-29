jest.mock('../controllers/backupController', () => new Proxy({}, {
  get: () => jest.fn(),
}));
jest.mock('../controllers/companyController', () => new Proxy({}, {
  get: () => jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  protect: (_req, _res, next) => next(),
  authorize: (...roles) => {
    const middleware = (_req, _res, next) => next();
    middleware.rolePolicy = roles;
    return middleware;
  },
}));
jest.mock('../middleware/rbacMiddleware', () => ({
  requirePermissionOrRoles: (resource, action, allowedRoles = []) => {
    const middleware = (_req, _res, next) => next();
    middleware.policy = { resource, action, allowedRoles };
    return middleware;
  },
}));
jest.mock('../middleware/upload', () => ({
  uploadFor: () => ({ single: () => (_req, _res, next) => next() }),
}));
jest.mock('../middleware/companyContext', () => ({
  attachCompanyId: (_req, _res, next) => next(),
}));
jest.mock('../middleware/validateRequest', () => (_req, _res, next) => next());
jest.mock('../middleware/stripUnvalidatedBody', () => (_req, _res, next) => next());

const backupRouter = require('../routes/backupRoutes');
const companyRouter = require('../routes/companyRoutes');

function routeHandlers(router, path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.map((entry) => entry.handle);
}

describe('System Control backend permissions', () => {
  it.each(['/', '/stats', '/points-in-time', '/snapshots', '/settings', '/:id'])(
    'requires settings read access for backup endpoint GET %s',
    (path) => {
      const policies = routeHandlers(backupRouter, path, 'get')
        .map((handler) => handler.policy)
        .filter(Boolean);

      expect(policies).toContainEqual({
        resource: 'settings',
        action: 'read',
        allowedRoles: ['admin'],
      });
    },
  );

  it('requires settings update access to change the current company profile', () => {
    const policies = routeHandlers(companyRouter, '/me', 'put')
      .map((handler) => handler.policy)
      .filter(Boolean);

    expect(policies).toContainEqual({
      resource: 'settings',
      action: 'update',
      allowedRoles: ['admin'],
    });
  });
});

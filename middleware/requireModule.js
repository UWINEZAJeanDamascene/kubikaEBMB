const moduleEntitlementService = require('../services/moduleEntitlementService');
const ebmService = require('../services/ebmService');

function requireModule(moduleCode, { allowSandboxWhenOff = false } = {}) {
  return async function moduleGate(req, res, next) {
    const companyId = req.companyId
      || req.company?._id
      || req.company?.id
      || req.user?.company?._id
      || req.user?.company?.id
      || req.user?.company;
    if (!companyId) {
      return res.status(404).json({
        success: false,
        code: 'MODULE_NOT_FOUND',
        message: 'The requested module is not available.',
      });
    }

    try {
      const enabled = await moduleEntitlementService.hasModule(companyId, moduleCode);
      const sandboxOverrideRequested = typeof allowSandboxWhenOff === 'function'
        ? allowSandboxWhenOff(req) === true
        : allowSandboxWhenOff === true;
      if (!enabled && !(sandboxOverrideRequested && moduleCode === 'fiscal.ebm' && ebmService.isSandboxMode())) {
        return res.status(404).json({
          success: false,
          code: 'MODULE_NOT_FOUND',
          message: 'The requested module is not available.',
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = requireModule;

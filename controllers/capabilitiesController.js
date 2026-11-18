const moduleEntitlementService = require('../services/moduleEntitlementService');

exports.getEffectiveCapabilities = async (req, res, next) => {
  try {
    const capabilities = await moduleEntitlementService.getEffectiveCapabilities(req.companyId);
    return res.json({ success: true, data: capabilities });
  } catch (error) {
    return next(error);
  }
};

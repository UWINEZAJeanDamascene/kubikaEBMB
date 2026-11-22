'use strict';

const service = require('../services/posRestaurantBillingSettingsService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || req.companyId || '');
}

exports.getSettings = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await service.getSettings(companyIdFor(req)) });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    return next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const saved = await service.saveSettings(
      companyIdFor(req),
      req.user?.id || req.user?._id,
      req.body,
      req,
    );
    return res.json({ success: true, data: saved });
  } catch (error) {
    if (error.statusCode || error.code?.startsWith('RESTAURANT_BILLING_')) {
      return res.status(error.statusCode || 400).json({
        success: false,
        code: error.code,
        message: error.message,
        validationErrors: error.validationErrors || [],
      });
    }
    return next(error);
  }
};

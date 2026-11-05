'use strict';

const posAccountingProfileService = require('../services/posAccountingProfileService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || req.companyId || '');
}

exports.getProfile = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        code: 'COMPANY_REQUIRED',
        message: 'Select a company before loading POS accounting settings.',
      });
    }
    return res.json({ success: true, data: await posAccountingProfileService.getProfile(companyId) });
  } catch (error) {
    return next(error);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        code: 'COMPANY_REQUIRED',
        message: 'Select a company before saving POS accounting settings.',
      });
    }
    const data = await posAccountingProfileService.saveProfile(
      companyId,
      req.user?.id || req.user?._id,
      req.body,
    );
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return res.status(400).json({
        success: false,
        code: error.code || 'POS_ACCOUNTING_PROFILE_INVALID',
        message: error.message,
        validationErrors: error.validationErrors || [],
      });
    }
    return next(error);
  }
};

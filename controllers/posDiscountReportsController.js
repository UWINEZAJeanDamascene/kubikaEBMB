'use strict';

const { getPosDiscountReports } = require('../services/posDiscountReportsService');

function companyIdFrom(req) {
  return String(req.user?.company?._id || req.user?.company?.id || req.user?.companyId || '');
}

exports.getReports = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        code: 'COMPANY_REQUIRED',
        message: 'Select a company before viewing POS reports.',
      });
    }
    const data = await getPosDiscountReports(companyId, req.query || {});
    return res.json({ success: true, data });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'POS_REPORT_FAILED',
        message: error.message,
      });
    }
    return next(error);
  }
};

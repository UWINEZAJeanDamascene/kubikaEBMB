'use strict';

const tipService = require('../services/posRestaurantTipService');

function action(statusCode, operation) {
  return async (req, res, next) => {
    try {
      const data = await operation(req);
      return res.status(statusCode).json({ success: true, data });
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code || 'RESTAURANT_TIP_ERROR',
          message: error.message,
        });
      }
      if (error?.code === 'P2002') {
        return res.status(409).json({
          success: false,
          code: 'POS_IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used. Refresh before retrying.',
        });
      }
      return next(error);
    }
  };
}

exports.captureCashTip = action(201, (req) => (
  tipService.captureCashTip(req, req.params.billId)
));

exports.getCaptureSettings = action(200, (req) => (
  tipService.getCaptureSettings(req)
));

exports.listWaiterTipBalances = action(200, (req) => (
  tipService.listWaiterTipBalances(req)
));

exports.payWaiterTips = action(201, (req) => (
  tipService.payWaiterTips(req)
));

exports.reverseCashTip = action(201, (req) => (
  tipService.reverseCashTip(req, req.params.tipId)
));

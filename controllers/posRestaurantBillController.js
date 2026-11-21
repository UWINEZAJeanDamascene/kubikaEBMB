'use strict';

const billService = require('../services/posRestaurantBillService');

function companyIdFor(req) {
  return String(req.posAuthContext?.company?.id || '');
}

function action(statusCode, operation) {
  return async (req, res, next) => {
    try {
      const data = await operation(req, companyIdFor(req));
      return res.status(statusCode).json({ success: true, data });
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code || 'RESTAURANT_BILL_ERROR',
          message: error.message,
        });
      }
      if (error?.code === 'P2002') {
        return res.status(409).json({
          success: false,
          code: 'RESTAURANT_BILL_CONFLICT',
          message: 'This Restaurant bill changed while you were working. Refresh and try again.',
        });
      }
      return next(error);
    }
  };
}

exports.getOrderBill = action(200, (req, companyId) => (
  billService.getBill(companyId, req.params.orderId, req)
));

exports.issueOrderBill = action(201, (req, companyId) => (
  billService.issueBill(companyId, req.params.orderId, req)
));

exports.settleBill = action(200, (req, companyId) => (
  billService.settleBill(companyId, req.params.billId, req)
));

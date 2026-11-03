const { randomBytes } = require('crypto');
const { prisma, dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { consumeApproval, hashPayload } = require('./posManagerApprovalController');

const VALID_REQUEST_KEY = /^[a-zA-Z0-9_-]{16,100}$/;

function companyAndUser(req) {
  return {
    companyId: String(req.user.company?._id || req.user.companyId || ''),
    userId: String(req.user.id || req.user._id || ''),
  };
}

exports.getCheckoutRequest = async (req, res, next) => {
  try {
    const { companyId } = companyAndUser(req);
    const cashierId = String(req.posAuthContext?.session.userId || req.user?.id || req.user?._id || '');
    const requestKey = String(req.params.requestKey || '').trim();
    if (!VALID_REQUEST_KEY.test(requestKey)) {
      return res.status(400).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_INVALID', message: 'Checkout request key is invalid.' });
    }
    const rows = await dbClient().$queryRawUnsafe(
      'SELECT r.request_key, r.created_by_id, u.name AS cashier_name, r.status, r.created_at, r.invoice_id, i.reference_no, i.customer_name, i.total_amount, i.status AS invoice_status, i.invoice_date FROM pos_sale_requests r LEFT JOIN users u ON u.id = r.created_by_id AND u.company_id = r.company_id LEFT JOIN invoices i ON i.id = r.invoice_id AND i.company_id = r.company_id WHERE r.company_id = $1 AND r.request_key = $2 AND r.created_by_id = $3 LIMIT 1',
      companyId, requestKey, cashierId,
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ success: false, code: 'POS_CHECKOUT_REQUEST_NOT_FOUND', message: 'No server checkout record exists for this key.' });
    return res.json({
      success: true,
      data: {
        requestKey: row.request_key,
        cashierId: String(row.created_by_id).trim(),
        cashierName: row.cashier_name || 'Cashier',
        status: row.status,
        createdAt: row.created_at,
        invoice: row.invoice_id && row.reference_no ? {
          id: String(row.invoice_id).trim(),
          referenceNo: row.reference_no,
          customerName: row.customer_name,
          totalAmount: Number(row.total_amount) || 0,
          status: row.invoice_status,
          invoiceDate: row.invoice_date,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.recoverCheckoutRequest = async (req, res, next) => {
  try {
    const { companyId, userId } = companyAndUser(req);
    if (req.posAuthContext && String(req.posAuthContext.session.userId) !== userId) {
      return res.status(403).json({ success: false, code: 'POS_SESSION_IDENTITY_MISMATCH', message: 'Sign in to this till again.' });
    }
    const requestKey = String(req.params.requestKey || '').trim();
    const requestData = req.body.requestData;
    const shouldSendEmail = req.body.shouldSendEmail === true;
    const linkedInvoiceId = String(req.body.linkedInvoiceId || '');
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const confirmedNoMatchingSale = req.body.confirmedNoMatchingSale === true;
    if (!VALID_REQUEST_KEY.test(requestKey) || !requestData || typeof requestData !== 'object' || Array.isArray(requestData)
      || !/^[a-f\d]{24}$/i.test(linkedInvoiceId) || reason.length < 10 || !confirmedNoMatchingSale) {
      return res.status(400).json({ success: false, code: 'POS_CHECKOUT_RECOVERY_CONFIRMATION_REQUIRED', message: 'A linked invoice, explicit duplicate-sale check, and a reason of at least 10 characters are required.' });
    }

    const approvalPayload = {
      requestKey,
      requestData,
      shouldSendEmail,
      linkedInvoiceId,
      reason,
      confirmedNoMatchingSale: true,
    };
    const pendingPayloadHash = hashPayload(requestData);
    const result = await runInTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        'SELECT request_key, created_by_id, payload_hash, invoice_id, status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2 FOR UPDATE',
        companyId, requestKey,
      );
      const existing = rows[0];
      if (!existing) {
        const error = new Error('The conflicting checkout key no longer exists. Retry the original saved sale once to re-check its state.');
        error.statusCode = 409;
        error.code = 'POS_CHECKOUT_REQUEST_NOT_FOUND';
        throw error;
      }
      if (String(existing.created_by_id).trim() !== userId) {
        const error = new Error('Only the cashier who started this checkout can request its recovery.');
        error.statusCode = 403;
        error.code = 'POS_CHECKOUT_RECOVERY_CASHIER_MISMATCH';
        throw error;
      }
      const sameCashier = String(existing.created_by_id).trim() === userId;
      if (sameCashier && existing.payload_hash === pendingPayloadHash) {
        const error = new Error('This saved checkout matches the server request. Retry the saved sale with its original key; no replacement key is needed.');
        error.statusCode = 409;
        error.code = 'POS_CHECKOUT_RECOVERY_NOT_NEEDED';
        throw error;
      }
      if (existing.status !== 'completed' || !existing.invoice_id) {
        const error = new Error('The conflicting request has no linked completed invoice. It cannot be safely re-keyed automatically. Contact your POS administrator with this request key.');
        error.statusCode = 409;
        error.code = 'POS_CHECKOUT_RECOVERY_UNSAFE';
        throw error;
      }
      const invoiceRows = await tx.$queryRawUnsafe(
        'SELECT id, reference_no FROM invoices WHERE id = $1 AND company_id = $2 LIMIT 1',
        String(existing.invoice_id).trim(), companyId,
      );
      const originalInvoice = invoiceRows[0];
      if (!originalInvoice || String(originalInvoice.id).trim() !== linkedInvoiceId) {
        const error = new Error('The linked invoice changed after review. Refresh the checkout request and verify the invoice again.');
        error.statusCode = 409;
        error.code = 'POS_CHECKOUT_RECOVERY_INVOICE_CHANGED';
        throw error;
      }

      const managerRows = await tx.$queryRawUnsafe(
        'SELECT manager_id FROM pos_manager_approvals WHERE id = $1 AND company_id = $2',
        String(req.body.approvalId || ''), companyId,
      );
      const approvedById = managerRows[0]?.manager_id ? String(managerRows[0].manager_id).trim() : null;
      await consumeApproval({
        approvalId: req.body.approvalId,
        companyId,
        cashierId: userId,
        action: 'checkout_recovery',
        subjectId: null,
        payload: approvalPayload,
      });

      const replacementRequestKey = randomBytes(24).toString('hex');
      const auditId = randomBytes(12).toString('hex');
      await tx.$executeRawUnsafe(
        'INSERT INTO pos_sale_request_recoveries (id, company_id, original_request_key, replacement_request_key, pending_payload_hash, original_payload_hash, original_invoice_id, initiated_by_id, approved_by_id, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)',
        auditId, companyId, requestKey, replacementRequestKey, pendingPayloadHash, existing.payload_hash,
        String(existing.invoice_id).trim(), userId, approvedById, reason,
      );
      return { replacementRequestKey, originalInvoiceId: String(existing.invoice_id).trim(), originalInvoiceReference: originalInvoice.reference_no };
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    next(error);
  }
};

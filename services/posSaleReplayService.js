'use strict';

const Invoice = require('../models/Invoice');
const { dbClient } = require('../lib/prisma');

/** Return the stored response when an idempotency key has already been used. */
async function replayPosSale({ companyId, requestKey, payloadHash, cashierId, body }) {
  if (!requestKey) return { handled: false };
  const rows = await dbClient().$queryRawUnsafe(
    'SELECT request_key AS "requestKey", created_by_id AS "createdById", payload_hash AS "payloadHash", invoice_id AS "invoiceId", status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2 LIMIT 1',
    String(companyId), requestKey,
  );
  const record = rows[0];
  if (!record) return { handled: false };
  if (String(record.createdById) !== String(cashierId) || record.payloadHash !== payloadHash) {
    return { handled: true, status: 409, body: {
      success: false,
      code: 'POS_IDEMPOTENCY_KEY_CONFLICT',
      message: 'This checkout key was already used for a different sale. Resolve the previous attempt before starting another.',
    } };
  }
  if (record.status !== 'completed' || !record.invoiceId) {
    return { handled: true, status: 409, body: {
      success: false,
      code: 'POS_SALE_STILL_PROCESSING',
      message: 'This sale is still being resolved. Retry the same checkout shortly; do not start a new sale yet.',
    } };
  }

  const invoice = await Invoice.findOne({ _id: record.invoiceId, company: companyId })
    .populate('client lines.product createdBy');
  if (!invoice) {
    return { handled: true, status: 409, body: {
      success: false,
      code: 'POS_IDEMPOTENT_SALE_UNAVAILABLE',
      message: 'The previous checkout was recorded, but its invoice is unavailable. Contact an administrator before retrying.',
    } };
  }

  const payments = Array.isArray(body?.payments) ? body.payments : [];
  const tendered = payments.length
    ? payments.reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0)
    : Number(body?.paymentAmount) || 0;
  const total = Number(invoice.grandTotal ?? invoice.totalAmount) || 0;
  const cashTendered = payments.length
    ? payments.filter((payment) => payment?.paymentMethod === 'cash')
      .reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0)
    : body?.paymentMethod === 'cash' ? tendered : 0;
  const changeDue = cashTendered >= Math.max(0, tendered - total) ? Math.max(0, tendered - total) : 0;
  return { handled: true, status: 200, body: {
    success: true,
    message: 'This checkout was already completed.',
    data: invoice,
    changeDue,
    replayed: true,
  } };
}

module.exports = { replayPosSale };

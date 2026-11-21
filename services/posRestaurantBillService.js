'use strict';

const { dbClient, prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const posOrderService = require('./posRestaurantOrderService');
const posPaymentService = require('./posPaymentService');
const posPaymentsV2Controller = require('../controllers/posPaymentsV2Controller');
const { roundMoney } = require('./posCheckoutCoreService');

const ID_PATTERN = /^[a-f0-9]{24}$/i;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const PAYMENT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const MOBILE_MONEY_METHODS = new Set(['MTN_MOMO', 'AIRTEL_MONEY']);
const BILL_PAYMENT_METHODS = new Set([
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'GIFT_CARD',
  'STORE_CREDIT',
  'MTN_MOMO',
  'AIRTEL_MONEY',
]);
const UNRESOLVED_PAYMENT_STATUSES = new Set(['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS']);

function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredId(value, label) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw fail('RESTAURANT_BILL_INVALID', `Choose a valid ${label}.`);
  return id;
}

function companyIdFor(req) {
  const companyId = String(req.posAuthContext?.company?.id || '').trim();
  if (!ID_PATTERN.test(companyId)) throw fail('RESTAURANT_COMPANY_REQUIRED', 'A valid company context is required.', 401);
  return companyId;
}

function actorFor(req) {
  const context = req.posAuthContext;
  const userId = String(context?.session?.userId || '').trim();
  const registerId = String(context?.register?.id || context?.session?.registerId || '').trim();
  if (!ID_PATTERN.test(userId) || !ID_PATTERN.test(registerId)) {
    throw fail('RESTAURANT_POS_SESSION_REQUIRED', 'An active Restaurant POS session is required.', 401);
  }
  return {
    userId,
    registerId,
    registerCode: String(context?.register?.code || ''),
    registerName: String(context?.register?.name || ''),
    branchId: String(context?.register?.branchId || ''),
    systemTillType: String(context?.register?.systemTillType || 'restaurant'),
    trainingMode: Boolean(context?.register?.trainingMode),
  };
}

function idempotencyKeyFor(req) {
  const key = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
  if (!REQUEST_KEY_PATTERN.test(key)) {
    throw fail('POS_IDEMPOTENCY_KEY_INVALID', 'Provide a valid Idempotency-Key before issuing or paying this bill.', 400);
  }
  return key;
}

function responseCapture() {
  let statusCode = 200;
  let body;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
    get result() {
      return { statusCode, body };
    },
  };
}

function internalRequest(req, { body, params, key, restaurantCheckout } = {}) {
  const request = {
    ...req,
    body: body || {},
    params: { ...(req.params || {}), ...(params || {}) },
    headers: { ...(req.headers || {}), 'idempotency-key': key },
    get(name) {
      if (String(name).toLowerCase() === 'idempotency-key') return key;
      return req.get?.(name);
    },
  };
  if (restaurantCheckout) request.posRestaurantCheckout = restaurantCheckout;
  return request;
}

async function invokeController(controller, req) {
  const response = responseCapture();
  let nextError = null;
  await controller(req, response, (error) => { nextError = error || null; });
  if (nextError) throw nextError;
  const result = response.result;
  if (!result.body) throw fail('RESTAURANT_POS_CHECKOUT_EMPTY', 'The shared POS checkout returned no result.', 502);
  if (result.statusCode >= 400 || result.body.success === false) {
    throw fail(
      result.body.code || 'RESTAURANT_POS_CHECKOUT_FAILED',
      result.body.message || 'The shared POS checkout could not be completed.',
      result.statusCode >= 400 ? result.statusCode : 409,
    );
  }
  return result.body;
}

async function findBillByOrder(companyId, orderId) {
  const rows = await dbClient().$queryRawUnsafe(
    'SELECT id, company_id AS "companyId", order_id AS "orderId", invoice_id AS "invoiceId", version, status, split_type AS "splitType", subtotal::text AS subtotal, tax_amount::text AS "taxAmount", total_amount::text AS "totalAmount", line_snapshot AS "lineSnapshot", payer_allocations AS "payerAllocations", created_by_id AS "createdById", created_at AS "createdAt", updated_at AS "updatedAt" FROM restaurant_bills WHERE company_id = $1 AND order_id = $2 LIMIT 1',
    companyId,
    orderId,
  );
  return rows[0] || null;
}

async function findBillById(companyId, billId) {
  const rows = await dbClient().$queryRawUnsafe(
    'SELECT id, company_id AS "companyId", order_id AS "orderId", invoice_id AS "invoiceId", version, status, split_type AS "splitType", subtotal::text AS subtotal, tax_amount::text AS "taxAmount", total_amount::text AS "totalAmount", line_snapshot AS "lineSnapshot", payer_allocations AS "payerAllocations", created_by_id AS "createdById", created_at AS "createdAt", updated_at AS "updatedAt" FROM restaurant_bills WHERE company_id = $1 AND id = $2 LIMIT 1',
    companyId,
    billId,
  );
  return rows[0] || null;
}

async function loadInvoice(companyId, invoiceId) {
  const invoice = await dbClient().invoice.findFirst({
    where: { id: invoiceId, companyId, posOrigin: true },
    include: { lines: { orderBy: { lineOrder: 'asc' } } },
  });
  if (!invoice) throw fail('RESTAURANT_BILL_INVOICE_NOT_FOUND', 'The POS invoice linked to this bill is unavailable.', 409);
  return invoice;
}

async function paymentAvailability(companyId, actor, permissions = []) {
  const settings = await posPaymentService.getPaymentSettings(companyId);
  const paymentFlow = posPaymentService.resolvePaymentFlow(settings, actor.registerId);
  const enabledMethods = posPaymentService.resolveEnabledMethods(
    settings,
    actor.registerId,
    actor.systemTillType,
  ).filter((method) => BILL_PAYMENT_METHODS.has(method)
    && (method !== 'GIFT_CARD' || permissions.includes('pos.giftcard.redeem')));
  return { settings, paymentFlow, enabledMethods };
}

function requireInvoiceActor(invoice, actor) {
  if (String(invoice.registerId || '') !== actor.registerId
    || String(invoice.cashierId || '') !== actor.userId) {
    throw fail('POS_PAYMENT_CONTEXT_MISMATCH', 'This bill belongs to a different cashier or register.', 403);
  }
}

function jsonValue(value, fallback) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw fail('RESTAURANT_BILL_SNAPSHOT_INVALID', 'The saved Restaurant bill details cannot be read.', 409);
    }
  }
  return value == null ? fallback : value;
}

function buildCheckoutLines(order) {
  const sentItems = order.items.filter((item) => item.status === 'sent');
  if (!sentItems.length) throw fail('RESTAURANT_ORDER_EMPTY', 'Add and send at least one item before issuing the bill.', 409);
  return sentItems.map((item) => {
    const basePrice = Number(item.unitPrice);
    const taxRate = Number(item.taxRate || 0);
    const modifiers = Array.isArray(item.modifiers) ? item.modifiers : [];
    const modifierTotal = modifiers.reduce((sum, modifier) => sum + Number(modifier.priceAdjustment || 0), 0);
    const unitPrice = roundMoney(basePrice + modifierTotal);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      throw fail('RESTAURANT_BILL_LINE_INVALID', `The saved price or tax for ${item.name} is invalid.`, 409);
    }
    const modifierText = modifiers.length
      ? `Modifiers: ${modifiers.map((modifier) => modifier.name).join(', ')}`
      : '';
    const noteText = item.note ? `Note: ${item.note}` : '';
    const description = [item.name, modifierText, noteText].filter(Boolean).join(' · ');
    return {
      itemId: String(item.id),
      productId: String(item.productId),
      name: String(item.name),
      sku: String(item.sku || ''),
      quantity: Number(item.quantity),
      unitPrice,
      taxCode: String(item.taxCode || (taxRate > 0 ? 'B' : 'A')),
      taxRate,
      modifiers,
      note: String(item.note || ''),
      description,
    };
  });
}

function buildInvoiceLineSnapshot(invoice, checkoutLines) {
  const invoiceLines = Array.isArray(invoice.lines) ? [...invoice.lines] : [];
  invoiceLines.sort((left, right) => Number(left.lineOrder || 0) - Number(right.lineOrder || 0));
  if (invoiceLines.length !== checkoutLines.length) {
    throw fail('RESTAURANT_BILL_INVOICE_MISMATCH', 'The shared POS invoice does not match the saved Restaurant order.', 409);
  }
  const items = invoiceLines.map((line, index) => {
    const source = checkoutLines[index];
    if (String(line.productId || line.product || '') !== source.productId
      || Number(line.qty ?? line.quantity) !== source.quantity
      || Math.abs(Number(line.unitPrice) - source.unitPrice) > 0.005
      || Number(line.taxRate) !== source.taxRate
      || String(line.taxCode || '') !== source.taxCode) {
      throw fail('RESTAURANT_BILL_INVOICE_MISMATCH', 'The shared POS invoice does not match the saved Restaurant order.', 409);
    }
    const lineSubtotal = Number(line.lineSubtotal || 0);
    const discountPct = Number(line.discountPct || 0);
    return {
      ...source,
      description: String(line.description || source.description),
      discountPct,
      discountAmount: roundMoney(lineSubtotal * discountPct / 100),
      subtotal: lineSubtotal,
      taxAmount: Number(line.lineTax ?? line.taxAmount ?? 0),
      total: Number(line.lineTotal || 0),
    };
  });
  return {
    version: 1,
    orderVersion: Number(invoice.restaurantOrderVersion || 0),
    totalDiscount: Number(invoice.totalDiscount || 0),
    items,
  };
}

async function loadPayments(companyId, invoiceId) {
  return dbClient().posPayment.findMany({
    where: { companyId, saleId: invoiceId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function billView(row, invoice, payments, availability) {
  const lineSnapshot = jsonValue(row.lineSnapshot, {});
  const totalAmount = Number(row.totalAmount);
  const amountPaid = payments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  return {
    id: String(row.id),
    orderId: String(row.orderId),
    invoiceId: String(row.invoiceId),
    version: Number(row.version),
    status: String(row.status),
    splitType: String(row.splitType),
    currencyCode: String(invoice.currencyCode || 'RWF'),
    subtotal: Number(row.subtotal),
    discountAmount: Number(lineSnapshot.totalDiscount || 0),
    taxAmount: Number(row.taxAmount),
    totalAmount,
    amountPaid,
    balanceDue: Math.max(0, totalAmount - amountPaid),
    lines: Array.isArray(lineSnapshot.items) ? lineSnapshot.items : [],
    payments: payments.map((payment) => ({
      id: String(payment.id),
      method: String(payment.method),
      status: String(payment.status),
      amount: Number(payment.amount),
      reference: payment.reference || null,
      createdAt: payment.createdAt,
    })),
    paymentMethods: availability.enabledMethods,
    paymentFlow: availability.paymentFlow,
    receiptNumber: invoice.referenceNo || null,
    invoiceStatus: invoice.status,
  };
}

async function getBill(companyIdValue, orderIdValue, req) {
  const companyId = String(companyIdValue || '');
  const orderId = requiredId(orderIdValue, 'order');
  const actor = actorFor(req);
  const row = await findBillByOrder(companyId, orderId);
  if (!row) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This order does not have an issued bill yet.', 404);
  const [invoice, order, availability, payments] = await Promise.all([
    loadInvoice(companyId, String(row.invoiceId)),
    dbClient().restaurantOrder.findFirst({ where: { id: orderId, companyId } }),
    paymentAvailability(companyId, actor, req.posPermissions || []),
    loadPayments(companyId, String(row.invoiceId)),
  ]);
  if (!order) throw fail('RESTAURANT_ORDER_NOT_FOUND', 'This order is not available in this company.', 404);
  requireInvoiceActor(invoice, actor);
  if (String(order.registerId) !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Open this order on the register that created it.', 403);
  }
  return billView(row, invoice, payments, availability);
}

async function issueBill(companyIdValue, orderIdValue, req) {
  const companyId = String(companyIdValue || '');
  const orderId = requiredId(orderIdValue, 'order');
  const actor = actorFor(req);
  idempotencyKeyFor(req);

  const existing = await findBillByOrder(companyId, orderId);
  if (existing) return getBill(companyId, orderId, req);

  const availability = await paymentAvailability(companyId, actor, req.posPermissions || []);
  if (availability.paymentFlow !== 'PAYMENTS_V2') {
    throw fail('POS_PAYMENT_FLOW_DISABLED', 'Enable Payments V2 for this register before issuing Restaurant bills.', 409);
  }
  if (!ID_PATTERN.test(actor.branchId)) {
    throw fail('POS_REGISTER_WAREHOUSE_REQUIRED', 'Assign this register to a branch/warehouse before billing Restaurant orders.', 409);
  }

  const order = await posOrderService.claimBill(
    companyId,
    orderId,
    actor,
    `restaurant-bill-issued-${orderId}`,
  );
  const checkoutLines = buildCheckoutLines(order);
  const restaurantCheckout = {
    version: 1,
    orderId,
    orderVersion: order.version,
    lines: checkoutLines.map((line) => ({
      itemId: line.itemId,
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxCode: line.taxCode,
      taxRate: line.taxRate,
      description: line.description,
    })),
  };
  const createKey = `restaurant-bill-${orderId}`;
  const pendingResult = await invokeController(
    posPaymentsV2Controller.createPendingSale,
    internalRequest(req, {
      key: createKey,
      restaurantCheckout,
      body: {
        warehouseId: actor.branchId,
        paymentAmount: 0,
        payments: [],
        items: checkoutLines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          taxCode: line.taxCode,
          taxRate: line.taxRate,
          description: line.description,
          discountPct: 0,
        })),
      },
    }),
  );
  const pendingInvoice = pendingResult.data || pendingResult;
  const invoiceId = String(pendingInvoice._id || pendingInvoice.id || '');
  if (!ID_PATTERN.test(invoiceId)) {
    throw fail('RESTAURANT_BILL_INVOICE_MISSING', 'The shared POS checkout did not return a valid invoice.', 502);
  }
  const invoice = await loadInvoice(companyId, invoiceId);
  requireInvoiceActor(invoice, actor);
  if (invoice.status !== 'PENDING_PAYMENT') {
    throw fail('RESTAURANT_BILL_INVOICE_STATE_INVALID', 'The shared POS invoice is not waiting for payment.', 409);
  }
  const totalAmount = Number(invoice.totalAmount);
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    throw fail(
      'POS_FISCAL_ROUNDING_POLICY_UNRESOLVED',
      'This invoice has a fractional RWF total. Payment is blocked until the fiscal rounding policy is approved.',
      409,
    );
  }
  const lineSnapshot = buildInvoiceLineSnapshot(invoice, checkoutLines);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'INSERT INTO restaurant_bills (id, company_id, order_id, invoice_id, version, status, split_type, subtotal, tax_amount, total_amount, line_snapshot, payer_allocations, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::jsonb, $11::jsonb, $12, $13, $13) ON CONFLICT (company_id, order_id) DO NOTHING',
      generateObjectId(),
      companyId,
      orderId,
      invoiceId,
      'pending_payment',
      'single',
      Number(invoice.subtotal),
      Number(invoice.taxAmount),
      totalAmount,
      JSON.stringify(lineSnapshot),
      JSON.stringify([]),
      actor.userId,
      now,
    );
  });
  return getBill(companyId, orderId, req);
}

function normalizeAllocations(value, enabledMethods, requiredAmount) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw fail('POS_PAYMENT_SPLIT_INVALID', 'Provide between 1 and 10 payment allocations.', 400);
  }
  const includesMobileMoney = value.some((entry) => MOBILE_MONEY_METHODS.has(String(entry?.method || '').trim().toUpperCase()));
  if (includesMobileMoney && value.length !== 1) {
    throw fail('POS_PAYMENT_METHOD_UNAVAILABLE', 'Mobile money must settle the Restaurant bill as a single payment method.', 409);
  }
  const allocations = value.map((entry) => {
    const method = String(entry?.method || '').trim().toUpperCase();
    const amount = Number(entry?.amount);
    if (!BILL_PAYMENT_METHODS.has(method) || !enabledMethods.includes(method)) {
      throw fail('POS_PAYMENT_METHOD_DISABLED', `The ${method || 'selected'} payment method is not enabled for this register.`, 409);
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw fail('POS_PAYMENT_AMOUNT_INVALID', 'Each payment amount must be a positive whole RWF value.', 400);
    }
    const reference = typeof entry?.reference === 'string' ? entry.reference.trim() : '';
    const giftCardCode = typeof entry?.giftCardCode === 'string' ? entry.giftCardCode.trim() : '';
    const payerPhone = typeof entry?.payerPhone === 'string' ? entry.payerPhone.trim() : '';
    if (method === 'GIFT_CARD' && !giftCardCode) {
      throw fail('POS_GIFT_CARD_CODE_REQUIRED', 'Enter the gift card code before submitting payment.', 400);
    }
    if (MOBILE_MONEY_METHODS.has(method)) {
      if (!reference) throw fail('POS_PAYMENT_REFERENCE_REQUIRED', 'Enter the mobile money transaction reference.', 400);
      if (!payerPhone) throw fail('POS_PAYMENT_PHONE_INVALID', 'Enter the mobile money payer phone number.', 400);
      if (entry?.confirmReceived !== true) {
        throw fail('POS_PAYMENT_RECEIPT_CONFIRMATION_REQUIRED', 'Confirm that the mobile money was received before completing the bill.', 400);
      }
    }
    return {
      method,
      amount,
      ...(method === 'CASH' ? { tendered: amount } : {}),
      ...(reference ? { reference } : {}),
      ...(giftCardCode ? { giftCardCode } : {}),
      ...(MOBILE_MONEY_METHODS.has(method) ? { payerPhone, confirmReceived: true } : {}),
    };
  });
  if (allocations.reduce((sum, payment) => sum + payment.amount, 0) !== requiredAmount) {
    throw fail('RESTAURANT_BILL_FULL_SETTLEMENT_REQUIRED', 'Payment allocations must equal the full remaining bill balance.', 400);
  }
  return allocations;
}

async function linkBillPayments(companyId, bill, payments) {
  if (!payments.length) return;
  await prisma.$transaction(async (tx) => {
    for (const payment of payments) {
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_bill_payments (id, company_id, bill_id, payment_id, payer_number, amount) VALUES ($1, $2, $3, $4, 1, $5) ON CONFLICT (payment_id) DO NOTHING',
        generateObjectId(),
        companyId,
        bill.id,
        String(payment.id),
        Number(payment.amount),
      );
      const linked = await tx.$queryRawUnsafe(
        'SELECT bill_id AS "billId" FROM restaurant_bill_payments WHERE company_id = $1 AND payment_id = $2 LIMIT 1',
        companyId,
        String(payment.id),
      );
      if (!linked[0] || String(linked[0].billId) !== String(bill.id)) {
        throw fail('RESTAURANT_BILL_PAYMENT_LINK_CONFLICT', 'A POS payment is already linked to a different Restaurant bill.', 409);
      }
    }
  });
}

async function settleBill(companyIdValue, billIdValue, req) {
  const companyId = String(companyIdValue || '');
  const billId = requiredId(billIdValue, 'bill');
  const actor = actorFor(req);
  idempotencyKeyFor(req);
  const bill = await findBillById(companyId, billId);
  if (!bill) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This Restaurant bill is not available in this company.', 404);

  const [invoice, availability] = await Promise.all([
    loadInvoice(companyId, String(bill.invoiceId)),
    paymentAvailability(companyId, actor, req.posPermissions || []),
  ]);
  requireInvoiceActor(invoice, actor);
  if (availability.paymentFlow !== 'PAYMENTS_V2') {
    throw fail('POS_PAYMENT_FLOW_DISABLED', 'Enable Payments V2 for this register before taking Restaurant bill payments.', 409);
  }
  if (bill.status === 'paid') {
    return getBill(companyId, String(bill.orderId), req);
  }

  const totalAmount = Number(bill.totalAmount);
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    throw fail(
      'POS_FISCAL_ROUNDING_POLICY_UNRESOLVED',
      'This invoice has a fractional RWF total. Payment is blocked until the fiscal rounding policy is approved.',
      409,
    );
  }
  const existingPayments = await loadPayments(companyId, String(bill.invoiceId));
  if (existingPayments.some((payment) => UNRESOLVED_PAYMENT_STATUSES.has(payment.status))) {
    throw fail('POS_PAYMENT_METHOD_UNRESOLVED', 'Resolve the waiting payment before retrying this bill.', 409);
  }
  const paidAmount = existingPayments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  if (paidAmount > totalAmount) {
    throw fail('RESTAURANT_BILL_OVERPAID', 'The POS payments exceed this bill total. Ask a manager to reconcile the sale.', 409);
  }

  if (paidAmount < totalAmount) {
    if (existingPayments.length) {
      throw fail('RESTAURANT_BILL_PAYMENT_IN_PROGRESS', 'A payment attempt is already recorded. Refresh the bill or ask a manager to review it before adding another tender.', 409);
    }
    const allocations = normalizeAllocations(
      req.body?.payments,
      availability.enabledMethods,
      totalAmount - paidAmount,
    );
    const mobilePayment = allocations.length === 1 && MOBILE_MONEY_METHODS.has(allocations[0].method);
    await invokeController(
      mobilePayment ? posPaymentsV2Controller.recordPayment : posPaymentsV2Controller.recordCashPayment,
      internalRequest(req, {
        key: `restaurant_bill_${bill.id}`,
        params: { saleId: String(bill.invoiceId) },
        body: mobilePayment ? allocations[0] : { payments: allocations },
      }),
    );
  }

  const payments = await loadPayments(companyId, String(bill.invoiceId));
  if (payments.some((payment) => UNRESOLVED_PAYMENT_STATUSES.has(payment.status))) {
    throw fail('POS_PAYMENT_METHOD_UNRESOLVED', 'The payment is waiting for confirmation. Resolve it before completing the bill.', 409);
  }
  const confirmedAmount = payments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  if (confirmedAmount !== totalAmount) {
    throw fail('RESTAURANT_BILL_FULL_SETTLEMENT_REQUIRED', 'The bill can be completed only after the full balance is received.', 409);
  }
  await linkBillPayments(companyId, bill, payments.filter((payment) => payment.status === 'SUCCESS'));

  const completionKey = `restaurant_complete_${bill.id}`;
  const completedResult = await invokeController(
    posPaymentsV2Controller.completeSale,
    internalRequest(req, {
      key: completionKey,
      params: { saleId: String(bill.invoiceId) },
      body: {},
    }),
  );
  const completedInvoice = completedResult.data || completedResult;
  const currentOrder = await dbClient().restaurantOrder.findFirst({
    where: { id: String(bill.orderId), companyId },
    select: { registerId: true },
  });
  if (!currentOrder || String(currentOrder.registerId) !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Complete payment on the register that created this order.', 403);
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'UPDATE restaurant_bills SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND id = $3 AND status <> $1',
      'paid',
      companyId,
      bill.id,
    );
    await posOrderService.markBillPaid(
      tx,
      companyId,
      String(bill.orderId),
      actor,
      `restaurant-bill-paid-${bill.orderId}`,
    );
  });
  const finalBill = await getBill(companyId, String(bill.orderId), req);
  return {
    ...finalBill,
    receiptNumber: completedInvoice.referenceNo || finalBill.receiptNumber,
    invoiceStatus: completedInvoice.status || finalBill.invoiceStatus,
  };
}

module.exports = {
  buildCheckoutLines,
  getBill,
  issueBill,
  normalizeAllocations,
  settleBill,
};

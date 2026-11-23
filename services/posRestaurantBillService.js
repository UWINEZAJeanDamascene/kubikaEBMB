'use strict';

const crypto = require('crypto');
const { dbClient, prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const posOrderService = require('./posRestaurantOrderService');
const posPaymentService = require('./posPaymentService');
const posPaymentsV2Controller = require('../controllers/posPaymentsV2Controller');
const { roundMoney } = require('./posCheckoutCoreService');
const { writePosAuditLog, requestIp } = require('./posAuditService');
const { releaseInvoiceReservations } = require('./posVoucherService');
const { allocateEqualRwf, allocateItemsToChecks, MAX_GUESTS } = require('./posRestaurantBillSplit');
const billingSettingsService = require('./posRestaurantBillingSettingsService');
const chargeRules = require('./posRestaurantChargeRules');

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
  return dbClient().$queryRawUnsafe(
    'SELECT id, company_id AS "companyId", order_id AS "orderId", check_number AS "checkNumber", guest_number AS "guestNumber", reallocation_key AS "reallocationKey", invoice_id AS "invoiceId", version, status, split_type AS "splitType", subtotal::text AS subtotal, tax_amount::text AS "taxAmount", total_amount::text AS "totalAmount", service_charge_amount::text AS "serviceChargeAmount", service_charge_tax_amount::text AS "serviceChargeTaxAmount", service_charge_rate_pct::text AS "serviceChargeRatePct", service_charge_mode AS "serviceChargeMode", service_charge_taxable AS "serviceChargeTaxable", service_charge_tax_rate_id AS "serviceChargeTaxRateId", service_charge_override_reason AS "serviceChargeOverrideReason", line_snapshot AS "lineSnapshot", payer_allocations AS "payerAllocations", created_by_id AS "createdById", created_at AS "createdAt", updated_at AS "updatedAt" FROM restaurant_bills WHERE company_id = $1 AND order_id = $2 AND status <> $3 ORDER BY check_number ASC, id ASC',
    companyId,
    orderId,
    'cancelled',
  );
}

async function findBillById(companyId, billId) {
  const rows = await dbClient().$queryRawUnsafe(
    'SELECT id, company_id AS "companyId", order_id AS "orderId", check_number AS "checkNumber", guest_number AS "guestNumber", reallocation_key AS "reallocationKey", invoice_id AS "invoiceId", version, status, split_type AS "splitType", subtotal::text AS subtotal, tax_amount::text AS "taxAmount", total_amount::text AS "totalAmount", service_charge_amount::text AS "serviceChargeAmount", service_charge_tax_amount::text AS "serviceChargeTaxAmount", service_charge_rate_pct::text AS "serviceChargeRatePct", service_charge_mode AS "serviceChargeMode", service_charge_taxable AS "serviceChargeTaxable", service_charge_tax_rate_id AS "serviceChargeTaxRateId", service_charge_override_reason AS "serviceChargeOverrideReason", line_snapshot AS "lineSnapshot", payer_allocations AS "payerAllocations", created_by_id AS "createdById", created_at AS "createdAt", updated_at AS "updatedAt" FROM restaurant_bills WHERE company_id = $1 AND id = $2 LIMIT 1',
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
    if (item.isCustom === true
      && (item.customPricingStatus !== 'approved' || !ID_PATTERN.test(String(item.productId || '')))) {
      throw fail('RESTAURANT_CUSTOM_ITEM_REVIEW_REQUIRED', 'A manager must assign a catalog product, price, and tax category to every custom item before billing.', 409);
    }
    const basePrice = Number(item.unitPrice);
    const taxRate = Number(item.taxRate || 0);
    const modifiers = Array.isArray(item.modifiers) ? item.modifiers : [];
    const modifierTotal = modifiers.reduce((sum, modifier) => sum + Number(modifier.priceAdjustment || 0), 0);
    const unitPrice = roundMoney(basePrice + modifierTotal);
    const promotion = item.promotionSnapshot && typeof item.promotionSnapshot === 'object'
      ? item.promotionSnapshot
      : null;
    const promotionDiscount = promotion
      ? Math.max(0, basePrice - Number(promotion.unitPrice || basePrice))
      : 0;
    const discountPct = unitPrice > 0
      ? Number((promotionDiscount / unitPrice * 100).toFixed(8))
      : 0;
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
      discountPct,
      promotionSnapshot: promotion,
      taxCode: String(item.taxCode || (taxRate > 0 ? 'B' : 'A')),
      taxRate,
      serviceChargeExempt: item.serviceChargeExempt === true,
      stockMode: item.stockMode || 'none',
      barStockProductId: item.barStockProductId || null,
      modifiers,
      note: String(item.note || ''),
      description,
    };
  });
}

function buildInvoiceLineSnapshot(invoice, checkoutLines) {
  const invoiceLines = Array.isArray(invoice.lines) ? [...invoice.lines] : [];
  invoiceLines.sort((left, right) => Number(left.lineOrder || 0) - Number(right.lineOrder || 0));
  const itemInvoiceLines = invoiceLines.filter((line) => line.isServiceLine !== true);
  if (itemInvoiceLines.length !== checkoutLines.length) {
    throw fail('RESTAURANT_BILL_INVOICE_MISMATCH', 'The shared POS invoice does not match the saved Restaurant order.', 409);
  }
  const items = itemInvoiceLines.map((line, index) => {
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
      serviceChargeExempt: source.serviceChargeExempt === true,
    };
  });
  return {
    version: 1,
    orderVersion: Number(invoice.restaurantOrderVersion || 0),
    totalDiscount: Number(invoice.totalDiscount || 0),
    items,
    serviceCharge: jsonValue(invoice.posCheckoutPayload, {})?.restaurantCheckoutSnapshot?.serviceCharge || null,
  };
}

function assertServiceChargeOverride(req, settings, actor) {
  const overrideRequested = req.body?.waiveServiceCharge === true
    || Object.prototype.hasOwnProperty.call(req.body || {}, 'serviceChargeRatePct');
  if (!overrideRequested) return null;
  if (settings.serviceChargeMode === 'off') {
    throw fail('RESTAURANT_SERVICE_CHARGE_DISABLED', 'A manager cannot add a service charge while the company setting is off.', 409);
  }
  if (!req.posPermissions?.includes('pos.payment.reconcile')) {
    throw fail('RESTAURANT_SERVICE_CHARGE_MANAGER_REQUIRED', 'Only a manager can change or waive a service charge.', 403);
  }
  const reason = typeof req.body?.serviceChargeOverrideReason === 'string'
    ? req.body.serviceChargeOverrideReason.trim()
    : '';
  if (!reason || reason.length > 500) {
    throw fail('RESTAURANT_SERVICE_CHARGE_REASON_REQUIRED', 'Enter a reason of 1 to 500 characters for the manager service-charge change.', 400);
  }
  const ratePct = req.body?.waiveServiceCharge === true
    ? 0
    : Number(req.body?.serviceChargeRatePct);
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
    throw fail('RESTAURANT_SERVICE_CHARGE_RATE_INVALID', 'The manager service-charge rate must be between 0 and 100 percent.', 400);
  }
  return { ratePct, reason, approvedById: actor.userId };
}

function serviceChargeLineSnapshot(settings, taxClass, amountRwf, override) {
  const ratePct = override ? override.ratePct : settings.serviceChargeRatePct;
  const mode = settings.serviceChargeMode;
  const taxable = settings.serviceChargeTaxable === true;
  const taxRate = taxable ? Number(taxClass.ratePct) : 0;
  const taxAmountRwf = roundMoney(amountRwf * taxRate / 100);
  return {
    mode,
    ratePct,
    amountRwf,
    taxAmountRwf,
    taxable,
    taxRateId: settings.serviceChargeTaxRateId,
    taxCode: taxClass.code,
    taxRate,
    overrideReason: override?.reason || null,
    overriddenById: override?.approvedById || null,
  };
}

async function applyServiceChargeToInvoice(tx, companyId, invoice, charge) {
  const lines = [...(invoice.lines || [])].sort((a, b) => Number(a.lineOrder || 0) - Number(b.lineOrder || 0));
  const existing = lines.find((line) => line.isServiceLine === true);
  if (existing) {
    const savedSnapshot = jsonValue(invoice.posCheckoutPayload, {})?.restaurantCheckoutSnapshot?.serviceCharge;
    if (!savedSnapshot
      || Number(savedSnapshot.amountRwf) !== Number(charge.amountRwf)
      || Number(savedSnapshot.taxAmountRwf) !== Number(charge.taxAmountRwf)) {
      throw fail('RESTAURANT_SERVICE_CHARGE_RETRY_CONFLICT', 'A saved service-charge line differs from this retry. Ask a manager to review the check.', 409);
    }
    return { ...invoice, restaurantServiceCharge: savedSnapshot };
  }

  const itemLine = lines.find((line) => line.isServiceLine !== true);
  if (!itemLine?.productId) {
    throw fail('RESTAURANT_BILL_INVOICE_MISMATCH', 'The service charge cannot be attached to a check without a sold item.', 409);
  }
  const serviceCharge = serviceChargeLineSnapshot(
    charge.settings,
    charge.taxClass,
    charge.amountRwf,
    charge.override,
  );
  const checkoutPayload = jsonValue(invoice.posCheckoutPayload, {});
  const restaurantCheckoutSnapshot = checkoutPayload.restaurantCheckoutSnapshot || {};
  const nextPayload = {
    ...checkoutPayload,
    restaurantCheckoutSnapshot: {
      ...restaurantCheckoutSnapshot,
      serviceCharge,
    },
  };
  if (serviceCharge.amountRwf === 0) {
    const updated = await tx.invoice.update({
      where: { companyId_id: { companyId, id: String(invoice.id) } },
      data: { posCheckoutPayload: nextPayload },
    });
    return { ...updated, lines, restaurantServiceCharge: serviceCharge };
  }
  const serviceLine = {
    id: generateObjectId(),
    companyId,
    invoiceId: String(invoice.id),
    lineOrder: lines.length ? Math.max(...lines.map((line) => Number(line.lineOrder || 0))) + 1 : 0,
    productId: String(itemLine.productId),
    productName: 'Service charge',
    productCode: 'SERVICE_CHARGE',
    description: `Service charge (${serviceCharge.ratePct}%)`,
    qty: 1,
    unit: 'service',
    unitPrice: serviceCharge.amountRwf,
    discountPct: 0,
    discountReason: null,
    taxRate: serviceCharge.taxRate,
    taxCode: serviceCharge.taxCode,
    lineSubtotal: serviceCharge.amountRwf,
    lineTax: serviceCharge.taxAmountRwf,
    lineTotal: roundMoney(serviceCharge.amountRwf + serviceCharge.taxAmountRwf),
    unitCost: 0,
    cogsAmount: 0,
    warehouseId: itemLine.warehouseId || null,
    isServiceLine: true,
    serviceChargeExempt: true,
  };
  await tx.invoiceLine.create({ data: serviceLine });
  const updated = await tx.invoice.update({
    where: { companyId_id: { companyId, id: String(invoice.id) } },
    data: {
      subtotal: { increment: serviceLine.lineSubtotal },
      taxAmount: { increment: serviceLine.lineTax },
      totalAmount: { increment: serviceLine.lineTotal },
      ...(serviceCharge.taxCode === 'A' ? { totalAEx: { increment: serviceLine.lineSubtotal } } : {}),
      ...(serviceCharge.taxCode === 'B' ? { totalB18: { increment: serviceLine.lineSubtotal } } : {}),
      posCheckoutPayload: nextPayload,
    },
  });
  return {
    ...updated,
    lines: [...lines, serviceLine],
    restaurantServiceCharge: serviceCharge,
  };
}

async function loadPayments(companyId, invoiceId) {
  if (!invoiceId) return [];
  return dbClient().posPayment.findMany({
    where: { companyId, saleId: invoiceId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function billView(row, invoice, payments, availability, paymentLinks) {
  const lineSnapshot = jsonValue(row.lineSnapshot, {});
  const payerAllocations = jsonValue(row.payerAllocations, []);
  const totalAmount = Number(row.totalAmount);
  const amountPaid = payments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  return {
    id: String(row.id),
    orderId: String(row.orderId),
    checkNumber: Number(row.checkNumber || 1),
    guestNumber: row.guestNumber == null ? null : Number(row.guestNumber),
    invoiceId: row.invoiceId ? String(row.invoiceId) : null,
    version: Number(row.version),
    status: String(row.status),
    splitType: String(row.splitType),
    currencyCode: String(invoice.currencyCode || 'RWF'),
    subtotal: Number(row.subtotal),
    discountAmount: Number(lineSnapshot.totalDiscount || 0),
    taxAmount: Number(row.taxAmount),
    serviceChargeAmount: Number(row.serviceChargeAmount || 0),
    serviceChargeTaxAmount: Number(row.serviceChargeTaxAmount || 0),
    serviceChargeRatePct: row.serviceChargeRatePct == null ? null : Number(row.serviceChargeRatePct),
    serviceChargeMode: String(row.serviceChargeMode || 'off'),
    serviceChargeTaxable: row.serviceChargeTaxable === true,
    serviceChargeOverrideReason: row.serviceChargeOverrideReason || null,
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
      payerNumber: paymentLinks.get(String(payment.id))?.payerNumber == null
        ? null
        : Number(paymentLinks.get(String(payment.id)).payerNumber),
      lockReleasedAt: paymentLinks.get(String(payment.id))?.lockReleasedAt || null,
      lockReleaseReason: paymentLinks.get(String(payment.id))?.lockReleaseReason || null,
    })),
    payerAllocations: payerAllocations.map((allocation) => {
      const guestNumber = Number(allocation.guestNumber ?? allocation.payerNumber);
      const amount = Number(allocation.amount);
      const paid = payments
        .filter((payment) => payment.status === 'SUCCESS'
          && Number(paymentLinks.get(String(payment.id))?.payerNumber) === guestNumber)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      return { guestNumber, amount, amountPaid: paid, balanceDue: Math.max(0, amount - paid) };
    }),
    paymentLocked: payments.some((payment) => (
      payment.status === 'SUCCESS'
      || UNRESOLVED_PAYMENT_STATUSES.has(payment.status)
      || (payment.status !== 'SUCCESS' && !paymentLinks.get(String(payment.id))?.lockReleasedAt)
    )),
    paymentMethods: availability.enabledMethods,
    paymentFlow: availability.paymentFlow,
    receiptNumber: invoice?.referenceNo || null,
    invoiceStatus: invoice?.status || null,
  };
}

async function getBill(companyIdValue, orderIdValue, req) {
  const companyId = String(companyIdValue || '');
  const orderId = requiredId(orderIdValue, 'order');
  const actor = actorFor(req);
  const rows = await findBillByOrder(companyId, orderId);
  if (!rows.length) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This order does not have an issued bill yet.', 404);
  const [order, availability] = await Promise.all([
    dbClient().restaurantOrder.findFirst({ where: { id: orderId, companyId } }),
    paymentAvailability(companyId, actor, req.posPermissions || []),
  ]);
  if (!order) throw fail('RESTAURANT_ORDER_NOT_FOUND', 'This order is not available in this company.', 404);
  if (String(order.registerId) !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Open this order on the register that created it.', 403);
  }
  const checks = await Promise.all(rows.map(async (row) => {
    const invoice = row.invoiceId ? await loadInvoice(companyId, String(row.invoiceId)) : null;
    if (invoice && String(invoice.registerId || '') !== actor.registerId) {
      throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Open this order on the register that created it.', 403);
    }
    const payments = invoice ? await loadPayments(companyId, String(row.invoiceId)) : [];
    const paymentLinksRows = invoice
      ? await dbClient().$queryRawUnsafe(
        'SELECT payment_id AS "paymentId", payer_number AS "payerNumber", lock_released_at AS "lockReleasedAt", lock_release_reason AS "lockReleaseReason" FROM restaurant_bill_payments WHERE company_id = $1 AND bill_id = $2',
        companyId,
        row.id,
      )
      : [];
    const paymentLinks = new Map(paymentLinksRows.map((link) => [String(link.paymentId), link]));
    return billView(row, invoice, payments, availability, paymentLinks);
  }));
  const amountPaid = checks.reduce((sum, check) => sum + check.amountPaid, 0);
  const totalAmount = checks.reduce((sum, check) => sum + check.totalAmount, 0);
  return {
    ...checks[0],
    orderId,
    splitType: String(rows[0].splitType),
    status: checks.every((check) => check.status === 'paid') ? 'paid' : 'pending_payment',
    totalAmount,
    amountPaid,
    balanceDue: Math.max(0, totalAmount - amountPaid),
    checks,
  };
}

async function releaseFailedPaymentLock(companyIdValue, billIdValue, paymentIdValue, req) {
  const companyId = String(companyIdValue || '');
  const billId = requiredId(billIdValue, 'bill');
  const paymentId = requiredId(paymentIdValue, 'payment');
  const actor = actorFor(req);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw fail('RESTAURANT_BILL_RELEASE_REASON_INVALID', 'Enter a clear reason between 10 and 500 characters.', 400);
  }
  const bill = await findBillById(companyId, billId);
  if (!bill || !bill.invoiceId) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This Restaurant check is unavailable.', 404);
  const invoice = await loadInvoice(companyId, String(bill.invoiceId));
  if (String(invoice.registerId || '') !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Release this payment on the register that created the check.', 403);
  }
  const payment = await dbClient().posPayment.findFirst({
    where: { id: paymentId, companyId, saleId: String(bill.invoiceId) },
  });
  if (!payment) throw fail('RESTAURANT_BILL_PAYMENT_NOT_FOUND', 'This payment attempt does not belong to the check.', 404);
  if (!['FAILED', 'CANCELLED', 'VOIDED'].includes(String(payment.status))) {
    throw fail('RESTAURANT_BILL_PAYMENT_NOT_FINAL', 'Only a confirmed failed or cancelled payment with no captured funds can be released.', 409);
  }
  const amount = Number(payment.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw fail('RESTAURANT_BILL_PAYMENT_INVALID', 'The payment attempt amount cannot be verified.', 409);
  }
  await prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      'SELECT id, lock_released_at AS "lockReleasedAt" FROM restaurant_bill_payments WHERE company_id = $1 AND payment_id = $2 FOR UPDATE',
      companyId,
      paymentId,
    );
    if (existing[0]?.lockReleasedAt) return;
    if (!existing.length) {
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_bill_payments (id, company_id, bill_id, payment_id, payer_number, amount) VALUES ($1, $2, $3, $4, $5, $6)',
        generateObjectId(),
        companyId,
        bill.id,
        paymentId,
        Number(bill.guestNumber || req.body?.payerNumber || 1),
        amount,
      );
    }
    await tx.$executeRawUnsafe(
      'UPDATE restaurant_bill_payments SET lock_released_at = CURRENT_TIMESTAMP, lock_release_reason = $1, lock_released_by_id = $2 WHERE company_id = $3 AND payment_id = $4 AND lock_released_at IS NULL',
      reason,
      actor.userId,
      companyId,
      paymentId,
    );
    await writePosAuditLog({
      companyId,
      registerId: actor.registerId,
      userId: actor.userId,
      event: 'PAYMENT_CANCELLED',
      metadata: {
        action: 'RESTAURANT_FAILED_PAYMENT_LOCK_RELEASED',
        billId: bill.id,
        orderId: bill.orderId,
        paymentId,
        paymentStatus: payment.status,
        reason,
      },
      ip: req.ip || req.connection?.remoteAddress || null,
    }, tx);
  });
  return getBill(companyId, String(bill.orderId), req);
}

async function moveItemsBetweenChecks(companyIdValue, orderIdValue, req) {
  const companyId = String(companyIdValue || '');
  const orderId = requiredId(orderIdValue, 'order');
  const actor = actorFor(req);
  idempotencyKeyFor(req);
  if (actor.trainingMode) {
    throw fail('RESTAURANT_TRAINING_ORDER', 'Training orders cannot be billed as real sales.', 409);
  }
  const existingRows = await findBillByOrder(companyId, orderId);
  if (!existingRows.length || existingRows.some((row) => row.splitType !== 'item')) {
    throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'Only item-split checks can move items between guests.', 409);
  }
  const billingSettings = await billingSettingsService.getSettings(companyId);
  if (billingSettings.serviceChargeMode !== 'off'
    || existingRows.some((row) => String(row.serviceChargeMode || 'off') !== 'off')) {
    throw fail(
      'RESTAURANT_SERVICE_CHARGE_ITEM_MOVE_UNSUPPORTED',
      'Item movement is unavailable while service charges are enabled; moving items requires a reviewed service-charge reallocation.',
      409,
    );
  }
  const guestCount = Number(req.body?.guestCount);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS) {
    throw fail('RESTAURANT_BILL_SPLIT_INVALID', `Choose between 1 and ${MAX_GUESTS} guests.`, 400);
  }
  const order = await dbClient().restaurantOrder.findFirst({ where: { id: orderId, companyId } });
  if (!order || String(order.registerId) !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Open this order on the register that created it.', 403);
  }
  const sourceLines = buildCheckoutLines(await posOrderService.getOrder(companyId, orderId, actor));
  const checks = allocateItemsToChecks(req.body?.checks, sourceLines, guestCount);
  const planHash = crypto.createHash('sha256').update(JSON.stringify(checks)).digest('hex').slice(0, 64);
  const actorRows = await dbClient().restaurantBill.findMany({
    where: { companyId, orderId },
    select: { id: true, checkNumber: true, invoiceId: true, status: true, version: true, reallocationKey: true },
  });
  const currentBill = await getBill(companyId, orderId, req);
  const lockedGuestNumbers = new Set(currentBill.checks
    .filter((check) => check.paymentLocked || check.status === 'paid')
    .map((check) => Number(check.guestNumber || check.checkNumber)));
  const currentByGuest = new Map(currentBill.checks.map((check) => [
    Number(check.guestNumber || check.checkNumber),
    check.lines.map((line) => ({ itemId: String(line.itemId), quantity: Number(line.quantity) }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  ]));
  for (const guestNumber of lockedGuestNumbers) {
    const requested = checks.find((check) => check.guestNumber === guestNumber);
    const requestedLines = requested?.items
      .map((line) => ({ itemId: String(line.itemId), quantity: Number(line.quantity) }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
    if (!requestedLines || JSON.stringify(requestedLines) !== JSON.stringify(currentByGuest.get(guestNumber))) {
      throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', `Guest ${guestNumber}'s check has payment activity and cannot be changed.`, 409);
    }
  }
  const targetCheckNumbers = Array.from(new Set([
    ...existingRows.filter((row) => !lockedGuestNumbers.has(Number(row.checkNumber))).map((row) => Number(row.checkNumber)),
    ...checks.map((check) => check.guestNumber).filter((guestNumber) => (
      !lockedGuestNumbers.has(guestNumber)
      && actorRows.some((row) => Number(row.checkNumber) === guestNumber)
    )),
  ]));
  if (!targetCheckNumbers.length) {
    throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'All guest checks have payment activity and cannot be changed.', 409);
  }
  const inProgressRow = actorRows.find((row) => targetCheckNumbers.includes(Number(row.checkNumber))
    && row.status === 'preparing'
    && String(row.reallocationKey || '').startsWith(`${planHash}:`));
  const retrying = Boolean(inProgressRow);
  if (actorRows.some((row) => targetCheckNumbers.includes(Number(row.checkNumber))
    && row.status === 'preparing'
    && row.reallocationKey !== inProgressRow?.reallocationKey)) {
    throw fail('RESTAURANT_BILL_REALLOCATION_IN_PROGRESS', 'Another item move is still being completed. Refresh this check and try again.', 409);
  }
  const operationVersion = retrying
    ? Number(String(inProgressRow.reallocationKey).slice(planHash.length + 1))
    : Math.max(...actorRows.map((row) => Number(row.version || 1))) + 1;
  const operationKey = retrying ? inProgressRow.reallocationKey : `${planHash}:${operationVersion}`;
  if (!retrying) {
    const currentAssignments = Array.from(currentByGuest, ([guestNumber, items]) => ({ guestNumber, items }))
      .sort((left, right) => left.guestNumber - right.guestNumber);
    const nextAssignments = checks.map((check) => ({
      guestNumber: check.guestNumber,
      items: check.items.map((item) => ({ itemId: String(item.itemId), quantity: Number(item.quantity) }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId)),
    })).sort((left, right) => left.guestNumber - right.guestNumber);
    if (JSON.stringify(currentAssignments) === JSON.stringify(nextAssignments)) {
      return getBill(companyId, orderId, req);
    }
  }
  const availability = await paymentAvailability(companyId, actor, req.posPermissions || []);
  if (availability.paymentFlow !== 'PAYMENTS_V2') {
    throw fail('POS_PAYMENT_FLOW_DISABLED', 'Enable Payments V2 for this register before moving Restaurant checks.', 409);
  }
  if (!ID_PATTERN.test(actor.branchId)) {
    throw fail('POS_REGISTER_WAREHOUSE_REQUIRED', 'Assign this register to a branch/warehouse before billing Restaurant orders.', 409);
  }
  await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRawUnsafe(
      'SELECT id, check_number AS "checkNumber", invoice_id AS "invoiceId", status, reallocation_key AS "reallocationKey" FROM restaurant_bills WHERE company_id = $1 AND order_id = $2 FOR UPDATE',
      companyId,
      orderId,
    );
    if (lockedRows.some((row) => targetCheckNumbers.includes(Number(row.checkNumber))
      && row.status === 'preparing' && row.reallocationKey !== operationKey)) {
      throw fail('RESTAURANT_BILL_REALLOCATION_IN_PROGRESS', 'Another item move is still being completed. Refresh this check and try again.', 409);
    }
    if (retrying && !lockedRows.some((row) => targetCheckNumbers.includes(Number(row.checkNumber))
      && row.status === 'preparing' && row.reallocationKey === operationKey)) {
      throw fail('RESTAURANT_BILL_REALLOCATION_CHANGED', 'The item split changed while this request was running. Refresh and retry.', 409);
    }
    if (!retrying) {
      for (const row of lockedRows) {
        if (!targetCheckNumbers.includes(Number(row.checkNumber))
          || lockedGuestNumbers.has(Number(row.checkNumber))) continue;
        const bill = await findBillById(companyId, String(row.id));
        if (bill.status === 'paid') {
          throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'A paid check cannot be changed.', 409);
        }
        if (!bill.invoiceId) continue;
        const invoice = await tx.invoice.findFirst({
          where: { id: String(bill.invoiceId), companyId, posOrigin: true },
          select: { id: true, status: true, referenceNo: true },
        });
        if (!invoice) throw fail('RESTAURANT_BILL_INVOICE_NOT_FOUND', 'The POS invoice linked to this check is unavailable.', 409);
        if (invoice.status === 'cancelled') continue;
        if (invoice.status !== 'PENDING_PAYMENT') {
          throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'Only unpaid checks can be changed.', 409);
        }
        const attempts = await tx.posPayment.findMany({
          where: { companyId, saleId: invoice.id },
          select: { id: true, status: true },
        });
        for (const attempt of attempts) {
          if (attempt.status === 'SUCCESS' || UNRESOLVED_PAYMENT_STATUSES.has(attempt.status)) {
            throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'A successful or waiting payment locks every item on this check.', 409);
          }
          if (!['FAILED', 'CANCELLED', 'VOIDED'].includes(attempt.status)) {
            throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'A payment attempt must be resolved before moving items.', 409);
          }
          const releaseRows = await tx.$queryRawUnsafe(
            'SELECT lock_released_at AS "lockReleasedAt" FROM restaurant_bill_payments WHERE company_id = $1 AND payment_id = $2',
            companyId,
            String(attempt.id),
          );
          if (!releaseRows[0]?.lockReleasedAt) {
            throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'Ask a manager to release the failed payment attempt before moving items.', 409);
          }
        }
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledById: actor.userId,
            cancellationReason: 'RESTAURANT_ITEM_CHECK_REALLOCATED',
          },
        });
        await releaseInvoiceReservations(tx, companyId, invoice.id, actor.userId);
        await writePosAuditLog({
          companyId,
          registerId: actor.registerId,
          userId: actor.userId,
          event: 'PAYMENT_CANCELLED',
          metadata: {
            action: 'RESTAURANT_ITEM_CHECK_REALLOCATED',
            billId: bill.id,
            orderId,
            saleId: invoice.id,
            referenceNo: invoice.referenceNo,
            reason: 'Item quantities reassigned before payment.',
          },
          ip: req.ip || req.connection?.remoteAddress || null,
        }, tx);
      }
    }
    await tx.$executeRawUnsafe(
      'UPDATE restaurant_bills SET status = $1, reallocation_key = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE company_id = $3 AND order_id = $4 AND status <> $5 AND check_number = ANY($6::int[])',
      'preparing',
      operationKey,
      companyId,
      orderId,
      'paid',
      targetCheckNumbers,
    );
  });

  const version = operationVersion + 1;
  for (const check of checks.filter((entry) => !lockedGuestNumbers.has(entry.guestNumber))) {
    const checkout = {
      version: 1,
      orderId,
      orderVersion: Number(order.version),
      lines: check.items.map((line) => ({
        itemId: line.itemId,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        serviceChargeExempt: line.serviceChargeExempt === true,
        stockMode: line.stockMode,
        barStockProductId: line.barStockProductId,
        promotionSnapshot: line.promotionSnapshot,
        discountPct: line.discountPct,
        description: line.description,
      })),
    };
    const pendingResult = await invokeController(
      posPaymentsV2Controller.createPendingSale,
      internalRequest(req, {
        key: `restaurant-move-${planHash.slice(0, 32)}-${operationVersion}-${check.guestNumber}`,
        restaurantCheckout: checkout,
        body: {
          warehouseId: actor.branchId,
          paymentAmount: 0,
          payments: [],
          items: check.items.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxCode: line.taxCode,
            taxRate: line.taxRate,
            description: line.description,
            discountPct: line.discountPct,
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
      throw fail('POS_FISCAL_ROUNDING_POLICY_UNRESOLVED', 'This invoice has a fractional RWF total.', 409);
    }
    const lineSnapshot = buildInvoiceLineSnapshot(invoice, check.items);
    const existing = actorRows.find((row) => Number(row.checkNumber) === check.guestNumber);
    if (existing) {
      await dbClient().$executeRawUnsafe(
        'UPDATE restaurant_bills SET guest_number = $1, invoice_id = $2, status = $3, subtotal = $4::numeric, tax_amount = $5::numeric, total_amount = $6::numeric, line_snapshot = $7::jsonb, payer_allocations = $8::jsonb, reallocation_key = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE company_id = $9 AND id = $10 AND status = $11 AND reallocation_key = $12',
        check.guestNumber,
        invoiceId,
        'pending_payment',
        Number(invoice.subtotal),
        Number(invoice.taxAmount),
        totalAmount,
        JSON.stringify(lineSnapshot),
        JSON.stringify([]),
        companyId,
        existing.id,
        'preparing',
        operationKey,
      );
    } else {
      await dbClient().$executeRawUnsafe(
        'INSERT INTO restaurant_bills (id, company_id, order_id, check_number, guest_number, reallocation_key, invoice_id, version, status, split_type, subtotal, tax_amount, total_amount, line_snapshot, payer_allocations, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, NULL, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12::jsonb, $13::jsonb, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        generateObjectId(),
        companyId,
        orderId,
        check.guestNumber,
        invoiceId,
        version,
        'pending_payment',
        'item',
        Number(invoice.subtotal),
        Number(invoice.taxAmount),
        totalAmount,
        JSON.stringify(lineSnapshot),
        JSON.stringify([]),
        actor.userId,
      );
    }
  }
  const activeGuestNumbers = checks.map((check) => check.guestNumber);
  await dbClient().$executeRawUnsafe(
    'UPDATE restaurant_bills SET status = $1, reallocation_key = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND order_id = $3 AND status = $4 AND NOT (check_number = ANY($5::int[]))',
    'cancelled',
    companyId,
    orderId,
    'preparing',
    activeGuestNumbers,
  );
  return getBill(companyId, orderId, req);
}

async function issueBill(companyIdValue, orderIdValue, req) {
  const companyId = String(companyIdValue || '');
  const orderId = requiredId(orderIdValue, 'order');
  const actor = actorFor(req);
  idempotencyKeyFor(req);
  if (actor.trainingMode) {
    throw fail('RESTAURANT_TRAINING_ORDER', 'Training orders cannot be billed as real sales.', 409);
  }

  const existing = await findBillByOrder(companyId, orderId);
  if (existing.length) return getBill(companyId, orderId, req);

  const availability = await paymentAvailability(companyId, actor, req.posPermissions || []);
  if (availability.paymentFlow !== 'PAYMENTS_V2') {
    throw fail('POS_PAYMENT_FLOW_DISABLED', 'Enable Payments V2 for this register before issuing Restaurant bills.', 409);
  }
  const billingSettings = await billingSettingsService.getSettings(companyId);
  const serviceChargeOverride = assertServiceChargeOverride(req, billingSettings, actor);
  let serviceChargeSettings = null;
  let serviceChargeTaxClass = null;
  if (billingSettings.serviceChargeMode !== 'off') {
    const readiness = billingSettings.registers.find((entry) => entry.registerId === actor.registerId);
    if (!readiness?.ready) {
      throw fail(
        'RESTAURANT_BILLING_ACCOUNT_MAPPING_REQUIRED',
        'Complete the service-charge account mapping for this register before issuing bills.',
        409,
      );
    }
    const ratePct = serviceChargeOverride
      ? serviceChargeOverride.ratePct
      : billingSettingsService.effectiveRate(billingSettings, {
        tillType: actor.systemTillType.toLowerCase(),
        registerId: actor.registerId,
      });
    if (ratePct == null) {
      throw fail('RESTAURANT_BILLING_RATE_REQUIRED', 'Configure a service-charge rate for this register before issuing bills.', 409);
    }
    serviceChargeSettings = { ...billingSettings, serviceChargeRatePct: ratePct };
    serviceChargeTaxClass = billingSettings.taxClasses.find(
      (taxClass) => taxClass.id === billingSettings.serviceChargeTaxRateId,
    );
    if (!serviceChargeTaxClass) {
      throw fail('RESTAURANT_BILLING_TAX_CLASS_INVALID', 'The configured service-charge tax class is unavailable.', 409);
    }
  }
  if (!ID_PATTERN.test(actor.branchId)) {
    throw fail('POS_REGISTER_WAREHOUSE_REQUIRED', 'Assign this register to a branch/warehouse before billing Restaurant orders.', 409);
  }

  const splitType = String(req.body?.splitType || 'single').toLowerCase();
  if (!['single', 'item', 'equal', 'amount'].includes(splitType)) {
    throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'Choose single, item, equal, or custom amount splitting.', 400);
  }
  const requestedGuestCount = Number(req.body?.guestCount);
  if (splitType === 'equal' && (!Number.isInteger(requestedGuestCount)
    || requestedGuestCount < 1 || requestedGuestCount > MAX_GUESTS)) {
    throw fail('RESTAURANT_BILL_SPLIT_INVALID', `Choose between 1 and ${MAX_GUESTS} guests.`, 400);
  }
  if (splitType === 'amount' && (!Array.isArray(req.body?.payerAllocations)
    || req.body.payerAllocations.length < 2 || req.body.payerAllocations.length > MAX_GUESTS)) {
    throw fail('RESTAURANT_BILL_SPLIT_INVALID', `Choose between 2 and ${MAX_GUESTS} guests for a custom split.`, 400);
  }
  if (splitType === 'amount') {
    const entries = req.body.payerAllocations;
    const guestNumbers = entries.map((entry, index) => Number(entry?.guestNumber ?? index + 1));
    if (new Set(guestNumbers).size !== guestNumbers.length
      || guestNumbers.some((guestNumber) => !Number.isInteger(guestNumber) || guestNumber < 1 || guestNumber > MAX_GUESTS)
      || entries.slice(0, -1).some((entry) => !Number.isSafeInteger(Number(entry?.amount)) || Number(entry.amount) <= 0)
      || (entries[entries.length - 1]?.amount != null
        && (!Number.isSafeInteger(Number(entries[entries.length - 1].amount)) || Number(entries[entries.length - 1].amount) <= 0))) {
      throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'Enter a positive whole-RWF amount for each guest and choose each guest only once.', 400);
    }
  }
  const order = await posOrderService.claimBill(
    companyId,
    orderId,
    actor,
    `restaurant-bill-issued-${orderId}`,
  );
  const checkoutLines = buildCheckoutLines(order);
  let guestCount = Number(req.body?.guestCount);
  let checkPlans;
  if (splitType === 'item') {
    if (!Number.isInteger(guestCount)) {
      guestCount = Math.max(0, ...(Array.isArray(req.body?.checks)
        ? req.body.checks.map((check) => Number(check?.guestNumber) || 0)
        : []));
    }
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS) {
      throw fail('RESTAURANT_BILL_SPLIT_INVALID', `Choose between 1 and ${MAX_GUESTS} guests.`, 400);
    }
    checkPlans = allocateItemsToChecks(req.body?.checks, checkoutLines, guestCount)
      .map((check) => ({ checkNumber: check.guestNumber, guestNumber: check.guestNumber, lines: check.items }));
  } else {
    checkPlans = [{ checkNumber: 1, guestNumber: null, lines: checkoutLines }];
  }

  const createdChecks = [];
  for (const plan of checkPlans) {
    const planKey = splitType === 'item' ? `_${plan.guestNumber}` : '';
    const restaurantCheckout = {
      version: 1,
      orderId,
      orderVersion: order.version,
      lines: plan.lines.map((line) => ({
        itemId: line.itemId,
        productId: line.productId,
        quantity: line.quantity,
        stockMode: line.stockMode,
        barStockProductId: line.barStockProductId,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        serviceChargeExempt: line.serviceChargeExempt === true,
        promotionSnapshot: line.promotionSnapshot,
        discountPct: line.discountPct,
        description: line.description,
      })),
    };
    const pendingResult = await invokeController(
      posPaymentsV2Controller.createPendingSale,
      internalRequest(req, {
        key: `restaurant-bill-${orderId}${planKey}`,
        restaurantCheckout,
        body: {
          warehouseId: actor.branchId,
          paymentAmount: 0,
          payments: [],
          items: plan.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxCode: line.taxCode,
            taxRate: line.taxRate,
            description: line.description,
            discountPct: line.discountPct,
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
    createdChecks.push({
      ...plan,
      invoice,
      invoiceId,
      totalAmount,
      lineSnapshot: buildInvoiceLineSnapshot(invoice, plan.lines),
    });
  }

  if (serviceChargeSettings) {
    const savedCharges = createdChecks.map((check) => (
      jsonValue(check.invoice.posCheckoutPayload, {})?.restaurantCheckoutSnapshot?.serviceCharge || null
    ));
    if (savedCharges.some(Boolean) && savedCharges.some((charge) => !charge)) {
      throw fail('RESTAURANT_SERVICE_CHARGE_RETRY_CONFLICT', 'The saved split checks have inconsistent service-charge snapshots. Ask a manager to review them.', 409);
    }
    if (savedCharges.every(Boolean)) {
      createdChecks.forEach((check, index) => {
        check.serviceCharge = savedCharges[index];
        check.lineSnapshot.serviceCharge = savedCharges[index];
      });
    } else {
      const calculation = chargeRules.calculateServiceChargeByCheck(
        createdChecks.map((check) => ({
          lines: (check.invoice.lines || [])
            .filter((line) => line.isServiceLine !== true)
            .map((line) => ({
              lineSubtotal: Number(line.lineSubtotal || 0),
              discountAmount: roundMoney(
                Number(line.lineSubtotal || 0) * Number(line.discountPct || 0) / 100,
              ),
              serviceChargeExempt: line.serviceChargeExempt === true
                || check.lineSnapshot.items.find((item) => item.productId === String(line.productId))?.serviceChargeExempt === true,
            })),
        })),
        serviceChargeSettings.serviceChargeRatePct,
        serviceChargeSettings.serviceChargeMode,
      );
      await prisma.$transaction(async (tx) => {
        for (const [index, check] of createdChecks.entries()) {
          const amountRwf = calculation.allocations[index];
          const expected = serviceChargeLineSnapshot(
            serviceChargeSettings,
            serviceChargeTaxClass,
            amountRwf,
            serviceChargeOverride,
          );
          const updatedInvoice = await applyServiceChargeToInvoice(tx, companyId, check.invoice, {
            settings: serviceChargeSettings,
            taxClass: serviceChargeTaxClass,
            amountRwf,
            taxAmountRwf: expected.taxAmountRwf,
            override: serviceChargeOverride,
          });
          check.invoice = updatedInvoice;
          check.serviceCharge = updatedInvoice.restaurantServiceCharge || expected;
          check.totalAmount = Number(updatedInvoice.totalAmount);
          if (!Number.isSafeInteger(check.totalAmount) || check.totalAmount < 0) {
            throw fail(
              'POS_FISCAL_ROUNDING_POLICY_UNRESOLVED',
              'This invoice has a fractional RWF total. Payment is blocked until the fiscal rounding policy is approved.',
              409,
            );
          }
          check.lineSnapshot = buildInvoiceLineSnapshot(updatedInvoice, check.lines);
        }
      });
    }
  }

  if (splitType === 'equal') {
    guestCount = Number(req.body?.guestCount);
    createdChecks[0].payerAllocations = allocateEqualRwf(createdChecks[0].totalAmount, guestCount);
  } else if (splitType === 'amount') {
    const entries = req.body?.payerAllocations;
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > MAX_GUESTS) {
      throw fail('RESTAURANT_BILL_SPLIT_INVALID', `Choose between 2 and ${MAX_GUESTS} guests for a custom split.`, 400);
    }
    const totalAmount = createdChecks[0].totalAmount;
    const allocations = entries.map((entry, index) => {
      const guestNumber = Number(entry?.guestNumber ?? index + 1);
      const amount = index === entries.length - 1
        ? totalAmount - entries.slice(0, -1).reduce((sum, prior) => sum + Number(prior?.amount || 0), 0)
        : Number(entry?.amount);
      if (!Number.isInteger(guestNumber) || guestNumber < 1 || guestNumber > MAX_GUESTS
        || !Number.isSafeInteger(amount) || amount <= 0) {
        throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'Enter a positive whole-RWF amount for each guest.', 400);
      }
      if (index === entries.length - 1 && entry?.amount != null && Number(entry.amount) !== amount) {
        throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'The last guest must pay the exact remaining balance.', 400);
      }
      return { guestNumber, amount };
    });
    if (new Set(allocations.map((entry) => entry.guestNumber)).size !== allocations.length
      || allocations.reduce((sum, entry) => sum + entry.amount, 0) !== totalAmount) {
      throw fail('RESTAURANT_BILL_SPLIT_INVALID', 'Guest amounts must add up exactly to the bill total.', 400);
    }
    createdChecks[0].payerAllocations = allocations;
  } else {
    createdChecks[0].payerAllocations = [];
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const check of createdChecks) {
      const itemSubtotal = roundMoney(check.lineSnapshot.items.reduce((sum, line) => sum + line.subtotal, 0));
      const itemTaxAmount = roundMoney(check.lineSnapshot.items.reduce((sum, line) => sum + line.taxAmount, 0));
      const serviceCharge = check.serviceCharge || null;
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_bills (id, company_id, order_id, check_number, guest_number, invoice_id, version, status, split_type, subtotal, tax_amount, total_amount, service_charge_amount, service_charge_tax_amount, service_charge_rate_pct, service_charge_mode, service_charge_taxable, service_charge_tax_rate_id, service_charge_override_reason, service_charge_overridden_by_id, service_charge_overridden_at, line_snapshot, payer_allocations, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15, $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23, $24, $24)',
        generateObjectId(),
        companyId,
        orderId,
        check.checkNumber,
        check.guestNumber,
        check.invoiceId,
        'pending_payment',
        splitType,
        itemSubtotal,
        itemTaxAmount,
        check.totalAmount,
        Number(serviceCharge?.amountRwf || 0),
        Number(serviceCharge?.taxAmountRwf || 0),
        serviceCharge?.ratePct ?? null,
        serviceCharge?.mode || 'off',
        serviceCharge?.taxable === true,
        serviceCharge?.taxRateId || null,
        serviceCharge?.overrideReason || null,
        serviceCharge?.overriddenById || null,
        serviceCharge?.overrideReason ? now : null,
        JSON.stringify(check.lineSnapshot),
        JSON.stringify(check.payerAllocations || []),
        actor.userId,
        now,
      );
    }
    if (serviceChargeOverride) {
      await writePosAuditLog({
        companyId,
        registerId: actor.registerId,
        userId: actor.userId,
        event: 'RESTAURANT_SERVICE_CHARGE_OVERRIDDEN',
        metadata: {
          orderId,
          splitType,
          checkIds: createdChecks.map((check) => check.invoiceId),
          reason: serviceChargeOverride.reason,
          ratePct: serviceChargeOverride.ratePct,
          serviceChargeAmounts: createdChecks.map((check) => ({
            checkNumber: check.checkNumber,
            amountRwf: Number(check.serviceCharge?.amountRwf || 0),
          })),
        },
        ip: requestIp(req),
      }, tx);
    }
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
  if (allocations.reduce((sum, payment) => sum + payment.amount, 0) > requiredAmount) {
    throw fail('RESTAURANT_BILL_OVERPAYMENT', 'Payment allocations cannot exceed the remaining bill balance.', 400);
  }
  return allocations;
}

async function linkBillPayments(companyId, bill, payments, payerNumber) {
  if (!payments.length) return;
  await prisma.$transaction(async (tx) => {
    for (const payment of payments) {
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_bill_payments (id, company_id, bill_id, payment_id, payer_number, amount) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (payment_id) DO NOTHING',
        generateObjectId(),
        companyId,
        bill.id,
        String(payment.id),
        payerNumber,
        Number(payment.amount),
      );
      const linked = await tx.$queryRawUnsafe(
        'SELECT bill_id AS "billId", payer_number AS "payerNumber" FROM restaurant_bill_payments WHERE company_id = $1 AND payment_id = $2 LIMIT 1',
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
  const requestKey = idempotencyKeyFor(req);
  if (actor.trainingMode) {
    throw fail('RESTAURANT_TRAINING_ORDER', 'Training orders cannot be billed as real sales.', 409);
  }
  const bill = await findBillById(companyId, billId);
  if (!bill) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This Restaurant bill is not available in this company.', 404);
  if (bill.status !== 'pending_payment') {
    throw fail('RESTAURANT_BILL_NOT_PAYABLE', 'This check is not ready to accept payment. Refresh and ask a manager if it remains blocked.', 409);
  }

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
  const paymentLinkRows = await dbClient().$queryRawUnsafe(
    'SELECT payment_id AS "paymentId", lock_released_at AS "lockReleasedAt" FROM restaurant_bill_payments WHERE company_id = $1 AND bill_id = $2',
    companyId,
    bill.id,
  );
  const paymentLinks = new Map(paymentLinkRows.map((entry) => [String(entry.paymentId), entry]));
  if (existingPayments.some((payment) => (
    ['FAILED', 'CANCELLED', 'VOIDED'].includes(payment.status)
    && !paymentLinks.get(String(payment.id))?.lockReleasedAt
  ))) {
    throw fail('RESTAURANT_BILL_PAYMENT_LOCKED', 'Ask a manager to cancel the failed payment attempt before retrying this check.', 409);
  }
  const paidAmount = existingPayments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  if (paidAmount > totalAmount) {
    throw fail('RESTAURANT_BILL_OVERPAID', 'The POS payments exceed this bill total. Ask a manager to reconcile the sale.', 409);
  }

  const payerNumber = Number(req.body?.payerNumber ?? 1);
  if (!Number.isInteger(payerNumber) || payerNumber < 1 || payerNumber > MAX_GUESTS) {
    throw fail('RESTAURANT_BILL_PAYER_INVALID', 'Choose a guest number from 1 to 20.', 400);
  }
  if (bill.splitType === 'item' && Number(bill.guestNumber) !== payerNumber) {
    throw fail('RESTAURANT_BILL_PAYER_INVALID', 'Pay this item check using the guest number shown on the check.', 400);
  }
  let payerBalance = totalAmount - paidAmount;
  const payerAllocations = jsonValue(bill.payerAllocations, []);
  if (bill.splitType === 'equal' || bill.splitType === 'amount') {
    const allocation = payerAllocations.find((entry) => Number(entry.guestNumber ?? entry.payerNumber) === payerNumber);
    if (!allocation) {
      throw fail('RESTAURANT_BILL_PAYER_INVALID', 'Choose a guest with an amount assigned to this bill.', 400);
    }
    const payerPaidRows = await dbClient().$queryRawUnsafe(
      'SELECT COALESCE(SUM(p.amount), 0)::text AS amount FROM restaurant_bill_payments bp JOIN pos_payments p ON p.company_id = bp.company_id AND p.id = bp.payment_id WHERE bp.company_id = $1 AND bp.bill_id = $2 AND bp.payer_number = $3 AND p.status = $4::"PosPaymentStatus"',
      companyId,
      bill.id,
      payerNumber,
      'SUCCESS',
    );
    payerBalance = Number(allocation.amount) - Number(payerPaidRows[0]?.amount || 0);
    if (!Number.isSafeInteger(payerBalance) || payerBalance < 0) {
      throw fail('RESTAURANT_BILL_OVERPAID', 'This guest has already paid more than their assigned share.', 409);
    }
  }
  if (paidAmount < totalAmount) {
    const allocations = normalizeAllocations(
      req.body?.payments,
      availability.enabledMethods,
      Math.min(totalAmount - paidAmount, payerBalance),
    );
    const mobilePayment = allocations.length === 1 && MOBILE_MONEY_METHODS.has(allocations[0].method);
    const paymentRequestKey = `restaurant_bill_${bill.id}_${crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 32)}`;
    await invokeController(
      mobilePayment ? posPaymentsV2Controller.recordPayment : posPaymentsV2Controller.recordCashPayment,
      internalRequest(req, {
        key: paymentRequestKey,
        params: { saleId: String(bill.invoiceId) },
        body: mobilePayment ? allocations[0] : { payments: allocations },
      }),
    );
  }

  const payments = await loadPayments(companyId, String(bill.invoiceId));
  await linkBillPayments(companyId, bill, payments, payerNumber);
  if (payments.some((payment) => UNRESOLVED_PAYMENT_STATUSES.has(payment.status))) {
    throw fail('POS_PAYMENT_METHOD_UNRESOLVED', 'The payment is waiting for confirmation. Resolve it before completing the bill.', 409);
  }
  const confirmedAmount = payments
    .filter((payment) => payment.status === 'SUCCESS')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  if (confirmedAmount > totalAmount) {
    throw fail('RESTAURANT_BILL_OVERPAID', 'The POS payments exceed this bill total. Ask a manager to reconcile the sale.', 409);
  }
  await linkBillPayments(
    companyId,
    bill,
    payments.filter((payment) => payment.status === 'SUCCESS'),
    payerNumber,
  );
  if (confirmedAmount < totalAmount) {
    return getBill(companyId, String(bill.orderId), req);
  }

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

  let allChecksPaid = false;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'UPDATE restaurant_bills SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND id = $3 AND status <> $1',
      'paid',
      companyId,
      bill.id,
    );
    const rows = await tx.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = $1)::int AS paid FROM restaurant_bills WHERE company_id = $2 AND order_id = $3',
      'paid',
      companyId,
      String(bill.orderId),
    );
    allChecksPaid = Number(rows[0]?.total || 0) > 0 && Number(rows[0]?.total) === Number(rows[0]?.paid);
    if (allChecksPaid) {
      await posOrderService.markBillPaid(
        tx,
        companyId,
        String(bill.orderId),
        actor,
        `restaurant-bill-paid-${bill.orderId}`,
      );
    }
  });
  const finalBill = await getBill(companyId, String(bill.orderId), req);
  return {
    ...finalBill,
    checks: finalBill.checks.map((check) => check.id === String(bill.id) ? {
      ...check,
      receiptNumber: completedInvoice.referenceNo || check.receiptNumber,
      invoiceStatus: completedInvoice.status || check.invoiceStatus,
    } : check),
    receiptNumber: completedInvoice.referenceNo || finalBill.receiptNumber,
    invoiceStatus: completedInvoice.status || finalBill.invoiceStatus,
    allChecksPaid,
  };
}

module.exports = {
  buildCheckoutLines,
  getBill,
  issueBill,
  moveItemsBetweenChecks,
  normalizeAllocations,
  releaseFailedPaymentLock,
  settleBill,
};

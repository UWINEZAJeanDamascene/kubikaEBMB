'use strict';

const { createHash, randomBytes } = require('crypto');
const { Prisma } = require('@prisma/client');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { generateObjectId } = require('../utils/objectId');
const { calculatePosPricing } = require('./posPricingAllocationService');
const { writePosAuditLog, writePosDenialAudit } = require('./posAuditService');

const CODE_PATTERN = /^[A-Z0-9-]{8,50}$/;
const VOUCHER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_BULK_COUNT = 500;
const USAGE_STATUSES = ['RESERVED', 'REDEEMED'];

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function generateCode() {
  const bytes = randomBytes(10);
  const value = Array.from(bytes, (byte) => VOUCHER_CODE_ALPHABET[byte & 31]).join('');
  return `VCH-${value.slice(0, 5)}-${value.slice(5)}`;
}

function parseKigaliDate(value, isEnd = false) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00+02:00`);
    if (isEnd) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  return new Date(raw);
}

function cleanIds(value, label) {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (ids.length > 500) throw Object.assign(new Error(`${label} cannot contain more than 500 entries.`), { code: 'POS_VOUCHER_RULES_INVALID' });
  if (ids.some((id) => !/^[0-9a-f]{24}$/i.test(id))) {
    throw Object.assign(new Error(`${label} contains an invalid identifier.`), { code: 'POS_VOUCHER_RULES_INVALID' });
  }
  return ids;
}

function prepareVoucherRules(input, { bulk = false } = {}) {
  const name = String(input.name || '').trim();
  const discountType = String(input.discountType || '').toLowerCase();
  const value = Number(input.value);
  const maxDiscountRwf = input.maxDiscountRwf == null || input.maxDiscountRwf === ''
    ? null
    : Number(input.maxDiscountRwf);
  const minSpendRwf = Number(input.minSpendRwf ?? 0);
  const totalUsageLimit = bulk || input.singleUse === true
    ? 1
    : input.totalUsageLimit == null || input.totalUsageLimit === '' ? null : Number(input.totalUsageLimit);
  const perCustomerUsageLimit = input.perCustomerUsageLimit == null || input.perCustomerUsageLimit === ''
    ? null
    : Number(input.perCustomerUsageLimit);
  const startsAt = parseKigaliDate(input.startsAt);
  const endsAt = parseKigaliDate(input.endsAt, true);

  if (name.length < 2 || name.length > 120
    || !['percent', 'fixed'].includes(discountType)
    || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER
    || (discountType === 'percent' && value > 100)
    || (discountType === 'fixed' && !Number.isSafeInteger(value))
    || (maxDiscountRwf !== null && (!Number.isSafeInteger(maxDiscountRwf) || maxDiscountRwf <= 0 || discountType !== 'percent'))
    || !Number.isSafeInteger(minSpendRwf) || minSpendRwf < 0
    || (totalUsageLimit !== null && (!Number.isSafeInteger(totalUsageLimit) || totalUsageLimit < 1))
    || (perCustomerUsageLimit !== null && (!Number.isSafeInteger(perCustomerUsageLimit) || perCustomerUsageLimit < 1))
    || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw Object.assign(new Error('Enter valid voucher details, discount rules, and a Kigali validity date range.'), { code: 'POS_VOUCHER_RULES_INVALID' });
  }
  if (startsAt.getTime() <= Date.now() && endsAt.getTime() <= Date.now()) {
    throw Object.assign(new Error('Voucher end date must be in the future.'), { code: 'POS_VOUCHER_DATE_EXPIRED' });
  }

  const customerIds = cleanIds(input.customerIds, 'Customer restrictions');
  const excludedProductIds = cleanIds(input.excludedProductIds, 'Excluded products');
  const excludedCategoryIds = cleanIds(input.excludedCategoryIds, 'Excluded categories');
  const customerGroupTags = [...new Set((Array.isArray(input.customerGroupTags) ? input.customerGroupTags : [])
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter(Boolean))];
  if (customerGroupTags.length > 100 || customerGroupTags.some((tag) => tag.length > 80)) {
    throw Object.assign(new Error('Customer-group restrictions are invalid.'), { code: 'POS_VOUCHER_RULES_INVALID' });
  }

  return {
    name,
    discountType,
    value,
    maxDiscountRwf,
    minSpendRwf,
    totalUsageLimit,
    perCustomerUsageLimit,
    singleUse: bulk || input.singleUse === true,
    canCombineWithDiscounts: input.canCombineWithDiscounts === true,
    startsAt,
    endsAt,
    customerIds,
    customerGroupTags,
    excludedProductIds,
    excludedCategoryIds,
  };
}

function voucherApi(row, counts = {}) {
  return {
    _id: row.id,
    batchId: row.batchId || null,
    code: `****${row.codeSuffix}`,
    name: row.name,
    discountType: row.discountType,
    value: Number(row.value),
    maxDiscountRwf: row.maxDiscountRwf,
    minSpendRwf: row.minSpendRwf,
    totalUsageLimit: row.totalUsageLimit,
    perCustomerUsageLimit: row.perCustomerUsageLimit,
    singleUse: row.singleUse,
    canCombineWithDiscounts: row.canCombineWithDiscounts,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    customerIds: Array.isArray(row.customerIds) ? row.customerIds : [],
    customerGroupTags: Array.isArray(row.customerGroupTags) ? row.customerGroupTags : [],
    excludedProductIds: Array.isArray(row.excludedProductIds) ? row.excludedProductIds : [],
    excludedCategoryIds: Array.isArray(row.excludedCategoryIds) ? row.excludedCategoryIds : [],
    status: row.status,
    redeemedCount: counts.redeemedCount || 0,
    reservedCount: counts.reservedCount || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function writeAudit(companyId, userId, event, metadata = {}, client) {
  const entry = {
    companyId,
    userId,
    event,
    metadata,
  };
  const writer = event === 'VOUCHER_INVALID_ATTEMPT' ? writePosDenialAudit : writePosAuditLog;
  await (client ? writer(entry, client) : writer(entry));
}

async function getVoucher(companyId, voucherId, client = dbClient()) {
  return client.posVoucher.findFirst({ where: { id: String(voucherId), companyId: String(companyId) } });
}

async function listVouchers(companyId, { status, search, limit = 100, offset = 0 } = {}) {
  const where = {
    companyId: String(companyId),
    ...(status ? { status: String(status).toUpperCase() } : {}),
    ...(search ? { name: { contains: String(search).trim(), mode: 'insensitive' } } : {}),
  };
  const rows = await dbClient().posVoucher.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(200, Math.max(1, Number(limit) || 100)),
    skip: Math.max(0, Number(offset) || 0),
  });
  const counts = rows.length ? await dbClient().posVoucherRedemption.groupBy({
    by: ['voucherId', 'status'],
    where: {
      companyId: String(companyId),
      voucherId: { in: rows.map((row) => row.id) },
      status: { in: USAGE_STATUSES },
    },
    _count: { _all: true },
  }) : [];
  const byVoucher = new Map();
  for (const count of counts) {
    const current = byVoucher.get(String(count.voucherId)) || { redeemedCount: 0, reservedCount: 0 };
    if (count.status === 'REDEEMED') current.redeemedCount = count._count._all;
    if (count.status === 'RESERVED') current.reservedCount = count._count._all;
    byVoucher.set(String(count.voucherId), current);
  }
  return rows.map((row) => voucherApi(row, byVoucher.get(String(row.id))));
}

async function createVouchers(companyId, userId, input, count = 1) {
  const bulk = count > 1;
  const rules = prepareVoucherRules(input, { bulk });
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BULK_COUNT) {
    throw Object.assign(new Error(`Generate between 1 and ${MAX_BULK_COUNT} voucher codes at a time.`), { code: 'POS_VOUCHER_BULK_COUNT_INVALID' });
  }
  const batchId = bulk ? generateObjectId() : null;
  const records = Array.from({ length: count }, () => {
    const code = generateCode();
    return {
      data: {
        id: generateObjectId(),
        companyId: String(companyId),
        batchId,
        codeHash: hash(normalizeCode(code)),
        codeSuffix: code.slice(-4),
        ...rules,
        createdById: String(userId),
      },
      code,
    };
  });

  const rows = await dbClient().$transaction(async (tx) => {
    const created = [];
    for (const record of records) {
      created.push(await tx.posVoucher.create({ data: record.data }));
    }
    await writeAudit(companyId, userId, bulk ? 'VOUCHER_BULK_GENERATED' : 'VOUCHER_CREATED', {
      count, batchId, voucherIds: created.map((row) => row.id),
    }, tx);
    return created;
  });
  return rows.map((row, index) => ({ voucher: voucherApi(row), code: records[index].code }));
}

async function updateVoucher(companyId, userId, voucherId, input) {
  const row = await runInTransaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id FROM pos_vouchers
      WHERE id = ${String(voucherId)} AND company_id = ${String(companyId)}
      FOR UPDATE
    `;
    if (!locked.length) throw Object.assign(new Error('Voucher was not found.'), { code: 'POS_VOUCHER_NOT_FOUND' });
    const existing = await getVoucher(companyId, voucherId, tx);
    if (existing.status === 'CANCELLED') throw Object.assign(new Error('Cancelled vouchers cannot be edited.'), { code: 'POS_VOUCHER_CANCELLED' });
    const rules = prepareVoucherRules({ ...existing, ...input });
    const usage = await tx.posVoucherRedemption.count({
      where: { companyId: String(companyId), voucherId: existing.id, status: { in: USAGE_STATUSES } },
    });
    if (rules.totalUsageLimit !== null && rules.totalUsageLimit < usage) {
      throw Object.assign(new Error('The total-use limit cannot be lower than uses and reservations already recorded.'), { code: 'POS_VOUCHER_LIMIT_BELOW_USAGE' });
    }
    const updated = await tx.posVoucher.update({
      where: { id: existing.id },
      data: { ...rules, updatedById: String(userId) },
    });
    await writeAudit(companyId, userId, 'VOUCHER_UPDATED', { voucherId: updated.id }, tx);
    return updated;
  });
  return voucherApi(row);
}

async function setVoucherStatus(companyId, userId, voucherId, status) {
  const normalized = String(status || '').toUpperCase();
  if (!['ACTIVE', 'PAUSED', 'CANCELLED'].includes(normalized)) {
    throw Object.assign(new Error('Voucher status must be ACTIVE, PAUSED, or CANCELLED.'), { code: 'POS_VOUCHER_STATUS_INVALID' });
  }
  const row = await runInTransaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id FROM pos_vouchers
      WHERE id = ${String(voucherId)} AND company_id = ${String(companyId)}
      FOR UPDATE
    `;
    if (!locked.length) throw Object.assign(new Error('Voucher was not found.'), { code: 'POS_VOUCHER_NOT_FOUND' });
    const existing = await getVoucher(companyId, voucherId, tx);
    if (existing.status === 'CANCELLED' && normalized !== 'CANCELLED') {
      throw Object.assign(new Error('Cancelled vouchers cannot be reactivated.'), { code: 'POS_VOUCHER_CANCELLED' });
    }
    const updated = await tx.posVoucher.update({
      where: { id: existing.id },
      data: { status: normalized, updatedById: String(userId) },
    });
    if (normalized !== 'ACTIVE') {
      const released = await tx.posVoucherRedemption.updateMany({
        where: { companyId: String(companyId), voucherId: existing.id, status: 'RESERVED' },
        data: { status: 'RELEASED' },
      });
      if (released.count) {
        await writeAudit(companyId, userId, 'VOUCHER_RESERVATION_RELEASED', {
          voucherId: existing.id,
          count: released.count,
          reason: normalized,
        }, tx);
      }
    }
    await writeAudit(companyId, userId, normalized === 'PAUSED' ? 'VOUCHER_PAUSED' : normalized === 'CANCELLED' ? 'VOUCHER_CANCELLED' : 'VOUCHER_ACTIVATED', {
      voucherId: updated.id,
    }, tx);
    return updated;
  });
  return voucherApi(row);
}

async function getRedemptionHistory(companyId, voucherId, { limit = 100, offset = 0 } = {}) {
  const rows = await dbClient().posVoucherRedemption.findMany({
    where: { companyId: String(companyId), voucherId: String(voucherId) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, Number(limit) || 100)),
    skip: Math.max(0, Number(offset) || 0),
  });
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    cashierId: row.cashierId,
    tillSessionId: row.tillSessionId,
    invoiceId: row.invoiceId,
    code: `****${row.codeSuffix}`,
    status: row.status,
    discountRwf: row.discountRwf,
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    restoredAt: row.restoredAt,
    restoredById: row.restoredById,
    restoreReason: row.restoreReason,
    createdAt: row.createdAt,
  }));
}

function canonicalCart({
  items,
  cartDiscountPct = 0,
  cartDiscountReason = '',
  promotionId = '',
  clientId = '',
  warehouseId = '',
}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    throw Object.assign(new Error('Add between 1 and 500 sale items before applying a voucher.'), { code: 'POS_VOUCHER_CART_INVALID' });
  }
  return {
    items: items.map((item) => ({
      productId: String(item.productId || ''),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      catalogUnitPrice: Number(item.catalogUnitPrice ?? item.unitPrice),
      discountPct: Number(item.discountPct || 0),
      discountReason: String(item.discountReason || ''),
    })),
    cartDiscountPct: Number(cartDiscountPct || 0),
    cartDiscountReason: String(cartDiscountReason || ''),
    promotionId: String(promotionId || ''),
    clientId: String(clientId || ''),
    warehouseId: String(warehouseId || ''),
  };
}

function cartHash(cart) {
  return hash(JSON.stringify(cart));
}

function buildPricing({ cart, productsById, voucher, vouchers = null }) {
  const lines = [];
  const lineDiscounts = [];
  const cartDiscounts = [];
  const voucherRows = Array.isArray(vouchers) ? vouchers : [voucher];

  for (const [index, item] of cart.items.entries()) {
    const product = productsById.get(item.productId);
    if (!product || product.isActive === false) {
      throw Object.assign(new Error('A cart item is no longer available. Refresh and retry.'), { code: 'POS_VOUCHER_PRODUCT_UNAVAILABLE' });
    }
    const price = Number(product.price);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(Math.round(price)) || price < 0
      || !Number.isFinite(item.unitPrice) || Math.abs(item.unitPrice - price) > 0.000001
      || Math.abs(item.catalogUnitPrice - price) > 0.000001) {
      throw Object.assign(new Error('A product price changed. Refresh the cart before applying the voucher.'), { code: 'POS_PRICE_CHANGED' });
    }
    const lineId = String(index);
    const discountEligible = product.isNoDiscount !== true && product.category?.isNoDiscount !== true;
    lines.push({
      id: lineId,
      quantity: item.quantity,
      unitPriceRwf: Math.round(price),
      discountEligible,
      taxClass: product.taxCode || null,
    });
    if (item.discountPct > 0) {
      lineDiscounts.push({
        id: `manual-${lineId}`,
        lineId,
        type: 'percent',
        value: item.discountPct,
        reason: item.discountReason || 'Manual discount',
      });
    }
  }

  if (cart.cartDiscountPct > 0) {
    cartDiscounts.push({
      id: 'cart-discount',
      type: 'percent',
      value: cart.cartDiscountPct,
      reason: cart.cartDiscountReason || 'Cart discount',
    });
  }
  if (cart.promotionId) {
    const promotion = cart.promotion;
    if (!promotion) throw Object.assign(new Error('This promotion is no longer active.'), { code: 'POS_PROMOTION_UNAVAILABLE' });
    cartDiscounts.push({
      id: 'promotion',
      type: promotion.discountType,
      value: Number(promotion.value),
      reason: 'Promotion',
    });
  }

  const pricing = calculatePosPricing({
    lines,
    lineDiscounts,
    cartDiscounts,
    voucher: voucherRows.map((row) => ({
      id: row.id,
      name: row.name,
      maskedCode: `****${row.codeSuffix}`,
      type: row.discountType,
      value: Number(row.value),
      maxDiscountRwf: row.maxDiscountRwf,
      minSpendRwf: row.minSpendRwf,
      canCombineWithDiscounts: row.canCombineWithDiscounts,
      excludedLineIds: cart.items.flatMap((item, index) => {
        const product = productsById.get(item.productId);
        const categoryId = String(product?.category?._id || product?.category || '');
        return (Array.isArray(row.excludedProductIds) && row.excludedProductIds.includes(item.productId))
          || (Array.isArray(row.excludedCategoryIds) && row.excludedCategoryIds.includes(categoryId))
          ? [String(index)]
          : [];
      }),
    })),
  });
  return pricing;
}

async function loadVoucherByCode(companyId, code, client = dbClient()) {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) return null;
  return client.posVoucher.findFirst({
    where: { companyId: String(companyId), codeHash: hash(normalized) },
  });
}

async function checkCustomerEligibility(companyId, voucher, clientId, client = dbClient()) {
  const customerIds = Array.isArray(voucher.customerIds) ? voucher.customerIds.map(String) : [];
  const groupTags = Array.isArray(voucher.customerGroupTags) ? voucher.customerGroupTags.map((tag) => String(tag).toLowerCase()) : [];
  const requiresCustomer = customerIds.length > 0 || groupTags.length > 0 || voucher.perCustomerUsageLimit != null;
  if (!clientId || clientId === 'walk-in') {
    if (requiresCustomer) throw Object.assign(new Error('Select a named customer to use this voucher.'), { code: 'POS_VOUCHER_CUSTOMER_REQUIRED' });
    return null;
  }
  const customer = await client.client.findFirst({
    where: { id: String(clientId), companyId: String(companyId), isActive: true },
    select: { id: true, isWalkIn: true, groupTag: true },
  });
  if (!customer || customer.isWalkIn) {
    if (requiresCustomer) throw Object.assign(new Error('Select a registered customer to use this voucher.'), { code: 'POS_VOUCHER_CUSTOMER_REQUIRED' });
    return null;
  }
  if (customerIds.length && !customerIds.includes(String(customer.id))) {
    throw Object.assign(new Error('This voucher is not available to the selected customer.'), { code: 'POS_VOUCHER_CUSTOMER_NOT_ELIGIBLE' });
  }
  if (groupTags.length && !groupTags.includes(String(customer.groupTag || '').toLowerCase())) {
    throw Object.assign(new Error('This voucher is not available to the selected customer group.'), { code: 'POS_VOUCHER_CUSTOMER_NOT_ELIGIBLE' });
  }
  return customer;
}

async function voucherSettings(companyId, client = dbClient()) {
  const row = await client.systemSettings.findUnique({
    where: { companyId: String(companyId) },
    select: { posVoucherSettings: true },
  });
  return {
    maxVouchersPerSale: Math.max(1, Math.min(10, Number(row?.posVoucherSettings?.maxVouchersPerSale) || 1)),
    reservationTtlMinutes: Math.max(1, Math.min(60, Number(row?.posVoucherSettings?.reservationTtlMinutes) || 15)),
    invalidAttemptsBeforeLockout: Math.max(3, Math.min(20, Number(row?.posVoucherSettings?.invalidAttemptsBeforeLockout) || 5)),
    lockoutMinutes: Math.max(1, Math.min(60, Number(row?.posVoucherSettings?.lockoutMinutes) || 15)),
  };
}

async function updateVoucherSettings(companyId, userId, input) {
  const settings = {
    maxVouchersPerSale: Number(input?.maxVouchersPerSale),
    reservationTtlMinutes: Number(input?.reservationTtlMinutes),
    invalidAttemptsBeforeLockout: Number(input?.invalidAttemptsBeforeLockout),
    lockoutMinutes: Number(input?.lockoutMinutes),
  };
  if (!Number.isSafeInteger(settings.maxVouchersPerSale) || settings.maxVouchersPerSale < 1 || settings.maxVouchersPerSale > 10
    || !Number.isSafeInteger(settings.reservationTtlMinutes) || settings.reservationTtlMinutes < 1 || settings.reservationTtlMinutes > 60
    || !Number.isSafeInteger(settings.invalidAttemptsBeforeLockout) || settings.invalidAttemptsBeforeLockout < 3 || settings.invalidAttemptsBeforeLockout > 20
    || !Number.isSafeInteger(settings.lockoutMinutes) || settings.lockoutMinutes < 1 || settings.lockoutMinutes > 60) {
    throw Object.assign(new Error('Voucher limits must be valid whole numbers within the allowed ranges.'), { code: 'POS_VOUCHER_SETTINGS_INVALID' });
  }
  await dbClient().$transaction(async (tx) => {
    const before = await tx.systemSettings.findUnique({
      where: { companyId: String(companyId) },
      select: { posVoucherSettings: true },
    });
    await tx.systemSettings.update({
      where: { companyId: String(companyId) },
      data: { posVoucherSettings: settings },
    });
    await writeAudit(companyId, userId, 'VOUCHER_SETTINGS_UPDATED', {
      before: before?.posVoucherSettings || null,
      after: settings,
    }, tx);
  });
  return settings;
}

async function registerInvalidAttempt(companyId, cashierId, settings) {
  const now = new Date();
  const attempt = await runInTransaction(async (tx) => {
    const key = { companyId: String(companyId), cashierId: String(cashierId) };
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${key.companyId}:${key.cashierId}`}))::text AS locked`;
    const current = await tx.posVoucherCodeAttempt.findUnique({ where: { companyId_cashierId: key } });
    if (!current) {
      return tx.posVoucherCodeAttempt.create({
        data: { id: generateObjectId(), ...key, attemptCount: 1, windowStartedAt: now },
      });
    }
    if (current.lockedUntil && current.lockedUntil > now) return current;
    const windowExpired = now.getTime() - new Date(current.windowStartedAt).getTime() >= settings.lockoutMinutes * 60_000;
    const attemptCount = windowExpired ? 1 : current.attemptCount + 1;
    const lockedUntil = attemptCount >= settings.invalidAttemptsBeforeLockout
      ? new Date(now.getTime() + settings.lockoutMinutes * 60_000)
      : null;
    return tx.posVoucherCodeAttempt.update({
      where: { id: current.id },
      data: {
        attemptCount,
        windowStartedAt: windowExpired ? now : current.windowStartedAt,
        lockedUntil,
      },
    });
  });
  if (attempt.lockedUntil && attempt.lockedUntil > now) {
    throw Object.assign(new Error(`Too many invalid voucher codes. Try again after ${attempt.lockedUntil.toISOString()}.`), { code: 'POS_VOUCHER_LOOKUP_LOCKED' });
  }
}

async function reserveVoucher(companyId, cashierId, { code, cartInput, productsById, tillSessionId, existingReservationTokens = [] }) {
  const settings = await voucherSettings(companyId);
  const attempt = await dbClient().posVoucherCodeAttempt.findUnique({
    where: { companyId_cashierId: { companyId: String(companyId), cashierId: String(cashierId) } },
  });
  if (attempt?.lockedUntil && attempt.lockedUntil > new Date()) {
    throw Object.assign(new Error(`Voucher lookup is locked until ${attempt.lockedUntil.toISOString()}.`), { code: 'POS_VOUCHER_LOOKUP_LOCKED' });
  }
  const voucher = await loadVoucherByCode(companyId, code);
  if (!voucher) {
    let lockoutError = null;
    try {
      await registerInvalidAttempt(companyId, cashierId, settings);
    } catch (error) {
      lockoutError = error;
    }
    await writeAudit(companyId, cashierId, 'VOUCHER_INVALID_ATTEMPT', {
      result: 'NOT_FOUND',
      locked: lockoutError?.code === 'POS_VOUCHER_LOOKUP_LOCKED',
    });
    if (lockoutError) throw lockoutError;
    throw Object.assign(new Error('Voucher code is invalid or unavailable.'), { code: 'POS_VOUCHER_INVALID' });
  }
  const now = new Date();
  if (voucher.status !== 'ACTIVE' || voucher.startsAt > now || voucher.endsAt <= now) {
    throw Object.assign(new Error('This voucher is not currently active.'), { code: 'POS_VOUCHER_UNAVAILABLE' });
  }
  const cart = canonicalCart(cartInput);
  const keyHash = cartHash(cart);
  const existingTokens = [...new Set((Array.isArray(existingReservationTokens) ? existingReservationTokens : [])
    .map((token) => String(token || '').trim()).filter(Boolean))];
  if (existingTokens.length + 1 > settings.maxVouchersPerSale) {
    throw Object.assign(new Error(`A sale can use at most ${settings.maxVouchersPerSale} voucher(s).`), { code: 'POS_VOUCHER_SALE_LIMIT' });
  }
  const existingRedemptions = existingTokens.length ? await dbClient().posVoucherRedemption.findMany({
    where: {
      companyId: String(companyId),
      cashierId: String(cashierId),
      reservationTokenHash: { in: existingTokens.map(hash) },
      status: 'RESERVED',
      expiresAt: { gt: now },
      cartKeyHash: keyHash,
    },
  }) : [];
  if (existingRedemptions.length !== existingTokens.length) {
    throw Object.assign(new Error('An existing voucher reservation expired or no longer matches this cart.'), { code: 'POS_VOUCHER_RESERVATION_EXPIRED' });
  }
  const existingVouchers = await Promise.all(existingRedemptions.map((row) => getVoucher(companyId, row.voucherId)));
  if (existingVouchers.some((row) => !row || row.status !== 'ACTIVE' || row.endsAt <= now)
    || existingVouchers.some((row) => String(row.id) === String(voucher.id))) {
    throw Object.assign(new Error('An existing voucher is unavailable or already applied.'), { code: 'POS_VOUCHER_UNAVAILABLE' });
  }
  const voucherRows = [...existingVouchers, voucher];
  const customers = await Promise.all(voucherRows.map((row) => checkCustomerEligibility(companyId, row, cart.clientId)));
  const pricing = buildPricing({ cart: { ...cart, promotion: cartInput.promotion }, productsById, vouchers: voucherRows });
  const currentRedemption = pricing.voucherRedemptions.find((row) => String(row.voucherId) === String(voucher.id));
  const discountRwf = currentRedemption?.amountRwf || 0;
  if (!discountRwf) throw Object.assign(new Error('The voucher does not apply to the eligible items in this sale.'), { code: 'POS_VOUCHER_NO_ELIGIBLE_ITEMS' });
  const token = randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  const ttl = settings.reservationTtlMinutes * 60_000;

  const redemption = await runInTransaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${keyHash}))::text AS locked`;
    const lockedVoucherIds = [...new Set(voucherRows.map((row) => String(row.id)))].sort();
    for (const voucherId of lockedVoucherIds) {
      const locked = await tx.$queryRaw`
        SELECT id, status, starts_at AS "startsAt", ends_at AS "endsAt"
        FROM pos_vouchers
        WHERE id = ${voucherId} AND company_id = ${String(companyId)}
        FOR UPDATE
      `;
      if (!locked.length) throw Object.assign(new Error('A voucher is no longer available.'), { code: 'POS_VOUCHER_UNAVAILABLE' });
      if (locked[0].status !== 'ACTIVE' || locked[0].startsAt > now || locked[0].endsAt <= now) {
        throw Object.assign(new Error('A voucher is no longer active.'), { code: 'POS_VOUCHER_UNAVAILABLE' });
      }
    }
    for (const existingRedemption of [...existingRedemptions].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.$queryRaw`
        SELECT id FROM pos_voucher_redemptions
        WHERE id = ${String(existingRedemption.id)} AND company_id = ${String(companyId)}
        FOR UPDATE
      `;
    }
    const currentExistingRedemptions = existingRedemptions.length
      ? await tx.posVoucherRedemption.findMany({
        where: {
          id: { in: existingRedemptions.map((row) => row.id) },
          companyId: String(companyId),
          status: 'RESERVED',
          expiresAt: { gt: now },
          cartKeyHash: keyHash,
        },
      })
      : [];
    if (currentExistingRedemptions.length !== existingRedemptions.length) {
      throw Object.assign(new Error('An existing voucher reservation expired or no longer matches this cart.'), { code: 'POS_VOUCHER_RESERVATION_EXPIRED' });
    }
    const currentVouchers = await Promise.all(voucherRows.map((row) => getVoucher(companyId, row.id, tx)));
    const currentCustomers = await Promise.all(currentVouchers.map((row) => checkCustomerEligibility(companyId, row, cart.clientId)));
    const currentPricing = buildPricing({ cart: { ...cart, promotion: cartInput.promotion }, productsById, vouchers: currentVouchers });
    const currentDiscount = currentPricing.voucherRedemptions
      .find((row) => String(row.voucherId) === String(voucher.id))?.amountRwf || 0;
    if (!currentDiscount) {
      throw Object.assign(new Error('The voucher does not apply to the eligible items in this sale.'), { code: 'POS_VOUCHER_NO_ELIGIBLE_ITEMS' });
    }
    await tx.posVoucherRedemption.updateMany({
      where: {
        companyId: String(companyId),
        voucherId: String(voucher.id),
        status: 'RESERVED',
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
    const activeForCart = await tx.posVoucherRedemption.count({
      where: { companyId: String(companyId), cartKeyHash: keyHash, status: 'RESERVED', expiresAt: { gt: now } },
    });
    if (activeForCart >= settings.maxVouchersPerSale) {
      throw Object.assign(new Error(`A sale can use at most ${settings.maxVouchersPerSale} voucher(s).`), { code: 'POS_VOUCHER_SALE_LIMIT' });
    }
    const useCount = await tx.posVoucherRedemption.count({
      where: { companyId: String(companyId), voucherId: String(voucher.id), status: { in: USAGE_STATUSES } },
    });
    const currentVoucher = currentVouchers[currentVouchers.length - 1];
    if (currentVoucher.totalUsageLimit != null && useCount >= currentVoucher.totalUsageLimit) {
      throw Object.assign(new Error('This voucher has reached its total usage limit.'), { code: 'POS_VOUCHER_USAGE_LIMIT' });
    }
    const customer = currentCustomers[currentCustomers.length - 1];
    if (customer && currentVoucher.perCustomerUsageLimit != null) {
      const customerUseCount = await tx.posVoucherRedemption.count({
        where: {
          companyId: String(companyId),
          voucherId: String(voucher.id),
          clientId: String(customer.id),
          status: { in: USAGE_STATUSES },
        },
      });
      if (customerUseCount >= currentVoucher.perCustomerUsageLimit) {
        throw Object.assign(new Error('This customer has reached the voucher usage limit.'), { code: 'POS_VOUCHER_CUSTOMER_USAGE_LIMIT' });
      }
    }
    const created = await tx.posVoucherRedemption.create({
      data: {
        id: generateObjectId(),
        companyId: String(companyId),
        voucherId: String(voucher.id),
        clientId: customer?.id || null,
        cashierId: String(cashierId),
        tillSessionId: tillSessionId ? String(tillSessionId) : null,
        cartKeyHash: keyHash,
        reservationTokenHash: tokenHash,
        codeSuffix: currentVoucher.codeSuffix,
        status: 'RESERVED',
        discountRwf: currentDiscount,
        pricingSnapshot: currentPricing,
        expiresAt: new Date(now.getTime() + ttl),
      },
    });
    for (const [index, existingRedemption] of currentExistingRedemptions.entries()) {
      const existingQuote = currentPricing.voucherRedemptions.find(
        (row) => String(row.voucherId) === String(existingRedemption.voucherId),
      );
      await tx.posVoucherRedemption.update({
        where: { id: existingRedemption.id },
        data: {
          discountRwf: existingQuote?.amountRwf || 0,
          pricingSnapshot: currentPricing,
          clientId: currentCustomers[index]?.id || null,
        },
      });
    }
    await tx.posVoucherCodeAttempt.updateMany({
      where: { companyId: String(companyId), cashierId: String(cashierId) },
      data: { attemptCount: 0, lockedUntil: null, windowStartedAt: now },
    });
    await writeAudit(companyId, cashierId, 'VOUCHER_RESERVED', {
      voucherId: voucher.id,
      redemptionId: created.id,
      discountRwf: currentDiscount,
      expiresAt: created.expiresAt,
    }, tx);
    return created;
  });
  return {
    reservationToken: token,
    expiresAt: redemption.expiresAt,
    quote: {
      voucher: `****${voucher.codeSuffix}`,
      discountRwf,
      totalVoucherDiscountRwf: pricing.totals.voucherDiscountRwf,
      pricingSnapshot: pricing,
    },
  };
}

async function releaseReservation(companyId, cashierId, input) {
  const tokens = (Array.isArray(input) ? input : [input]).map((token) => String(token || '').trim()).filter(Boolean);
  if (!tokens.length) throw Object.assign(new Error('Provide at least one voucher reservation token.'), { code: 'POS_VOUCHER_RESERVATION_NOT_FOUND' });
  await runInTransaction(async (tx) => {
    const rows = await tx.posVoucherRedemption.updateMany({
      where: {
        companyId: String(companyId),
        cashierId: String(cashierId),
        reservationTokenHash: { in: tokens.map(hash) },
        status: 'RESERVED',
        invoiceId: null,
      },
      data: { status: 'RELEASED' },
    });
    if (rows.count !== tokens.length) throw Object.assign(new Error('One or more active voucher reservations were not found.'), { code: 'POS_VOUCHER_RESERVATION_NOT_FOUND' });
    await writeAudit(companyId, cashierId, 'VOUCHER_RESERVATION_RELEASED', { count: rows.count }, tx);
  });
  return true;
}

async function releaseInvoiceReservations(tx, companyId, invoiceId, userId) {
  const rows = await tx.posVoucherRedemption.updateMany({
    where: {
      companyId: String(companyId),
      invoiceId: String(invoiceId),
      status: 'RESERVED',
    },
    data: { status: 'RELEASED' },
  });
  if (rows.count) {
    await writeAudit(companyId, userId, 'VOUCHER_RESERVATION_RELEASED', {
      invoiceId: String(invoiceId),
      count: rows.count,
      reason: 'PENDING_SALE_CANCELLED',
    }, tx);
  }
  return rows.count;
}

async function getReservationPricing(client, companyId, cashierId, {
  tokens,
  token,
  invoiceId,
  cartInput,
  productsById,
  lockRows = false,
}) {
  const normalizedTokens = (Array.isArray(tokens) ? tokens : [token]).map((item) => String(item || '').trim()).filter(Boolean);
  if (!normalizedTokens.length && !invoiceId) return null;
  const where = {
    companyId: String(companyId),
    cashierId: String(cashierId),
    ...(normalizedTokens.length
      ? { reservationTokenHash: { in: normalizedTokens.map(hash) }, invoiceId: null }
      : { invoiceId: String(invoiceId) }),
    status: 'RESERVED',
  };
  if (lockRows) {
    const candidates = await client.posVoucherRedemption.findMany({
      where,
      select: { id: true, voucherId: true },
    });
    const voucherIds = [...new Set(candidates.map((row) => row.voucherId))].sort();
    const redemptionIds = candidates.map((row) => row.id).sort();
    if (voucherIds.length) {
      await client.$queryRaw`
        SELECT id FROM pos_vouchers
        WHERE company_id = ${String(companyId)} AND id IN (${Prisma.join(voucherIds)})
        ORDER BY id
        FOR UPDATE
      `;
    }
    if (redemptionIds.length) {
      await client.$queryRaw`
        SELECT id FROM pos_voucher_redemptions
        WHERE company_id = ${String(companyId)} AND id IN (${Prisma.join(redemptionIds)})
        ORDER BY id
        FOR UPDATE
      `;
    }
  }
  const redemptions = await client.posVoucherRedemption.findMany({
    where,
  });
  if ((normalizedTokens.length && redemptions.length !== normalizedTokens.length)
    || (!normalizedTokens.length && !redemptions.length)
    || redemptions.some((redemption) => redemption.expiresAt <= new Date())) {
    for (const redemption of redemptions.filter((item) => item.expiresAt <= new Date())) {
      await client.posVoucherRedemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } });
    }
    throw Object.assign(new Error('Voucher reservation expired. Apply the voucher again before completing this sale.'), { code: 'POS_VOUCHER_RESERVATION_EXPIRED' });
  }
  const vouchers = await Promise.all(redemptions.map((redemption) => getVoucher(companyId, redemption.voucherId, client)));
  if (vouchers.some((voucher) => !voucher || voucher.status !== 'ACTIVE' || voucher.endsAt <= new Date())) {
    throw Object.assign(new Error('Voucher is no longer active.'), { code: 'POS_VOUCHER_UNAVAILABLE' });
  }
  const cart = canonicalCart(cartInput);
  if (redemptions.some((redemption) => cartHash(cart) !== redemption.cartKeyHash)) {
    throw Object.assign(new Error('The cart changed after applying this voucher. Reapply the voucher.'), { code: 'POS_VOUCHER_CART_CHANGED' });
  }
  const customers = await Promise.all(vouchers.map((voucher) => checkCustomerEligibility(companyId, voucher, cart.clientId, client)));
  if (redemptions.some((redemption, index) => String(customers[index]?.id || '') !== String(redemption.clientId || ''))) {
    throw Object.assign(new Error('The selected customer changed after applying this voucher.'), { code: 'POS_VOUCHER_CART_CHANGED' });
  }
  const pricing = buildPricing({ cart: { ...cart, promotion: cartInput.promotion }, productsById, vouchers });
  if (redemptions.some((redemption) => {
    const quote = pricing.voucherRedemptions.find((row) => String(row.voucherId) === String(redemption.voucherId));
    return quote?.amountRwf !== redemption.discountRwf;
  })) {
    throw Object.assign(new Error('Voucher pricing changed. Apply the voucher again.'), { code: 'POS_VOUCHER_CART_CHANGED' });
  }
  return { redemptions, vouchers, pricing };
}

async function quoteReservation(companyId, cashierId, input) {
  return getReservationPricing(dbClient(), companyId, cashierId, input);
}

async function redeemReservation(tx, companyId, cashierId, {
  tokens,
  token,
  cartInput,
  productsById,
  invoiceId,
  holdForPending = false,
}) {
  const result = await getReservationPricing(tx, companyId, cashierId, {
    tokens: (Array.isArray(tokens) ? tokens : [token]).filter(Boolean),
    invoiceId,
    cartInput,
    productsById,
    lockRows: true,
  });
  if (!result) return null;
  const { redemptions, vouchers, pricing } = result;
  if (invoiceId) {
    for (const redemption of redemptions) {
      await tx.posVoucherRedemption.update({
        where: { id: redemption.id },
        data: holdForPending
          ? { invoiceId: String(invoiceId), pricingSnapshot: pricing }
          : {
            status: 'REDEEMED',
            invoiceId: String(invoiceId),
            redeemedAt: new Date(),
            pricingSnapshot: pricing,
          },
      });
      if (!holdForPending) {
        await writeAudit(companyId, cashierId, 'VOUCHER_REDEEMED', {
          voucherId: redemption.voucherId,
          redemptionId: redemption.id,
          invoiceId: String(invoiceId),
          discountRwf: redemption.discountRwf,
        }, tx);
      }
    }
  }
  return { ...result, heldForPending: holdForPending };
}

async function restoreRedemption(companyId, userId, redemptionId, reason) {
  const note = String(reason || '').trim();
  if (note.length < 5 || note.length > 500) {
    throw Object.assign(new Error('Provide a restoration reason between 5 and 500 characters.'), { code: 'POS_VOUCHER_RESTORE_REASON_REQUIRED' });
  }
  const result = await runInTransaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM pos_voucher_redemptions
      WHERE id = ${String(redemptionId)} AND company_id = ${String(companyId)}
      FOR UPDATE
    `;
    const row = await tx.posVoucherRedemption.findFirst({
      where: { id: String(redemptionId), companyId: String(companyId), status: 'REDEEMED' },
    });
    if (!row) throw Object.assign(new Error('A redeemed voucher use was not found.'), { code: 'POS_VOUCHER_REDEMPTION_NOT_FOUND' });
    const restored = await tx.posVoucherRedemption.update({
      where: { id: row.id },
      data: {
        status: 'RESTORED',
        restoredAt: new Date(),
        restoredById: String(userId),
        restoreReason: note,
      },
    });
    await writeAudit(companyId, userId, 'VOUCHER_RESTORED', {
      voucherId: row.voucherId,
      redemptionId: restored.id,
      invoiceId: row.invoiceId,
      reason: note,
    }, tx);
    return { row: restored, voucherId: row.voucherId };
  });
  return result.row;
}

module.exports = {
  CODE_PATTERN,
  MAX_BULK_COUNT,
  buildPricing,
  canonicalCart,
  cartHash,
  createVouchers,
  generateCode,
  getRedemptionHistory,
  getVoucher,
  hash,
  listVouchers,
  loadVoucherByCode,
  normalizeCode,
  parseKigaliDate,
  prepareVoucherRules,
  quoteReservation,
  redeemReservation,
  releaseInvoiceReservations,
  releaseReservation,
  reserveVoucher,
  restoreRedemption,
  setVoucherStatus,
  updateVoucher,
  updateVoucherSettings,
  voucherApi,
  voucherSettings,
};

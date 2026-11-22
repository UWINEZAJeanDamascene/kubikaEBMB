'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const accountingBuilders = require('./posAccountingBuilders');
const accountingProfileService = require('./posAccountingProfileService');
const accountingPostingService = require('./posAccountingPostingService');
const shiftLinkService = require('./posShiftLinkService');
const { writePosAuditLog, requestIp } = require('./posAuditService');

const ID_PATTERN = /^[a-f\d]{24}$/i;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const TIP_MODES = new Set(['cash_tip', 'keep_change']);
const MAX_DATABASE_INT = 2147483647;

function fail(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function contextFor(req) {
  const context = req.posAuthContext;
  const companyId = String(context?.company?.id || '').trim();
  const userId = String(context?.session?.userId || '').trim();
  const registerId = String(context?.register?.id || context?.session?.registerId || '').trim();
  if (!ID_PATTERN.test(companyId) || !ID_PATTERN.test(userId) || !ID_PATTERN.test(registerId)) {
    throw fail('RESTAURANT_POS_SESSION_REQUIRED', 'An active Restaurant POS session is required.', 401);
  }
  return {
    companyId,
    userId,
    registerId,
    registerCode: String(context?.register?.code || ''),
    registerName: String(context?.register?.name || ''),
    systemTillType: String(context?.register?.systemTillType || 'restaurant'),
  };
}

function requestKey(req, prefix) {
  const key = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
  if (!KEY_PATTERN.test(key)) {
    throw fail('POS_IDEMPOTENCY_KEY_INVALID', 'Provide a valid Idempotency-Key before recording this tip action.', 400);
  }
  return `${prefix}:${crypto.createHash('sha256').update(key).digest('hex')}`;
}

function wholeAmount(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_DATABASE_INT) {
    throw fail('RESTAURANT_TIP_AMOUNT_INVALID', `${label} must be a whole RWF amount greater than zero.`);
  }
  return amount;
}

function normalizedReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 10 || reason.length > 500) {
    throw fail('RESTAURANT_TIP_REASON_REQUIRED', 'Enter a reason of 10 to 500 characters.');
  }
  return reason;
}

function assertCashMethod(body) {
  const method = body.tipMethod ?? body.paymentMethod ?? body.method;
  if (method != null && String(method).toUpperCase() !== 'CASH') {
    throw fail('RESTAURANT_TIP_CASH_ONLY', 'Tips can only be collected in cash. Record card and mobile-money payments without a tip.');
  }
}

function normalizeCaptureInput(body, billTotal) {
  assertCashMethod(body);
  const captureMode = String(body?.captureMode || 'cash_tip');
  if (!TIP_MODES.has(captureMode)) {
    throw fail('RESTAURANT_TIP_MODE_INVALID', 'Choose a separate cash tip or keep the change as a cash tip.');
  }
  const tenderedAmount = captureMode === 'keep_change'
    ? wholeAmount(body?.cashTendered, 'Cash tendered')
    : null;
  const amount = captureMode === 'keep_change'
    ? tenderedAmount - billTotal
    : wholeAmount(body?.amount, 'Cash tip');
  if (amount <= 0) {
    throw fail('RESTAURANT_TIP_AMOUNT_INVALID', 'Cash tendered must exceed the paid bill amount to keep the change as a tip.');
  }
  return { amount, captureMode, tenderedAmount };
}

function amountSum(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

function sameCapture(existing, { billId, amount, captureMode, tenderedAmount }) {
  return String(existing.billId) === String(billId)
    && Number(existing.amount) === amount
    && existing.captureMode === captureMode
    && (existing.tenderedAmount == null ? null : Number(existing.tenderedAmount)) === tenderedAmount;
}

function samePayout(existing, { waiterId, amount, reason }) {
  return String(existing.waiterId) === String(waiterId)
    && Number(existing.amount) === amount
    && existing.reason === reason
    && existing.paymentMethod === 'CASH';
}

function sameReversal(existing, { tipId, amount, reason }) {
  return String(existing.tipId) === String(tipId)
    && Number(existing.amount) === amount
    && existing.reason === reason;
}

async function lockTipSettings(tx, companyId) {
  await tx.$queryRawUnsafe(
    'SELECT "company_id" FROM "restaurant_billing_settings" WHERE "company_id" = $1 FOR UPDATE',
    companyId,
  );
  const settings = await tx.restaurantBillingSettings.findUnique({ where: { companyId } });
  if (!settings?.tipsEnabled) {
    throw fail('RESTAURANT_TIPS_DISABLED', 'Cash tips are not enabled for this company.', 409);
  }
  return settings;
}

async function activeShift(tx, actor, companyId, preferredShiftId = null) {
  const shift = await tx.posShift.findFirst({
    where: {
      companyId,
      registerId: actor.registerId,
      status: { in: ['open', 'reopened'] },
      ...(preferredShiftId ? { id: preferredShiftId } : {}),
    },
    orderBy: { openedAt: 'desc' },
    select: { id: true, registerId: true, openedById: true, openedAt: true },
  });
  if (!shift) throw fail('POS_SHIFT_NOT_OPEN', 'Open a shift on this register before recording a cash tip action.', 409);
  return shift;
}

async function accountMappings(tx, companyId, actor) {
  const profile = await accountingProfileService.getProfile(companyId, tx);
  const scope = { tillType: actor.systemTillType, registerId: actor.registerId };
  const accounts = accountingProfileService.assertAccountMappings(
    profile,
    ['posRegisterCash', 'tipsPayable'],
    scope,
  );
  return accounts;
}

async function postCashLedgerEntry({
  tx,
  companyId,
  userId,
  actor,
  shift,
  register,
  record,
  sourceType,
  cashDirection,
  amount,
  description,
  counterpartAccount,
  auditEvent,
  auditMetadata,
  req,
}) {
  const accounts = await accountMappings(tx, companyId, actor);
  const lines = accountingBuilders.buildCashMovementJournalLines({
    movement: { type: cashDirection, amount },
    registerCashAccount: accounts.posRegisterCash,
    counterpartAccount,
  });
  const posting = await accountingPostingService.postOrQueue({
    tx,
    companyId,
    userId,
    sourceType,
    sourceId: record.id,
    entries: [{
      date: new Date(),
      description,
      sourceType,
      sourceId: record.id,
      sourceReference: record.id,
      lines,
    }],
    metadata: { registerId: actor.registerId, shiftId: shift.id },
  });
  const updated = await tx[record.model].update({
    where: { id: record.id },
    data: {
      postingStatus: posting.status,
      journalEntryId: posting.journalEntryIds?.[0] || null,
    },
  });
  await shiftLinkService.recordTillCashMovement(tx, {
    companyId,
    registerCode: register.code,
    shift,
    movement: {
      type: cashDirection,
      amount,
      reasonCode: 'OTHER',
      reference: record.id,
      note: description,
      performedById: userId,
    },
  });
  await writePosAuditLog({
    companyId,
    registerId: actor.registerId,
    userId,
    event: auditEvent,
    metadata: {
      ...auditMetadata,
      amount,
      shiftId: shift.id,
      journalEntryId: updated.journalEntryId,
      postingStatus: updated.postingStatus,
    },
    ip: requestIp(req),
  }, tx);
  return updated;
}

async function resolveRegister(tx, companyId, actor) {
  const register = await tx.posRegister.findFirst({
    where: { id: actor.registerId, companyId, isActive: true },
    select: { id: true, code: true, name: true, systemTillType: true },
  });
  if (!register) throw fail('POS_REGISTER_NOT_FOUND', 'The active POS register is unavailable.', 404);
  return register;
}

async function captureCashTip(req, billIdValue) {
  const actor = contextFor(req);
  const billId = String(billIdValue || '').trim();
  if (!ID_PATTERN.test(billId)) throw fail('RESTAURANT_BILL_INVALID', 'Choose a valid bill.');
  const requestId = requestKey(req, 'capture');
  const bill = await prisma.restaurantBill.findFirst({
    where: { id: billId, companyId: actor.companyId },
    select: { id: true, orderId: true, invoiceId: true, status: true, totalAmount: true },
  });
  if (!bill) throw fail('RESTAURANT_BILL_NOT_FOUND', 'This Restaurant bill is not available in this company.', 404);
  if (bill.status !== 'paid' || !bill.invoiceId) {
    throw fail('RESTAURANT_BILL_NOT_PAID', 'Complete the bill payment before recording its separate cash tip.', 409);
  }

  const billTotal = Number(bill.totalAmount);
  if (!Number.isSafeInteger(billTotal) || billTotal <= 0) {
    throw fail('RESTAURANT_BILL_AMOUNT_INVALID', 'The bill amount is invalid; the tip was not recorded.', 409);
  }
  const { amount, captureMode, tenderedAmount } = normalizeCaptureInput(req.body || {}, billTotal);
  const payload = { billId, amount, captureMode, tenderedAmount };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.restaurantTip.findFirst({
      where: { companyId: actor.companyId, idempotencyKey: requestId },
    });
    if (existing) {
      if (!sameCapture(existing, payload)) {
        throw fail('POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different tip.', 409);
      }
      return { tip: existing, replayed: true };
    }

    const settings = await lockTipSettings(tx, actor.companyId);
    const [invoice, order] = await Promise.all([
      tx.invoice.findFirst({
        where: { id: bill.invoiceId, companyId: actor.companyId, posOrigin: true },
        select: { id: true, registerId: true, cashierId: true, shiftId: true, totalAmount: true },
      }),
      tx.restaurantOrder.findFirst({
        where: { id: bill.orderId, companyId: actor.companyId },
        select: { id: true, registerId: true, waiterId: true },
      }),
    ]);
    if (!invoice || !order || String(invoice.registerId) !== actor.registerId
      || String(invoice.cashierId) !== actor.userId || String(order.registerId) !== actor.registerId) {
      throw fail('POS_PAYMENT_CONTEXT_MISMATCH', 'This bill belongs to a different cashier or register.', 403);
    }

    if (captureMode === 'keep_change') {
      const payments = await tx.posPayment.findMany({
        where: { companyId: actor.companyId, saleId: bill.invoiceId, status: 'SUCCESS' },
        select: { method: true, amount: true },
      });
      if (payments.length !== 1 || String(payments[0].method).toUpperCase() !== 'CASH'
        || Number(payments[0].amount) !== billTotal) {
        throw fail('RESTAURANT_TIP_KEEP_CHANGE_CASH_REQUIRED', 'Keep-the-change tips are available only when this check was paid in one cash payment.', 409);
      }
    }

    const threshold = Number(settings.largeTipConfirmationPct);
    if (amount * 100 >= billTotal * threshold && req.body?.confirmLargeTip !== true) {
      throw fail(
        'RESTAURANT_TIP_CONFIRMATION_REQUIRED',
        `Confirm this tip because it is at or above ${threshold}% of the check.`,
        409,
      );
    }
    const waiterId = settings.tipAttribution === 'table_waiter' && order.waiterId
      ? String(order.waiterId)
      : actor.userId;
    const shift = await activeShift(tx, actor, actor.companyId, invoice.shiftId);
    const register = await resolveRegister(tx, actor.companyId, actor);
    const tip = await tx.restaurantTip.create({
      data: {
        id: generateObjectId(),
        companyId: actor.companyId,
        billId: bill.id,
        orderId: bill.orderId,
        waiterId,
        registerId: actor.registerId,
        shiftId: shift.id,
        cashierId: actor.userId,
        amount,
        paymentMethod: 'CASH',
        captureMode,
        tenderedAmount,
        idempotencyKey: requestId,
      },
    });
    const recorded = await postCashLedgerEntry({
      tx,
      companyId: actor.companyId,
      userId: actor.userId,
      actor,
      shift,
      register,
      record: { ...tip, model: 'restaurantTip' },
      sourceType: 'restaurant_tip',
      cashDirection: 'cash_in',
      amount,
      description: `Restaurant cash tip for check ${bill.id}`,
      counterpartAccount: (await accountMappings(tx, actor.companyId, actor)).tipsPayable,
      auditEvent: 'RESTAURANT_CASH_TIP_CAPTURED',
      auditMetadata: {
        tipId: tip.id,
        billId: bill.id,
        orderId: bill.orderId,
        waiterId,
        captureMode,
      },
      req,
    });
    return { tip: recorded, replayed: false };
  });
}

async function getCaptureSettings(req) {
  const actor = contextFor(req);
  const settings = await prisma.restaurantBillingSettings.findUnique({
    where: { companyId: actor.companyId },
    select: { tipsEnabled: true, largeTipConfirmationPct: true },
  });
  return {
    tipsEnabled: Boolean(settings?.tipsEnabled),
    largeTipConfirmationPct: Number(settings?.largeTipConfirmationPct ?? 100),
  };
}

async function waiterTipBalances(tx, companyId) {
  const tips = await tx.restaurantTip.findMany({
    where: { companyId },
    select: { id: true, waiterId: true, amount: true, postingStatus: true },
  });
  const tipIds = tips.map((tip) => tip.id);
  const [reversals, payouts] = await Promise.all([
    tipIds.length
      ? tx.restaurantTipReversal.findMany({
        where: { companyId, tipId: { in: tipIds } },
        select: { tipId: true, amount: true, postingStatus: true },
      })
      : [],
    tx.restaurantTipPayout.findMany({
      where: { companyId },
      select: { waiterId: true, amount: true, postingStatus: true },
    }),
  ]);
  return { tips, reversals, payouts };
}

function waiterBalance(waiterId, { tips, reversals, payouts }) {
  const waiterTips = tips.filter((tip) => String(tip.waiterId) === String(waiterId));
  const tipIds = new Set(waiterTips.map((tip) => String(tip.id)));
  const waiterReversals = reversals.filter((reversal) => tipIds.has(String(reversal.tipId)));
  const waiterPayouts = payouts.filter((payout) => String(payout.waiterId) === String(waiterId));
  const pending = [...waiterTips, ...waiterReversals, ...waiterPayouts]
    .some((row) => row.postingStatus !== 'posted');
  return {
    collected: amountSum(waiterTips),
    reversed: amountSum(waiterReversals),
    paidOut: amountSum(waiterPayouts),
    available: amountSum(waiterTips) - amountSum(waiterReversals) - amountSum(waiterPayouts),
    postingPending: pending,
  };
}

async function listWaiterTipBalances(req) {
  const actor = contextFor(req);
  const balances = await waiterTipBalances(prisma, actor.companyId);
  const waiterIds = [...new Set(balances.tips.map((tip) => String(tip.waiterId)))];
  if (!waiterIds.length) return [];
  const users = await prisma.user.findMany({
    where: { companyId: actor.companyId, id: { in: waiterIds } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return users.map((user) => ({
    waiterId: user.id,
    waiterName: user.name,
    ...waiterBalance(user.id, balances),
  }));
}

async function payWaiterTips(req) {
  const actor = contextFor(req);
  const waiterId = String(req.body?.waiterId || '').trim();
  if (!ID_PATTERN.test(waiterId)) throw fail('RESTAURANT_TIP_WAITER_INVALID', 'Choose a valid waiter.');
  const amount = wholeAmount(req.body?.amount, 'Payout amount');
  const reason = normalizedReason(req.body?.reason);
  const requestId = requestKey(req, 'payout');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.restaurantTipPayout.findFirst({
      where: { companyId: actor.companyId, idempotencyKey: requestId },
    });
    if (existing) {
      if (!samePayout(existing, { waiterId, amount, reason })) {
        throw fail('POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different tip payout.', 409);
      }
      return { payout: existing, replayed: true };
    }
    await lockTipSettings(tx, actor.companyId);
    const waiter = await tx.user.findFirst({
      where: { id: waiterId, companyId: actor.companyId, isActive: true },
      select: { id: true },
    });
    if (!waiter) throw fail('RESTAURANT_TIP_WAITER_INVALID', 'The selected waiter is not active in this company.');
    const balances = await waiterTipBalances(tx, actor.companyId);
    const balance = waiterBalance(waiterId, balances);
    if (balance.postingPending) {
      throw fail('RESTAURANT_TIP_ACCOUNTING_PENDING', 'Wait for pending tip accounting to post before paying out this waiter.', 409);
    }
    if (amount > balance.available) {
      throw fail('RESTAURANT_TIP_PAYOUT_EXCEEDS_BALANCE', 'The payout is greater than this waiter’s available cash tips.', 409);
    }
    const shift = await activeShift(tx, actor, actor.companyId);
    const register = await resolveRegister(tx, actor.companyId, actor);
    const accounts = await accountMappings(tx, actor.companyId, actor);
    const payout = await tx.restaurantTipPayout.create({
      data: {
        id: generateObjectId(),
        companyId: actor.companyId,
        waiterId,
        registerId: actor.registerId,
        shiftId: shift.id,
        amount,
        paymentMethod: 'CASH',
        accountCode: accounts.posRegisterCash,
        reason,
        approvedById: actor.userId,
        idempotencyKey: requestId,
      },
    });
    const recorded = await postCashLedgerEntry({
      tx,
      companyId: actor.companyId,
      userId: actor.userId,
      actor,
      shift,
      register,
      record: { ...payout, model: 'restaurantTipPayout' },
      sourceType: 'restaurant_tip_payout',
      cashDirection: 'cash_out',
      amount,
      description: `Cash tip payout to waiter ${waiterId}: ${reason}`,
      counterpartAccount: accounts.tipsPayable,
      auditEvent: 'RESTAURANT_CASH_TIP_PAID_OUT',
      auditMetadata: { payoutId: payout.id, waiterId, reason },
      req,
    });
    return { payout: recorded, replayed: false, availableAfter: balance.available - amount };
  });
}

async function reverseCashTip(req, tipIdValue) {
  const actor = contextFor(req);
  const tipId = String(tipIdValue || '').trim();
  if (!ID_PATTERN.test(tipId)) throw fail('RESTAURANT_TIP_INVALID', 'Choose a valid tip.');
  const amount = wholeAmount(req.body?.amount, 'Reversal amount');
  const reason = normalizedReason(req.body?.reason);
  const requestId = requestKey(req, 'reversal');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.restaurantTipReversal.findFirst({
      where: { companyId: actor.companyId, idempotencyKey: requestId },
    });
    if (existing) {
      if (!sameReversal(existing, { tipId, amount, reason })) {
        throw fail('POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different tip reversal.', 409);
      }
      return { reversal: existing, replayed: true };
    }
    await lockTipSettings(tx, actor.companyId);
    const tip = await tx.restaurantTip.findFirst({
      where: { id: tipId, companyId: actor.companyId },
    });
    if (!tip) throw fail('RESTAURANT_TIP_NOT_FOUND', 'This tip is not available in this company.', 404);
    if (tip.postingStatus !== 'posted') {
      throw fail('RESTAURANT_TIP_ACCOUNTING_PENDING', 'Wait for the tip accounting to post before reversing it.', 409);
    }
    const balances = await waiterTipBalances(tx, actor.companyId);
    const tipReversed = amountSum(balances.reversals.filter((reversal) => String(reversal.tipId) === tipId));
    const waiterBalanceValue = waiterBalance(tip.waiterId, balances);
    if (waiterBalanceValue.postingPending) {
      throw fail('RESTAURANT_TIP_ACCOUNTING_PENDING', 'Wait for pending tip accounting to post before reversing this tip.', 409);
    }
    if (amount > Number(tip.amount) - tipReversed || amount > waiterBalanceValue.available) {
      throw fail('RESTAURANT_TIP_REVERSAL_EXCEEDS_BALANCE', 'The reversal exceeds this tip’s unpaid balance.', 409);
    }
    const shift = await activeShift(tx, actor, actor.companyId);
    const register = await resolveRegister(tx, actor.companyId, actor);
    const accounts = await accountMappings(tx, actor.companyId, actor);
    const reversal = await tx.restaurantTipReversal.create({
      data: {
        id: generateObjectId(),
        companyId: actor.companyId,
        tipId,
        registerId: actor.registerId,
        shiftId: shift.id,
        amount,
        reason,
        approvedById: actor.userId,
        idempotencyKey: requestId,
      },
    });
    const recorded = await postCashLedgerEntry({
      tx,
      companyId: actor.companyId,
      userId: actor.userId,
      actor,
      shift,
      register,
      record: { ...reversal, model: 'restaurantTipReversal' },
      sourceType: 'restaurant_tip_reversal',
      cashDirection: 'cash_out',
      amount,
      description: `Restaurant cash tip reversal for ${tipId}: ${reason}`,
      counterpartAccount: accounts.tipsPayable,
      auditEvent: 'RESTAURANT_CASH_TIP_REVERSED',
      auditMetadata: { reversalId: reversal.id, tipId, waiterId: tip.waiterId, reason },
      req,
    });
    return { reversal: recorded, replayed: false };
  });
}

module.exports = {
  captureCashTip,
  normalizeCaptureInput,
  getCaptureSettings,
  listWaiterTipBalances,
  payWaiterTips,
  reverseCashTip,
};

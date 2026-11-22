'use strict';

const orderService = require('../services/posRestaurantOrderService');
const reportService = require('../services/posRestaurantReportService');
const { runInTransaction } = require('../services/transactionService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

function companyIdFor(req) {
  const company = req.user?.company;
  return String(
    req.posAuthContext?.company?.id
      || req.posSession?.companyId
      || req.user?.companyId
      || (typeof company === 'string' ? company : company?.id || company?._id)
      || '',
  );
}

function actorFor(req) {
  const context = req.posAuthContext;
  return {
    userId: String(context?.session?.userId || ''),
    registerId: String(context?.register?.id || context?.session?.registerId || ''),
    name: String(context?.user?.name || ''),
    trainingMode: Boolean(context?.register?.trainingMode),
    permissions: Array.isArray(req.posPermissions) ? req.posPermissions : [],
  };
}

function idempotencyKeyFor(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '');
}

function action(statusCode, operation) {
  return async (req, res, next) => {
    try {
      const data = await operation(req, companyIdFor(req), actorFor(req));
      return res.status(statusCode).json({ success: true, data });
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code || 'RESTAURANT_ORDER_ERROR',
          message: error.message,
        });
      }
      if (error?.code === 'P2002') {
        return res.status(409).json({
          success: false,
          code: 'RESTAURANT_ORDER_CONFLICT',
          message: 'This order changed while you were working. Refresh and try again.',
        });
      }
      return next(error);
    }
  };
}

exports.getOverview = action(200, (req, companyId, actor) => (
  orderService.getOverview(companyId, actor)
));

exports.getOrder = action(200, (req, companyId, actor) => (
  orderService.getOrder(companyId, req.params.orderId, actor)
));

exports.getReport = action(200, (req, companyId, actor) => (
  reportService.getRestaurantReport({
    companyId,
    registerId: String(req.query?.registerId || actor.registerId || ''),
    type: String(req.query?.type || ''),
    from: req.query?.from,
    to: req.query?.to,
  })
));

exports.listReportRegisters = action(200, (_req, companyId) => (
  reportService.listRestaurantReportRegisters(companyId)
));

exports.handoverOpenOrders = async (req, res, next) => {
  const companyId = companyIdFor(req);
  const actor = actorFor(req);
  const shiftId = String(req.body?.shiftId || '').trim();
  const toUserId = typeof req.body?.toUserId === 'string' ? req.body.toUserId.trim() : '';
  if (!/^[a-f0-9]{24}$/i.test(shiftId) || !/^[a-f0-9]{24}$/i.test(toUserId) || toUserId === actor.userId) {
    return res.status(400).json({
      success: false,
      code: 'RESTAURANT_HANDOVER_INVALID',
      message: 'Choose a valid active shift and a different cashier assigned to this register.',
    });
  }

  try {
    const result = await runInTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 AND "register_id" = $3 AND "status" IN (\'open\', \'reopened\') FOR UPDATE',
        shiftId,
        companyId,
        actor.registerId,
      );
      if (!locked.length) return { code: 'POS_SHIFT_NOT_OPEN' };

      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId: actor.registerId, status: { in: ['open', 'reopened'] } },
        select: { id: true, openedById: true, shiftNumber: true },
      });
      if (!shift) return { code: 'POS_SHIFT_NOT_OPEN' };
      if (shift.openedById !== actor.userId) return { code: 'POS_SHIFT_HANDOVER_CASHIER_MISMATCH' };

      const target = await tx.user.findFirst({
        where: { id: toUserId, companyId, isActive: true },
        select: { id: true },
      });
      const [access, credential] = await Promise.all([
        tx.posRegisterAccess.findUnique({
          where: { registerId_userId: { registerId: actor.registerId, userId: toUserId } },
          select: { companyId: true, pinLockedUntil: true },
        }),
        tx.posUserCredential.findUnique({
          where: { companyId_userId: { companyId, userId: toUserId } },
          select: { id: true },
        }),
      ]);
      if (!target || access?.companyId !== companyId) return { code: 'POS_SHIFT_HANDOVER_USER_NOT_ASSIGNED' };
      if (access.pinLockedUntil && access.pinLockedUntil > new Date()) return { code: 'POS_SHIFT_HANDOVER_USER_PIN_LOCKED' };
      if (!credential) return { code: 'POS_SHIFT_HANDOVER_USER_PIN_REQUIRED' };

      const handover = await orderService.carryOpenOrdersForShiftHandover(tx, {
        companyId,
        registerId: actor.registerId,
        fromUserId: actor.userId,
        toUserId,
        shiftId,
      });
      if (handover.code) return handover;
      await writePosAuditLog({
        companyId,
        registerId: actor.registerId,
        userId: actor.userId,
        event: 'RESTAURANT_ORDERS_HANDED_OVER',
        metadata: {
          shiftId,
          shiftNumber: shift.shiftNumber,
          toUserId,
          orderIds: handover.orders.map((order) => order.id),
        },
        ip: requestIp(req),
      }, tx);
      return { orders: handover.orders };
    });

    if (result.code === 'POS_SHIFT_NOT_OPEN') {
      return res.status(409).json({ success: false, code: result.code, message: 'Open the active register shift before handing over Restaurant orders.' });
    }
    if (result.code === 'POS_SHIFT_HANDOVER_CASHIER_MISMATCH') {
      return res.status(403).json({ success: false, code: result.code, message: 'Only the cashier who opened this shift can hand over its Restaurant orders.' });
    }
    if (result.code === 'POS_SHIFT_HANDOVER_USER_NOT_ASSIGNED') {
      return res.status(400).json({ success: false, code: result.code, message: 'The selected cashier is inactive or is not assigned to this register.' });
    }
    if (result.code === 'POS_SHIFT_HANDOVER_USER_PIN_LOCKED') {
      return res.status(409).json({ success: false, code: result.code, message: 'The selected cashier POS PIN is temporarily locked.' });
    }
    if (result.code === 'POS_SHIFT_HANDOVER_USER_PIN_REQUIRED') {
      return res.status(409).json({ success: false, code: result.code, message: 'Set up the selected cashier POS PIN before handover.' });
    }
    if (result.code === 'RESTAURANT_OPEN_BILLED_ORDERS_BLOCKED') {
      return res.status(409).json({
        success: false,
        code: 'POS_SHIFT_RESTAURANT_BILLS_UNPAID',
        message: 'Settle issued Restaurant bills before handing over; they remain attached to the current cashier.',
        restaurantOpenOrders: result.blockedOrders,
      });
    }
    orderService.notifyHandoverOrders(companyId, result.orders);
    return res.json({ success: true, data: { orders: result.orders } });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        success: false,
        code: 'RESTAURANT_ORDER_CONFLICT',
        message: 'This order changed during handover. Refresh the shift and try again.',
      });
    }
    return next(error);
  }
};

exports.openOrder = action(201, (req, companyId, actor) => (
  orderService.openOrder(companyId, req.body, actor, idempotencyKeyFor(req))
));

exports.updateUnsentItems = action(200, (req, companyId, actor) => (
  orderService.updateUnsentItems(
    companyId,
    req.params.orderId,
    req.body,
    actor,
    idempotencyKeyFor(req),
  )
));

exports.sendRound = action(200, (req, companyId, actor) => (
  orderService.sendRound(
    companyId,
    req.params.orderId,
    req.body,
    actor,
    idempotencyKeyFor(req),
  )
));

exports.voidSentItem = action(200, (req, companyId, actor) => (
  orderService.voidSentItem(
    companyId,
    req.params.orderId,
    req.params.itemId,
    req.body,
    actor,
    idempotencyKeyFor(req),
  )
));

exports.listStationTickets = action(200, (req, companyId) => (
  orderService.listStationTickets(companyId, req.params.station)
));

exports.updateTicketStatus = action(200, (req, companyId, actor) => (
  orderService.updateTicketStatus(
    companyId,
    req.params.ticketId,
    req.body,
    actor,
    idempotencyKeyFor(req),
  )
));

exports.retryTicket = action(200, (req, companyId, actor) => (
  orderService.retryTicket(companyId, req.params.ticketId, actor)
));

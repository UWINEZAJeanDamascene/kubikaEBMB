'use strict';

const { prisma } = require('../lib/prisma');
const { listShiftHandoverOrders } = require('./posRestaurantOrderService');

const REPORT_TYPES = new Set(['sales-by-item', 'open-orders', 'voids', 'shifts']);
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[a-f0-9]{24}$/i;

function reportError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function reportRange(fromValue, toValue) {
  const now = new Date();
  const to = toValue
    ? new Date(`${String(toValue)}T23:59:59.999Z`)
    : now;
  const from = fromValue
    ? new Date(`${String(fromValue)}T00:00:00.000Z`)
    : new Date(to.getTime() - (30 * DAY_MS));
  const isDate = (value) => Number.isFinite(value.getTime())
    && value.toISOString().slice(0, 10) === String(value === from ? fromValue : toValue);

  if ((fromValue && !isDate(from)) || (toValue && !isDate(to))) {
    throw reportError('RESTAURANT_REPORT_DATE_INVALID', 'Choose valid report start and end dates.');
  }
  if (from > to) {
    throw reportError('RESTAURANT_REPORT_RANGE_INVALID', 'The report start date must be on or before its end date.');
  }
  if (to.getTime() - from.getTime() > 366 * DAY_MS) {
    throw reportError('RESTAURANT_REPORT_RANGE_TOO_LARGE', 'Restaurant reports are limited to a 366-day date range.');
  }
  return { from, to };
}

function payloadObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function addOrderBillingSummary(companyId, orders) {
  if (!orders.length) return [];
  const bills = await prisma.restaurantBill.findMany({
    where: { companyId, orderId: { in: orders.map((order) => order.id) } },
    select: { orderId: true, invoiceId: true, totalAmount: true },
  });
  const billByOrderId = new Map(bills.map((bill) => [bill.orderId, bill]));
  const invoiceIds = [...new Set(bills.map((bill) => bill.invoiceId).filter(Boolean))];
  const payments = invoiceIds.length
    ? await prisma.posPayment.findMany({
      where: { companyId, saleId: { in: invoiceIds }, status: 'SUCCESS' },
      select: { saleId: true, amount: true },
    })
    : [];
  const amountPaidByInvoice = new Map();
  for (const payment of payments) {
    amountPaidByInvoice.set(
      payment.saleId,
      (amountPaidByInvoice.get(payment.saleId) || 0) + Number(payment.amount || 0),
    );
  }
  return orders.map((order) => {
    const bill = billByOrderId.get(order.id);
    const billTotal = Number(bill?.totalAmount || 0);
    const amountReceived = bill?.invoiceId
      ? amountPaidByInvoice.get(bill.invoiceId) || 0
      : 0;
    return {
      ...order,
      billTotal,
      amountReceived,
      balanceDue: Math.max(0, billTotal - amountReceived),
    };
  });
}

async function listRestaurantReportRegisters(companyIdValue) {
  const companyId = String(companyIdValue || '').trim();
  if (!ID_PATTERN.test(companyId)) {
    throw reportError('RESTAURANT_COMPANY_REQUIRED', 'A valid company context is required.', 401);
  }
  const restaurantOrders = await prisma.restaurantOrder.findMany({
    where: { companyId },
    select: { registerId: true },
    distinct: ['registerId'],
  });
  const orderRegisterIds = [...new Set(restaurantOrders.map((order) => order.registerId).filter(Boolean))];
  return prisma.posRegister.findMany({
    where: {
      companyId,
      OR: [
        { systemTillType: 'restaurant' },
        ...(orderRegisterIds.length ? [{ id: { in: orderRegisterIds } }] : []),
      ],
    },
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });
}

async function getRestaurantReport({ companyId: companyIdValue, registerId: registerIdValue, type, from, to }) {
  const companyId = String(companyIdValue || '').trim();
  const registerId = String(registerIdValue || '').trim();
  if (!ID_PATTERN.test(companyId)) {
    throw reportError('RESTAURANT_COMPANY_REQUIRED', 'A valid company context is required.', 401);
  }
  if (!ID_PATTERN.test(registerId)) {
    throw reportError('RESTAURANT_REPORT_REGISTER_INVALID', 'Select a Restaurant register to view its reports.');
  }
  if (!REPORT_TYPES.has(type)) {
    throw reportError('RESTAURANT_REPORT_TYPE_INVALID', 'Choose a supported Restaurant report.');
  }
  const register = await prisma.posRegister.findFirst({
    where: { id: registerId, companyId },
    select: { id: true, systemTillType: true },
  });
  const hasRestaurantOrders = Boolean(register)
    && register.systemTillType !== 'restaurant'
    && await prisma.restaurantOrder.findFirst({
      where: { companyId, registerId },
      select: { id: true },
    });
  if (!register || (register.systemTillType !== 'restaurant' && !hasRestaurantOrders)) {
    throw reportError('RESTAURANT_REPORT_REGISTER_NOT_FOUND', 'The selected Restaurant register is not available in this company.', 404);
  }
  const range = reportRange(from, to);
  const dateFilter = { gte: range.from, lte: range.to };

  if (type === 'open-orders') {
    const openOrders = await listShiftHandoverOrders(prisma, companyId, registerId);
    const orders = await addOrderBillingSummary(companyId, openOrders);
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: orders.length,
      billedTotal: orders.reduce((total, order) => total + order.billTotal, 0),
      amountReceived: orders.reduce((total, order) => total + order.amountReceived, 0),
      orders,
    };
  }

  if (type === 'sales-by-item') {
    const registerOrders = await prisma.restaurantOrder.findMany({
      where: { companyId, registerId },
      select: { id: true },
    });
    const issuedBills = registerOrders.length
      ? await prisma.restaurantBill.findMany({
        where: {
          companyId,
          orderId: { in: registerOrders.map((order) => order.id) },
          createdAt: dateFilter,
          status: { in: ['issued', 'pending_payment', 'paid'] },
        },
        select: { id: true, totalAmount: true },
      })
      : [];
    const paidBills = await prisma.restaurantBill.findMany({
      where: {
        companyId,
        status: 'paid',
        invoiceId: { not: null },
        orderId: {
          in: (await prisma.restaurantOrder.findMany({
            where: { companyId, registerId, status: 'paid', updatedAt: dateFilter },
            select: { id: true },
          })).map((order) => order.id),
        },
      },
      select: { invoiceId: true },
    });
    const invoiceIds = paidBills.map((bill) => bill.invoiceId).filter(Boolean);
    const invoices = invoiceIds.length
      ? await prisma.invoice.findMany({
        where: {
          companyId,
          id: { in: invoiceIds },
          registerId: register.id,
          posOrigin: true,
          status: 'fully_paid',
          invoiceDate: dateFilter,
        },
        select: {
          id: true,
          totalAmount: true,
          lines: {
            select: {
              productId: true,
              productName: true,
              description: true,
              qty: true,
              lineTotal: true,
            },
          },
        },
      })
      : [];
    const items = new Map();
    let totalSales = 0;
    for (const invoice of invoices) {
      totalSales += Number(invoice.totalAmount || 0);
      for (const line of invoice.lines) {
        const key = `${line.productId}:${line.productName || line.description || ''}`;
        const item = items.get(key) || {
          productId: line.productId,
          name: line.productName || line.description || 'Restaurant item',
          quantity: 0,
          sales: 0,
        };
        item.quantity += Number(line.qty || 0);
        item.sales += Number(line.lineTotal || 0);
        items.set(key, item);
      }
    }
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      invoiceCount: invoices.length,
      totalSales,
      billsIssued: issuedBills.length,
      billedTotal: issuedBills.reduce((total, bill) => total + Number(bill.totalAmount || 0), 0),
      items: [...items.values()].sort((left, right) => right.sales - left.sales),
    };
  }

  if (type === 'voids') {
    const orders = await prisma.restaurantOrder.findMany({
      where: { companyId, registerId },
      select: { id: true, orderKind: true, tableId: true, tabName: true },
    });
    const orderIds = orders.map((order) => order.id);
    const [events, tables] = orderIds.length
      ? await Promise.all([
        prisma.restaurantOrderEvent.findMany({
          where: {
            companyId,
            orderId: { in: orderIds },
            eventType: 'SENT_ITEM_VOIDED',
            createdAt: dateFilter,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.restaurantTable.findMany({
          where: { companyId, id: { in: orders.map((order) => order.tableId).filter(Boolean) } },
          select: { id: true, name: true },
        }),
      ])
      : [[], []];
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const tableNameById = new Map(tables.map((table) => [table.id, table.name]));
    const staff = events.length
      ? await prisma.user.findMany({
        where: { companyId, id: { in: [...new Set(events.map((event) => event.actorId))] } },
        select: { id: true, name: true },
      })
      : [];
    const staffNameById = new Map(staff.map((user) => [user.id, user.name]));
    const voids = events.map((event) => {
      const payload = payloadObject(event.payloadJson);
      const snapshot = payloadObject(payload.snapshot);
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const item = items.find((line) => line.id === payload.itemId);
      const order = orderById.get(event.orderId);
      return {
        id: event.id,
        orderId: event.orderId,
        orderKind: order?.orderKind || 'unknown',
        tableName: order?.tableId ? tableNameById.get(order.tableId) || null : null,
        tabName: order?.tabName || null,
        itemName: item?.name || item?.productName || 'Restaurant item',
        quantity: Number(item?.quantity || 0),
        reason: String(payload.reason || ''),
        decision: String(payload.decision || ''),
        actorId: event.actorId,
        actorName: staffNameById.get(event.actorId) || null,
        createdAt: event.createdAt,
      };
    });
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: voids.length,
      voids,
    };
  }

  const shifts = await prisma.posShift.findMany({
    where: { companyId, registerId, closedAt: dateFilter },
    orderBy: [{ closedAt: 'desc' }, { shiftNumber: 'desc' }],
    select: {
      id: true,
      shiftNumber: true,
      status: true,
      openedAt: true,
      closedAt: true,
      openedById: true,
      closedById: true,
      expectedCash: true,
      countedCash: true,
      difference: true,
      zReport: { select: { zNumber: true, generatedAt: true, snapshot: true } },
    },
  });
  return {
    type,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    count: shifts.length,
    shifts: shifts.map((shift) => ({
      ...shift,
      zReport: shift.zReport ? {
        zNumber: shift.zReport.zNumber,
        generatedAt: shift.zReport.generatedAt,
        sales: payloadObject(shift.zReport.snapshot).sales || null,
        tenderTotals: payloadObject(shift.zReport.snapshot).paymentMethods || null,
      } : null,
    })),
  };
}

module.exports = {
  getRestaurantReport,
  listRestaurantReportRegisters,
  reportRange,
};

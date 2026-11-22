'use strict';

const { prisma } = require('../lib/prisma');
const { listShiftHandoverOrders } = require('./posRestaurantOrderService');

const REPORT_TYPES = new Set([
  'sales-by-item',
  'open-orders',
  'service-charges',
  'tips',
  'voids',
  'shifts',
  'sales-by-hour',
  'waiter-performance',
  'promotion-effectiveness',
  'recipe-consumption',
  'bar-measures',
  'item-margin',
]);
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

async function loadRestaurantAdvancedData(companyId, registerId, dateFilter) {
  const [orders, company] = await Promise.all([
    prisma.restaurantOrder.findMany({
      where: { companyId, registerId, updatedAt: dateFilter },
      select: { id: true, waiterId: true, status: true, updatedAt: true },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
  ]);
  const orderIds = orders.map((order) => order.id);
  const bills = orderIds.length
    ? await prisma.restaurantBill.findMany({
      where: { companyId, orderId: { in: orderIds }, status: 'paid' },
      select: {
        id: true,
        orderId: true,
        invoiceId: true,
        totalAmount: true,
        lineSnapshot: true,
        createdAt: true,
      },
    })
    : [];
  const invoiceIds = [...new Set(bills.map((bill) => bill.invoiceId).filter(Boolean))];
  const invoices = invoiceIds.length
    ? await prisma.invoice.findMany({
      where: {
        companyId,
        id: { in: invoiceIds },
        registerId,
        posOrigin: true,
        status: 'fully_paid',
        invoiceDate: dateFilter,
      },
      select: {
        id: true,
        totalAmount: true,
        invoiceDate: true,
        lines: {
          select: {
            productId: true,
            productName: true,
            qty: true,
            unitPrice: true,
            lineSubtotal: true,
            discountPct: true,
            lineTax: true,
            lineTotal: true,
            cogsAmount: true,
            isServiceLine: true,
          },
        },
      },
    })
    : [];
  return {
    orders,
    bills: bills.filter((bill) => invoiceIds.includes(bill.invoiceId)),
    invoices,
    orderById: new Map(orders.map((order) => [order.id, order])),
    invoiceById: new Map(invoices.map((invoice) => [invoice.id, invoice])),
    billByInvoiceId: new Map(bills.filter((bill) => bill.invoiceId).map((bill) => [bill.invoiceId, bill])),
    timeZone: company?.timezone || 'Africa/Kigali',
  };
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));
  return Number(parts.find((part) => part.type === 'hour')?.value);
}

function snapshotItems(bill) {
  const snapshot = payloadObject(bill?.lineSnapshot);
  return Array.isArray(snapshot.items) ? snapshot.items : [];
}

async function getStockCommitmentReportData(companyId, orderIds, dateFilter) {
  if (!orderIds.length) return { rows: [], productNames: new Map() };
  const rows = await prisma.restaurantStockCommitment.findMany({
    where: {
      companyId,
      orderId: { in: orderIds },
      status: { in: ['deducted', 'waste'] },
      OR: [
        { closedAt: dateFilter },
        { voidedAt: dateFilter },
      ],
    },
    select: {
      orderId: true,
      orderItemId: true,
      productId: true,
      quantity: true,
      sourceType: true,
      servingCount: true,
      purchaseUnitCode: true,
      purchaseUnitVolume: true,
      status: true,
      totalCost: true,
      closedAt: true,
      voidedAt: true,
    },
  });
  const productIds = [...new Set(rows.map((row) => row.productId))];
  const products = productIds.length
    ? await prisma.product.findMany({
      where: { companyId, id: { in: productIds } },
      select: { id: true, name: true, unit: true },
    })
    : [];
  return {
    rows,
    productNames: new Map(products.map((product) => [product.id, { name: product.name, unit: product.unit }])),
  };
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

  if ([
    'sales-by-hour',
    'waiter-performance',
    'promotion-effectiveness',
    'recipe-consumption',
    'bar-measures',
    'item-margin',
  ].includes(type)) {
    const data = await loadRestaurantAdvancedData(companyId, register.id, dateFilter);
    const paidOrders = data.invoices.map((invoice) => ({
      invoice,
      bill: data.billByInvoiceId.get(invoice.id),
      order: data.orderById.get(data.billByInvoiceId.get(invoice.id)?.orderId),
    })).filter((entry) => entry.bill && entry.order);

    if (type === 'sales-by-hour') {
      const hours = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        invoiceCount: 0,
        sales: 0,
      }));
      for (const { invoice } of paidOrders) {
        const bucket = hours[localHour(invoice.invoiceDate, data.timeZone)];
        bucket.invoiceCount += 1;
        bucket.sales += Number(invoice.totalAmount || 0);
      }
      return {
        type,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timeZone: data.timeZone,
        invoiceCount: paidOrders.length,
        totalSales: paidOrders.reduce((total, entry) => total + Number(entry.invoice.totalAmount || 0), 0),
        hours,
      };
    }

    if (type === 'waiter-performance') {
      const waiters = new Map();
      for (const { invoice, order } of paidOrders) {
        const key = order.waiterId || 'unassigned';
        const waiter = waiters.get(key) || {
          waiterId: order.waiterId,
          name: order.waiterId ? null : 'Unassigned',
          invoiceCount: 0,
          sales: 0,
        };
        waiter.invoiceCount += 1;
        waiter.sales += Number(invoice.totalAmount || 0);
        waiters.set(key, waiter);
      }
      const waiterIds = [...waiters.keys()].filter((id) => id !== 'unassigned');
      const users = waiterIds.length
        ? await prisma.user.findMany({
          where: { companyId, id: { in: waiterIds } },
          select: { id: true, name: true },
        })
        : [];
      const nameById = new Map(users.map((user) => [user.id, user.name]));
      const rows = [...waiters.values()].map((waiter) => ({
        ...waiter,
        name: waiter.waiterId ? nameById.get(waiter.waiterId) || 'Staff member' : waiter.name,
        averageSale: waiter.invoiceCount ? waiter.sales / waiter.invoiceCount : 0,
      })).sort((left, right) => right.sales - left.sales);
      return {
        type,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        invoiceCount: paidOrders.length,
        totalSales: rows.reduce((total, row) => total + row.sales, 0),
        rows,
      };
    }

    if (type === 'promotion-effectiveness') {
      const promotions = new Map();
      for (const { invoice } of paidOrders) {
        const bill = data.billByInvoiceId.get(invoice.id);
        for (const item of snapshotItems(bill)) {
          const promotion = payloadObject(item.promotionSnapshot);
          if (!promotion.id) continue;
          const key = String(promotion.id);
          const row = promotions.get(key) || {
            promotionId: key,
            name: String(promotion.name || 'Promotion'),
            itemCount: 0,
            quantity: 0,
            discount: 0,
            sales: 0,
          };
          row.itemCount += 1;
          row.quantity += Number(item.quantity || 0);
          row.discount += Number(item.discountAmount || 0);
          row.sales += Number(item.total || 0);
          promotions.set(key, row);
        }
      }
      return {
        type,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        rows: [...promotions.values()].sort((left, right) => right.sales - left.sales),
      };
    }

    const commitments = await getStockCommitmentReportData(
      companyId,
      data.orders.map((order) => order.id),
      dateFilter,
    );
    if (type === 'recipe-consumption') {
      const consumption = new Map();
      for (const row of commitments.rows) {
        if (row.sourceType !== 'recipe') continue;
        const product = commitments.productNames.get(row.productId);
        const key = `${row.productId}:${row.status}`;
        const item = consumption.get(key) || {
          productId: row.productId,
          productName: product?.name || 'Stock item',
          unit: product?.unit || '',
          status: row.status,
          quantity: 0,
          cost: 0,
        };
        item.quantity += Number(row.quantity || 0);
        item.cost += Number(row.totalCost || 0);
        consumption.set(key, item);
      }
      const rows = [...consumption.values()].sort((left, right) => right.cost - left.cost);
      return {
        type,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        quantity: rows.reduce((total, row) => total + row.quantity, 0),
        cost: rows.reduce((total, row) => total + row.cost, 0),
        rows,
      };
    }
    if (type === 'bar-measures') {
      const measures = new Map();
      for (const row of commitments.rows) {
        if (row.sourceType !== 'bar_measure') continue;
        const product = commitments.productNames.get(row.productId);
        const key = `${row.productId}:${row.purchaseUnitCode || ''}:${row.purchaseUnitVolume || ''}`;
        const item = measures.get(key) || {
          productId: row.productId,
          productName: product?.name || 'Bar stock item',
          unit: product?.unit || '',
          purchaseUnitCode: row.purchaseUnitCode,
          bottleVolume: Number(row.purchaseUnitVolume || 0),
          servings: 0,
          stockUsed: 0,
          bottleEquivalent: 0,
          cost: 0,
        };
        item.servings += Number(row.servingCount || 0);
        item.stockUsed += Number(row.quantity || 0);
        item.bottleEquivalent += item.bottleVolume > 0
          ? Number(row.quantity || 0) / item.bottleVolume
          : 0;
        item.cost += Number(row.totalCost || 0);
        measures.set(key, item);
      }
      const rows = [...measures.values()].sort((left, right) => right.stockUsed - left.stockUsed);
      return {
        type,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        servings: rows.reduce((total, row) => total + row.servings, 0),
        stockUsed: rows.reduce((total, row) => total + row.stockUsed, 0),
        cost: rows.reduce((total, row) => total + row.cost, 0),
        rows,
      };
    }

    const costByOrderItemId = new Map();
    for (const row of commitments.rows) {
      if (row.status !== 'deducted' || !row.orderItemId) continue;
      costByOrderItemId.set(
        row.orderItemId,
        (costByOrderItemId.get(row.orderItemId) || 0) + Number(row.totalCost || 0),
      );
    }
    const margins = new Map();
    for (const { invoice } of paidOrders) {
      const bill = data.billByInvoiceId.get(invoice.id);
      for (const item of snapshotItems(bill)) {
        const line = invoice.lines.find((candidate) => (
          !candidate.isServiceLine
          && candidate.productId === item.productId
          && Number(candidate.qty) === Number(item.quantity)
          && (candidate.description || '') === (item.description || '')
        ));
        const key = `${item.productId}:${item.name}`;
        const row = margins.get(key) || {
          productId: item.productId,
          name: item.name || 'Restaurant item',
          quantity: 0,
          netSales: 0,
          cost: 0,
        };
        row.quantity += Number(item.quantity || 0);
        row.netSales += Number(item.total || 0) - Number(item.taxAmount || 0);
        row.cost += costByOrderItemId.get(item.itemId) ?? Number(line?.cogsAmount || 0);
        margins.set(key, row);
      }
    }
    const rows = [...margins.values()].map((row) => ({
      ...row,
      margin: row.netSales - row.cost,
      marginPct: row.netSales > 0 ? ((row.netSales - row.cost) / row.netSales) * 100 : null,
    })).sort((left, right) => right.margin - left.margin);
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      netSales: rows.reduce((total, row) => total + row.netSales, 0),
      cost: rows.reduce((total, row) => total + row.cost, 0),
      margin: rows.reduce((total, row) => total + row.margin, 0),
      rows,
    };
  }

  if (type === 'service-charges') {
    const orders = await prisma.restaurantOrder.findMany({
      where: { companyId, registerId },
      select: { id: true },
    });
    const bills = orders.length
      ? await prisma.restaurantBill.findMany({
        where: {
          companyId,
          orderId: { in: orders.map((order) => order.id) },
          createdAt: dateFilter,
          status: { in: ['issued', 'pending_payment', 'paid'] },
        },
        select: {
          id: true,
          orderId: true,
          checkNumber: true,
          serviceChargeAmount: true,
          serviceChargeTaxAmount: true,
          serviceChargeRatePct: true,
          serviceChargeMode: true,
          serviceChargeOverrideReason: true,
          serviceChargeOverriddenById: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      : [];
    const overrides = bills.filter((bill) => bill.serviceChargeOverrideReason);
    const managerIds = [...new Set(overrides.map((bill) => bill.serviceChargeOverriddenById).filter(Boolean))];
    const managers = managerIds.length
      ? await prisma.user.findMany({
        where: { companyId, id: { in: managerIds } },
        select: { id: true, name: true },
      })
      : [];
    const managerNames = new Map(managers.map((manager) => [manager.id, manager.name]));
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: bills.filter((bill) => Number(bill.serviceChargeAmount || 0) > 0).length,
      totalServiceCharge: bills.reduce((total, bill) => total + Number(bill.serviceChargeAmount || 0), 0),
      totalServiceChargeTax: bills.reduce((total, bill) => total + Number(bill.serviceChargeTaxAmount || 0), 0),
      overrideCount: overrides.length,
      overrides: overrides.map((bill) => ({
        id: bill.id,
        orderId: bill.orderId,
        checkNumber: bill.checkNumber,
        amount: Number(bill.serviceChargeAmount || 0),
        ratePct: bill.serviceChargeRatePct == null ? null : Number(bill.serviceChargeRatePct),
        mode: bill.serviceChargeMode,
        reason: bill.serviceChargeOverrideReason,
        managerId: bill.serviceChargeOverriddenById,
        managerName: managerNames.get(bill.serviceChargeOverriddenById) || null,
        createdAt: bill.createdAt,
      })),
    };
  }

  if (type === 'tips') {
    const [tips, payouts, reversals] = await Promise.all([
      prisma.restaurantTip.findMany({
        where: { companyId, registerId, createdAt: dateFilter },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.restaurantTipPayout.findMany({
        where: { companyId, registerId, createdAt: dateFilter },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.restaurantTipReversal.findMany({
        where: { companyId, registerId, createdAt: dateFilter },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const [allTips, allPayouts, allReversals] = await Promise.all([
      prisma.restaurantTip.findMany({ where: { companyId } }),
      prisma.restaurantTipPayout.findMany({ where: { companyId } }),
      prisma.restaurantTipReversal.findMany({ where: { companyId } }),
    ]);
    const waiterIds = [...new Set([
      ...tips.map((tip) => String(tip.waiterId)),
      ...payouts.map((payout) => String(payout.waiterId)),
      ...allTips.map((tip) => String(tip.waiterId)),
    ])];
    const users = waiterIds.length
      ? await prisma.user.findMany({
        where: { companyId, id: { in: waiterIds } },
        select: { id: true, name: true },
      })
      : [];
    const waiterNames = new Map(users.map((user) => [String(user.id), user.name]));
    const tipsById = new Map(allTips.map((tip) => [String(tip.id), tip]));
    const totalTips = tips.reduce((sum, tip) => sum + Number(tip.amount || 0), 0);
    const totalPayouts = payouts.reduce((sum, payout) => sum + Number(payout.amount || 0), 0);
    const totalReversals = reversals.reduce((sum, reversal) => sum + Number(reversal.amount || 0), 0);
    const balanceWaiterIds = [...new Set(allTips.map((tip) => String(tip.waiterId)))];
    const waiters = balanceWaiterIds.map((waiterId) => {
      const waiterTips = allTips.filter((tip) => String(tip.waiterId) === waiterId);
      const tipIds = new Set(waiterTips.map((tip) => String(tip.id)));
      const waiterReversals = allReversals.filter((reversal) => tipIds.has(String(reversal.tipId)));
      const waiterPayouts = allPayouts.filter((payout) => String(payout.waiterId) === waiterId);
      return {
        waiterId,
        name: waiterNames.get(waiterId) || waiterId,
        collected: waiterTips.reduce((sum, tip) => sum + Number(tip.amount || 0), 0),
        reversed: waiterReversals.reduce((sum, reversal) => sum + Number(reversal.amount || 0), 0),
        paidOut: waiterPayouts.reduce((sum, payout) => sum + Number(payout.amount || 0), 0),
        available: waiterTips.reduce((sum, tip) => sum + Number(tip.amount || 0), 0)
          - waiterReversals.reduce((sum, reversal) => sum + Number(reversal.amount || 0), 0)
          - waiterPayouts.reduce((sum, payout) => sum + Number(payout.amount || 0), 0),
        postingPending: [...waiterTips, ...waiterReversals, ...waiterPayouts]
          .some((row) => row.postingStatus !== 'posted'),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const availableByWaiter = new Map(waiters.map((waiter) => [waiter.waiterId, waiter.available]));
    const staffIds = [...new Set([
      ...reversals.map((reversal) => String(reversal.approvedById)),
      ...payouts.map((payout) => String(payout.approvedById)),
    ])];
    const staff = staffIds.length
      ? await prisma.user.findMany({
        where: { companyId, id: { in: staffIds } },
        select: { id: true, name: true },
      })
      : [];
    const staffNames = new Map(staff.map((user) => [String(user.id), user.name]));
    return {
      type,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totalTips,
      totalPayouts,
      totalReversals,
      netCashEffect: totalTips - totalPayouts - totalReversals,
      waiters,
      tips: tips.map((tip) => ({
        id: tip.id,
        billId: tip.billId,
        waiterId: tip.waiterId,
        waiterName: waiterNames.get(String(tip.waiterId)) || null,
        amount: Number(tip.amount),
        availableToReverse: Math.max(0, Math.min(
          Number(tip.amount) - allReversals
            .filter((reversal) => String(reversal.tipId) === String(tip.id))
            .reduce((sum, reversal) => sum + Number(reversal.amount || 0), 0),
          availableByWaiter.get(String(tip.waiterId)) || 0,
        )),
        captureMode: tip.captureMode,
        postingStatus: tip.postingStatus,
        createdAt: tip.createdAt,
      })),
      payouts: payouts.map((payout) => ({
        id: payout.id,
        waiterId: payout.waiterId,
        waiterName: waiterNames.get(String(payout.waiterId)) || null,
        amount: Number(payout.amount),
        reason: payout.reason,
        approvedById: payout.approvedById,
        approvedByName: staffNames.get(String(payout.approvedById)) || null,
        postingStatus: payout.postingStatus,
        createdAt: payout.createdAt,
      })),
      reversals: reversals.map((reversal) => ({
        id: reversal.id,
        tipId: reversal.tipId,
        waiterId: tipsById.get(String(reversal.tipId))?.waiterId || null,
        amount: Number(reversal.amount),
        reason: reversal.reason,
        approvedById: reversal.approvedById,
        approvedByName: staffNames.get(String(reversal.approvedById)) || null,
        postingStatus: reversal.postingStatus,
        createdAt: reversal.createdAt,
      })),
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

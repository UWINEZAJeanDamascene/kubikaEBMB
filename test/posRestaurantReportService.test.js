'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posRestaurantOrderService', () => ({
  listShiftHandoverOrders: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const restaurantOrderService = require('../services/posRestaurantOrderService');
const {
  getRestaurantReport,
  listRestaurantReportRegisters,
  reportRange,
} = require('../services/posRestaurantReportService');

const COMPANY_ID = 'a'.repeat(24);
const REGISTER_ID = 'b'.repeat(24);
const REGISTER_CODE = 'POS-1';

beforeEach(() => {
  jest.clearAllMocks();
  prisma.restaurantOrder = {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  };
  prisma.restaurantBill = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.posPayment = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.user = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.company = { findUnique: jest.fn().mockResolvedValue({ timezone: 'Africa/Kigali' }) };
  prisma.invoice = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.product = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.restaurantStockCommitment = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.restaurantTip = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.restaurantTipPayout = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.restaurantTipReversal = { findMany: jest.fn().mockResolvedValue([]) };
  prisma.posRegister = {
    findFirst: jest.fn().mockResolvedValue({
      id: REGISTER_ID,
      code: REGISTER_CODE,
      systemTillType: 'restaurant',
    }),
    findMany: jest.fn().mockResolvedValue([]),
  };
});

describe('Restaurant reports', () => {
  test('lists Restaurant registers and registers already associated with Restaurant orders', async () => {
    const registers = [{ id: REGISTER_ID, code: REGISTER_CODE, name: 'Dining room', isActive: true }];
    prisma.restaurantOrder.findMany.mockResolvedValue([{ registerId: REGISTER_ID }]);
    prisma.posRegister.findMany.mockResolvedValue(registers);

    await expect(listRestaurantReportRegisters(COMPANY_ID)).resolves.toEqual(registers);
    expect(prisma.posRegister.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: COMPANY_ID,
        OR: [
          { systemTillType: 'restaurant' },
          { id: { in: [REGISTER_ID] } },
        ],
      },
    }));
  });

  test('sales by item only queries completed paid bills and fully paid POS invoices', async () => {
    prisma.restaurantOrder = { findMany: jest.fn().mockResolvedValue([{ id: 'c'.repeat(24) }]) };
    prisma.restaurantBill = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'f'.repeat(24), totalAmount: 1200, status: 'pending_payment' }])
        .mockResolvedValueOnce([{ invoiceId: 'd'.repeat(24) }]),
    };
    prisma.invoice = {
      findMany: jest.fn().mockResolvedValue([{
        id: 'd'.repeat(24),
        totalAmount: 1200,
        lines: [{
          productId: 'e'.repeat(24),
          productName: 'Tea',
          qty: 2,
          lineTotal: 1200,
        }],
      }]),
    };

    const report = await getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'sales-by-item',
      from: '2026-11-01',
      to: '2026-11-30',
    });

    expect(prisma.restaurantBill.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: COMPANY_ID, status: 'paid' }),
    }));
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        posOrigin: true,
        status: 'fully_paid',
      }),
    }));
    expect(report).toMatchObject({
      invoiceCount: 1,
      totalSales: 1200,
      billsIssued: 1,
      billedTotal: 1200,
      items: [{ name: 'Tea', quantity: 2, sales: 1200 }],
    });
  });

    test('sales by hour uses the company timezone and includes empty hour buckets', async () => {
      const orderId = 'c'.repeat(24);
      const invoiceId = 'd'.repeat(24);
      prisma.restaurantOrder.findMany.mockResolvedValue([{
        id: orderId,
        waiterId: 'e'.repeat(24),
        status: 'paid',
        updatedAt: new Date('2026-11-12T14:30:00.000Z'),
      }]);
      prisma.restaurantBill.findMany.mockResolvedValue([{
        id: 'f'.repeat(24),
        orderId,
        invoiceId,
        totalAmount: 1200,
      }]);
      prisma.invoice.findMany.mockResolvedValue([{
        id: invoiceId,
        totalAmount: 1200,
        invoiceDate: new Date('2026-11-12T14:30:00.000Z'),
        lines: [],
      }]);

      const report = await getRestaurantReport({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        type: 'sales-by-hour',
        from: '2026-11-12',
        to: '2026-11-12',
      });

      expect(report).toMatchObject({
        timeZone: 'Africa/Kigali',
        invoiceCount: 1,
        totalSales: 1200,
        hours: expect.arrayContaining([{ hour: 16, invoiceCount: 1, sales: 1200 }]),
      });
      expect(report.hours).toHaveLength(24);
    });

    test('promotion and item-margin reports read saved invoice and stock snapshots', async () => {
      const orderId = 'c'.repeat(24);
      const invoiceId = 'd'.repeat(24);
      const menuProductId = 'e'.repeat(24);
      const itemId = 'f'.repeat(24);
      prisma.restaurantOrder.findMany.mockResolvedValue([{
        id: orderId,
        waiterId: '1'.repeat(24),
        status: 'paid',
        updatedAt: new Date('2026-11-12T14:30:00.000Z'),
      }]);
      prisma.restaurantBill.findMany.mockResolvedValue([{
        id: '2'.repeat(24),
        orderId,
        invoiceId,
        totalAmount: 95,
        lineSnapshot: {
          items: [{
            itemId,
            productId: menuProductId,
            name: 'Happy hour soda',
            quantity: 1,
            total: 95,
            taxAmount: 5,
            discountAmount: 5,
            promotionSnapshot: { id: '3'.repeat(24), name: 'Afternoon special' },
          }],
        },
      }]);
      prisma.invoice.findMany.mockResolvedValue([{
        id: invoiceId,
        totalAmount: 95,
        invoiceDate: new Date('2026-11-12T14:30:00.000Z'),
        lines: [{
          productId: menuProductId,
          productName: 'Happy hour soda',
          qty: 1,
          description: 'Happy hour soda',
          cogsAmount: 30,
          isServiceLine: false,
        }],
      }]);
      prisma.restaurantStockCommitment.findMany.mockResolvedValue([{
        orderId,
        orderItemId: itemId,
        productId: '4'.repeat(24),
        quantity: 1,
        sourceType: 'recipe',
        servingCount: 0,
        purchaseUnitCode: null,
        purchaseUnitVolume: null,
        status: 'deducted',
        totalCost: 30,
        closedAt: new Date('2026-11-12T14:30:00.000Z'),
        voidedAt: null,
      }]);
      prisma.product.findMany.mockResolvedValue([{ id: '4'.repeat(24), name: 'Soda syrup', unit: 'ml' }]);

      const promotionReport = await getRestaurantReport({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        type: 'promotion-effectiveness',
        from: '2026-11-12',
        to: '2026-11-12',
      });
      const marginReport = await getRestaurantReport({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        type: 'item-margin',
        from: '2026-11-12',
        to: '2026-11-12',
      });

      expect(promotionReport.rows).toEqual([expect.objectContaining({
        name: 'Afternoon special',
        itemCount: 1,
        discount: 5,
        sales: 95,
      })]);
      expect(marginReport.rows).toEqual([expect.objectContaining({
        name: 'Happy hour soda',
        netSales: 90,
        cost: 30,
        margin: 60,
      })]);
    });

    test('bar-measures report converts consumed base units into bottle equivalents', async () => {
      const orderId = 'c'.repeat(24);
      prisma.restaurantOrder.findMany.mockResolvedValue([{
        id: orderId,
        waiterId: null,
        status: 'paid',
        updatedAt: new Date('2026-11-12T14:30:00.000Z'),
      }]);
      prisma.restaurantBill.findMany.mockResolvedValue([]);
      prisma.restaurantStockCommitment.findMany.mockResolvedValue([{
        orderId,
        orderItemId: 'd'.repeat(24),
        productId: 'e'.repeat(24),
        quantity: 90,
        sourceType: 'bar_measure',
        servingCount: 3,
        purchaseUnitCode: 'bottle_750',
        purchaseUnitVolume: 750,
        status: 'deducted',
        totalCost: 450,
        closedAt: new Date('2026-11-12T14:30:00.000Z'),
        voidedAt: null,
      }]);
      prisma.product.findMany.mockResolvedValue([{ id: 'e'.repeat(24), name: 'Gin', unit: 'ml' }]);

      const report = await getRestaurantReport({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        type: 'bar-measures',
        from: '2026-11-12',
        to: '2026-11-12',
      });

      expect(report).toMatchObject({
        servings: 3,
        stockUsed: 90,
        cost: 450,
        rows: [expect.objectContaining({
          productName: 'Gin',
          bottleEquivalent: 0.12,
        })],
      });
    });

  test('open-order reports include billed amount, confirmed payments, and outstanding balance', async () => {
    restaurantOrderService.listShiftHandoverOrders.mockResolvedValue([
      { id: 'c'.repeat(24), status: 'open', itemCount: 2 },
    ]);
    prisma.restaurantBill.findMany.mockResolvedValue([{
      orderId: 'c'.repeat(24),
      invoiceId: 'd'.repeat(24),
      totalAmount: 1200,
    }]);
    prisma.posPayment.findMany.mockResolvedValue([
      { saleId: 'd'.repeat(24), amount: 500 },
      { saleId: 'd'.repeat(24), amount: 200 },
    ]);

    const report = await getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'open-orders',
      from: '2026-11-01',
      to: '2026-11-30',
    });

    expect(report).toMatchObject({
      count: 1,
      billedTotal: 1200,
      amountReceived: 700,
      orders: [{
        id: 'c'.repeat(24),
        billTotal: 1200,
        amountReceived: 700,
        balanceDue: 500,
      }],
    });
  });

  test('service-charge report summarizes fees and manager overrides', async () => {
    prisma.restaurantOrder.findMany.mockResolvedValue([{ id: 'c'.repeat(24) }]);
    prisma.restaurantBill.findMany.mockResolvedValue([
      {
        id: 'd'.repeat(24),
        orderId: 'c'.repeat(24),
        checkNumber: 1,
        serviceChargeAmount: 100,
        serviceChargeTaxAmount: 18,
        serviceChargeRatePct: 10,
        serviceChargeMode: 'income',
        serviceChargeOverrideReason: 'Guest complaint',
        serviceChargeOverriddenById: 'e'.repeat(24),
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
      },
      {
        id: 'f'.repeat(24),
        orderId: 'c'.repeat(24),
        checkNumber: 2,
        serviceChargeAmount: 0,
        serviceChargeTaxAmount: 0,
        serviceChargeRatePct: 0,
        serviceChargeMode: 'income',
        serviceChargeOverrideReason: 'Service issue',
        serviceChargeOverriddenById: 'e'.repeat(24),
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'e'.repeat(24), name: 'Manager' }]);

    const report = await getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'service-charges',
      from: '2026-11-01',
      to: '2026-11-30',
    });

    expect(report).toMatchObject({
      count: 1,
      totalServiceCharge: 100,
      totalServiceChargeTax: 18,
      overrideCount: 2,
      overrides: [
        { amount: 100, ratePct: 10, reason: 'Guest complaint', managerName: 'Manager' },
        { amount: 0, ratePct: 0, reason: 'Service issue', managerName: 'Manager' },
      ],
    });
  });

  test('rejects reversed and oversized report date ranges', () => {
    expect(() => reportRange('2026-12-01', '2026-11-30')).toThrow(
      'The report start date must be on or before its end date.',
    );
    expect(() => reportRange('2025-01-01', '2026-03-01')).toThrow(
      'Restaurant reports are limited to a 366-day date range.',
    );
  });

  test('reports cash tips separately and subtracts reversals and payouts from waiter liability', async () => {
    const waiterId = 'c'.repeat(24);
    const managerId = 'd'.repeat(24);
    const tip = {
      id: 'e'.repeat(24),
      billId: 'f'.repeat(24),
      waiterId,
      registerId: REGISTER_ID,
      amount: 500,
      captureMode: 'cash_tip',
      postingStatus: 'posted',
      createdAt: new Date('2026-11-12T10:00:00.000Z'),
    };
    const payout = {
      id: '1'.repeat(24),
      waiterId,
      registerId: REGISTER_ID,
      amount: 200,
      approvedById: managerId,
      postingStatus: 'posted',
      createdAt: new Date('2026-11-12T11:00:00.000Z'),
    };
    const reversal = {
      id: '2'.repeat(24),
      tipId: tip.id,
      registerId: REGISTER_ID,
      amount: 50,
      approvedById: managerId,
      postingStatus: 'posted',
      createdAt: new Date('2026-11-12T12:00:00.000Z'),
    };
    prisma.restaurantTip.findMany.mockImplementation(async ({ where }) => (
      where.createdAt ? [tip] : [tip]
    ));
    prisma.restaurantTipPayout.findMany.mockImplementation(async ({ where }) => (
      where.createdAt ? [payout] : [payout]
    ));
    prisma.restaurantTipReversal.findMany.mockImplementation(async ({ where }) => (
      where.createdAt ? [reversal] : [reversal]
    ));
    prisma.user.findMany.mockResolvedValue([
      { id: waiterId, name: 'Waiter A' },
      { id: managerId, name: 'Manager A' },
    ]);

    const report = await getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'tips',
      from: '2026-11-12',
      to: '2026-11-12',
    });

    expect(report).toMatchObject({
      totalTips: 500,
      totalPayouts: 200,
      totalReversals: 50,
      netCashEffect: 250,
      waiters: [{
        waiterId,
        name: 'Waiter A',
        collected: 500,
        reversed: 50,
        paidOut: 200,
        available: 250,
        postingPending: false,
      }],
      tips: [{ amount: 500, availableToReverse: 250, waiterName: 'Waiter A' }],
      payouts: [{ amount: 200, approvedByName: 'Manager A' }],
      reversals: [{ amount: 50, approvedByName: 'Manager A' }],
    });
  });

  test('rejects a register outside the company Restaurant register set', async () => {
    prisma.posRegister.findFirst.mockResolvedValue({
      id: REGISTER_ID,
      code: REGISTER_CODE,
      systemTillType: 'retail',
    });

    await expect(getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'shifts',
    })).rejects.toMatchObject({
      code: 'RESTAURANT_REPORT_REGISTER_NOT_FOUND',
      statusCode: 404,
    });
  });

  test('accepts a legacy till register that owns Restaurant orders', async () => {
    prisma.posRegister.findFirst.mockResolvedValue({
      id: REGISTER_ID,
      code: REGISTER_CODE,
      systemTillType: 'retail',
    });
    prisma.restaurantOrder.findFirst.mockResolvedValue({ id: 'c'.repeat(24) });
    prisma.posShift = { findMany: jest.fn().mockResolvedValue([]) };

    await expect(getRestaurantReport({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'shifts',
    })).resolves.toMatchObject({ type: 'shifts', shifts: [] });
  });
});

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

  test('rejects reversed and oversized report date ranges', () => {
    expect(() => reportRange('2026-12-01', '2026-11-30')).toThrow(
      'The report start date must be on or before its end date.',
    );
    expect(() => reportRange('2025-01-01', '2026-03-01')).toThrow(
      'Restaurant reports are limited to a 366-day date range.',
    );
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

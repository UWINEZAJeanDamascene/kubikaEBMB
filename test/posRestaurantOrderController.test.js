'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posRestaurantOrderService', () => ({
  carryOpenOrdersForShiftHandover: jest.fn(),
  notifyHandoverOrders: jest.fn(),
}));
jest.mock('../services/posRestaurantReportService', () => ({
  getRestaurantReport: jest.fn(),
  listRestaurantReportRegisters: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '192.0.2.10'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const orderService = require('../services/posRestaurantOrderService');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const {
  getReport,
  handoverOpenOrders,
  listReportRegisters,
} = require('../controllers/posRestaurantOrderController');
const reportService = require('../services/posRestaurantReportService');

const COMPANY_ID = 'a'.repeat(24);
const REGISTER_ID = 'b'.repeat(24);
const USER_ID = 'c'.repeat(24);
const NEXT_USER_ID = 'd'.repeat(24);
const SHIFT_ID = 'e'.repeat(24);

function createRequest() {
  return {
    body: { shiftId: SHIFT_ID, toUserId: NEXT_USER_ID },
    headers: {},
    ip: '192.0.2.10',
    posAuthContext: {
      company: { id: COMPANY_ID },
      register: { id: REGISTER_ID, code: 'POS-1' },
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID },
    },
  };
}

function createTransaction() {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SHIFT_ID }]),
    posShift: {
      findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID, openedById: USER_ID, shiftNumber: 4 }),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: NEXT_USER_ID }) },
    posRegisterAccess: {
      findUnique: jest.fn().mockResolvedValue({ companyId: COMPANY_ID, pinLockedUntil: null }),
    },
    posUserCredential: { findUnique: jest.fn().mockResolvedValue({ id: 'credential-id' }) },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  orderService.carryOpenOrdersForShiftHandover.mockResolvedValue({ orders: [] });
  runInTransaction.mockImplementation((callback) => callback(createTransaction()));
});

describe('Restaurant order handover controller', () => {
  test('validates the recipient, transfers orders transactionally, and records the handover', async () => {
    const tx = createTransaction();
    const orders = [{ id: 'f'.repeat(24), version: 3, waiterId: NEXT_USER_ID }];
    runInTransaction.mockImplementation((callback) => callback(tx));
    orderService.carryOpenOrdersForShiftHandover.mockResolvedValue({ orders });
    const res = createResponse();

    await handoverOpenOrders(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data.orders).toEqual(orders);
    expect(orderService.carryOpenOrdersForShiftHandover).toHaveBeenCalledWith(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: NEXT_USER_ID,
      shiftId: SHIFT_ID,
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'RESTAURANT_ORDERS_HANDED_OVER',
      metadata: expect.objectContaining({ shiftId: SHIFT_ID, toUserId: NEXT_USER_ID }),
    }), tx);
    expect(orderService.notifyHandoverOrders).toHaveBeenCalledWith(COMPANY_ID, orders);
  });

  test('does not transfer or count an unpaid issued Restaurant bill as a handover', async () => {
    const blockedOrders = [{ id: 'f'.repeat(24), status: 'billed', itemCount: 2 }];
    orderService.carryOpenOrdersForShiftHandover.mockResolvedValue({
      code: 'RESTAURANT_OPEN_BILLED_ORDERS_BLOCKED',
      blockedOrders,
    });
    const res = createResponse();

    await handoverOpenOrders(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_RESTAURANT_BILLS_UNPAID');
    expect(res.body.restaurantOpenOrders).toEqual(blockedOrders);
    expect(writePosAuditLog).not.toHaveBeenCalled();
    expect(orderService.notifyHandoverOrders).not.toHaveBeenCalled();
  });
});

describe('Restaurant report controller', () => {
  test('serves reports from the authenticated company without requiring a POS session', async () => {
    const report = { type: 'shifts', shifts: [] };
    reportService.getRestaurantReport.mockResolvedValue(report);
    const req = {
      user: { companyId: COMPANY_ID },
      query: { registerId: REGISTER_ID, type: 'shifts' },
    };
    const res = createResponse();

    await getReport(req, res, jest.fn());

    expect(res.body).toEqual({ success: true, data: report });
    expect(reportService.getRestaurantReport).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      type: 'shifts',
      from: undefined,
      to: undefined,
    });
  });

  test('lists Restaurant report registers in the authenticated company', async () => {
    const registers = [{ id: REGISTER_ID, name: 'Dining room' }];
    reportService.listRestaurantReportRegisters.mockResolvedValue(registers);
    const req = { user: { companyId: COMPANY_ID }, query: {} };
    const res = createResponse();

    await listReportRegisters(req, res, jest.fn());

    expect(res.body).toEqual({ success: true, data: registers });
    expect(reportService.listRestaurantReportRegisters).toHaveBeenCalledWith(COMPANY_ID);
  });
});

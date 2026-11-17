jest.mock('../models/TillSession', () => ({}));
jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../middleware/authorize', () => ({ PermissionService: {}, resolveUserRoles: jest.fn() }));
jest.mock('../utils/tillMappers', () => ({ tillSessionToApi: jest.fn((row) => row) }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posRegisterService', () => ({}));
jest.mock('../controllers/posManagerApprovalController', () => ({ consumeApproval: jest.fn() }));

const { runInTransaction } = require('../services/transactionService');
const { consumeApproval } = require('../controllers/posManagerApprovalController');
const { recordNoSale } = require('../controllers/tillController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const CASHIER_ID = '507f1f77bcf86cd799439012';
const TILL_ID = '507f1f77bcf86cd799439013';
const APPROVAL_ID = '507f1f77bcf86cd799439014';

function response() {
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

function request() {
  return {
    user: { id: CASHIER_ID, company: { _id: COMPANY_ID } },
    body: { tillSessionId: TILL_ID, approvalId: APPROVAL_ID },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('record POS no-sale drawer openings', () => {
  test('consumes manager approval and appends an attributable no-sale event', async () => {
    const updatedTill = { id: TILL_ID, status: 'open' };
    const tx = {
      $queryRawUnsafe: jest.fn((sql) => Promise.resolve(sql.includes('SELECT manager_id')
        ? [{ manager_id: '507f1f77bcf86cd799439015' }]
        : [{
          id: TILL_ID,
          opened_by: CASHIER_ID,
          register_id: 'POS-1234',
          cash_activity: [{ type: 'cash_sale', amount: 500 }],
        }])),
      tillSession: { update: jest.fn().mockResolvedValue(updatedTill) },
    };
    runInTransaction.mockImplementation((operation) => operation(tx));
    const res = response();

    await recordNoSale(request(), res, jest.fn());

    expect(consumeApproval).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      cashierId: CASHIER_ID,
      action: 'no_sale',
      subjectId: TILL_ID,
      payload: { tillSessionId: TILL_ID },
    });
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TILL_ID },
      data: { cashActivity: expect.arrayContaining([
        { type: 'cash_sale', amount: 500 },
        expect.objectContaining({
          type: 'no_sale',
          recordedBy: CASHIER_ID,
          approvedById: '507f1f77bcf86cd799439015',
        }),
      ]) },
    }));
    const savedActivity = tx.tillSession.update.mock.calls[0][0].data.cashActivity.find((activity) => activity.type === 'no_sale');
    expect(savedActivity.id).toMatch(/^[a-f\d]{24}$/i);
    expect(res.body).toEqual({
      success: true,
      data: { ...updatedTill, activityId: savedActivity.id },
    });
  });

  test('does not consume approval if the till is no longer owned and open', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      tillSession: { update: jest.fn() },
    };
    runInTransaction.mockImplementation((operation) => operation(tx));
    const res = response();

    await recordNoSale(request(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_TILL_SESSION_CHANGED');
    expect(consumeApproval).not.toHaveBeenCalled();
    expect(tx.tillSession.update).not.toHaveBeenCalled();
  });
});

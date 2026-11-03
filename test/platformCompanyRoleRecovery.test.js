'use strict';

jest.mock('../lib/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../services/CompanyService', () => ({}));
jest.mock('../services/UserService', () => ({}));
jest.mock('../services/AuditLogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/passwordUtils', () => ({}));
jest.mock('../services/tokenService', () => ({}));
jest.mock('../services/SubscriptionPlanService', () => ({}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/sequenceService', () => ({}));
jest.mock('../models/BankAccount', () => ({ BankAccount: {} }));
jest.mock('../constants/chartOfAccounts', () => ({ DEFAULT_ACCOUNTS: [] }));

const { prisma } = require('../lib/prisma');
const AuditLogService = require('../services/AuditLogService');
const { changeCompanyUserRole } = require('../controllers/companyController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';
const PLATFORM_OWNER_ID = '507f1f77bcf86cd799439013';
const ADMIN_ROLE_ID = '507f1f77bcf86cd799439014';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ currentRole = 'manager', roleExists = true, userExists = true } = {}) {
  const tx = {
    company: { findUnique: jest.fn().mockResolvedValue({ id: COMPANY_ID }) },
    user: {
      findFirst: jest.fn().mockResolvedValue(userExists ? {
        id: USER_ID, name: 'Jay Code', email: 'jay@example.test', role: currentRole,
      } : null),
      update: jest.fn().mockImplementation(({ data }) => ({
        id: USER_ID, name: 'Jay Code', email: 'jay@example.test', role: data.role, isActive: true,
      })),
    },
    role: { findFirst: jest.fn().mockResolvedValue(roleExists ? { id: ADMIN_ROLE_ID, name: 'admin' } : null) },
  };
  prisma.$transaction.mockImplementation((callback) => callback(tx));
  return tx;
}

function request(role = 'admin') {
  return {
    params: { id: COMPANY_ID, userId: USER_ID },
    body: { role, reason: 'Restore company administrator access' },
    user: { _id: PLATFORM_OWNER_ID },
  };
}

describe('platform owner company-role recovery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('updates the tenant user role and role assignment, and audits the before/after values', async () => {
    const tx = setup();
    const res = response();
    await changeCompanyUserRole(request(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.role).toBe('admin');
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: USER_ID, companyId: COMPANY_ID },
    }));
    expect(tx.role.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        name: { equals: 'admin', mode: 'insensitive' },
        OR: [{ isSystemRole: true }, { companyId: COMPANY_ID }],
      }),
    }));
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: USER_ID },
      data: {
        role: 'admin',
        roles: { deleteMany: {}, create: [{ roleId: ADMIN_ROLE_ID }] },
      },
    }));
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      userId: PLATFORM_OWNER_ID,
      action: 'company_user.role_changed_by_platform_owner',
      entityId: USER_ID,
      changes: expect.objectContaining({ previousRole: 'manager', newRole: 'admin', reason: request().body.reason }),
    }));
  });

  test('rejects a role assignment if the target user is outside the selected company', async () => {
    const tx = setup({ userExists: false });
    const res = response();
    await changeCompanyUserRole(request(), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('COMPANY_USER_NOT_FOUND');
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(AuditLogService.log).not.toHaveBeenCalled();
  });

  test('refuses platform-owner promotion through tenant role recovery', async () => {
    const tx = setup();
    const res = response();
    await changeCompanyUserRole(request('platform_admin'), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PLATFORM_ROLE_ASSIGNMENT_FORBIDDEN');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  test('requires a reason so emergency changes are attributable', async () => {
    setup();
    const res = response();
    await changeCompanyUserRole({ ...request(), body: { role: 'admin', reason: 'no' } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PLATFORM_ROLE_CHANGE_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

jest.mock('../services/UserService', () => ({
  inviteUserToCompany: jest.fn(),
}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    role: { findFirst: jest.fn() },
    department: { findFirst: jest.fn() },
  },
}));
jest.mock('../models/ActionLog', () => ({}));
jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));
jest.mock('../services/ebmBranchService', () => ({
  submitBranchUsers: jest.fn(),
}));
jest.mock('../utils/objectId', () => ({
  toIdString: (value) => String(value?._id || value),
}));
jest.mock('../utils/authMappers', () => ({
  userToApi: (user) => user,
  userInputToPrisma: (input) => ({ ...input }),
}));
jest.mock('../services/sessionService', () => ({}));
jest.mock('../utils/passwordUtils', () => ({}));
jest.mock('../src/config/environment', () => ({
  getConfig: () => ({ server: { env: 'test' }, session: { ttl: 3600 } }),
}));

const { prisma } = require('../lib/prisma');
const UserService = require('../services/UserService');
const Warehouse = require('../models/Warehouse');
const EBMBranchService = require('../services/ebmBranchService');
const userController = require('../controllers/userController');
const userAuthController = require('../controllers/userAuthController');

function makeResponse() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('branch user assignment controllers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    prisma.user.update.mockResolvedValue({ id: 'user-1', branchId: 'branch-1' });
  });

  it('validates a branch against the active company before updating assignment', async () => {
    Warehouse.findOne.mockResolvedValue(null);
    const req = {
      params: { id: 'user-1' },
      body: { branch: 'foreign-branch' },
      user: { id: 'admin-1', company: { _id: 'company-1' } },
    };
    const res = makeResponse();

    await userController.updateUser(req, res, jest.fn());

    expect(Warehouse.findOne).toHaveBeenCalledWith({
      _id: 'foreign-branch',
      company: 'company-1',
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('persists an explicitly selected company branch on user update', async () => {
    Warehouse.findOne.mockResolvedValue({ _id: 'branch-1', company: 'company-1' });
    const req = {
      params: { id: 'user-1' },
      body: { branch: 'branch-1' },
      user: { id: 'admin-1', company: { _id: 'company-1' } },
    };
    const res = makeResponse();

    await userController.updateUser(req, res, jest.fn());

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: expect.objectContaining({ branchId: 'branch-1' }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ branchId: 'branch-1' }),
    }));
  });

  it('clears the branch assignment when the admin submits an empty branch', async () => {
    const req = {
      params: { id: 'user-1' },
      body: { branch: null },
      user: { id: 'admin-1', company: { _id: 'company-1' } },
    };
    const res = makeResponse();

    await userController.updateUser(req, res, jest.fn());

    expect(Warehouse.findOne).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: expect.objectContaining({ branchId: null }),
    }));
  });

  it('assigns invited users in the authenticated company and returns blocked RRA status', async () => {
    Warehouse.findOne.mockResolvedValue({
      _id: 'branch-1',
      company: 'company-1',
      rraBranchId: '01',
    });
    UserService.inviteUserToCompany.mockResolvedValue({
      user: { _id: 'user-1' },
      isNewUser: true,
      invitationEmailSent: true,
      message: 'Invitation sent',
    });
    EBMBranchService.submitBranchUsers.mockResolvedValue({
      status: 'blocked',
      message: 'Live submission is not enabled',
    });
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 'user-1',
      companyId: 'company-1',
      branchId: 'branch-1',
    });
    const req = {
      body: { email: 'user@example.test', branch: 'branch-1' },
      user: { id: 'admin-1', company: { _id: 'company-1' } },
    };
    const res = makeResponse();

    await userAuthController.inviteUser(req, res, jest.fn());

    expect(Warehouse.findOne).toHaveBeenCalledWith({
      _id: 'branch-1',
      company: 'company-1',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1', companyId: 'company-1' },
      data: { branchId: 'branch-1' },
    });
    expect(EBMBranchService.submitBranchUsers).toHaveBeenCalledWith(
      'company-1',
      '01',
      req.user,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      branchUserSubmission: expect.objectContaining({ status: 'blocked' }),
      data: expect.objectContaining({ branchId: 'branch-1' }),
    }));
  });
});

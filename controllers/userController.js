const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { userToApi, userInputToPrisma } = require('../utils/authMappers');
const ActionLog = require('../models/ActionLog');
const UserService = require('../services/UserService');
const Warehouse = require('../models/Warehouse');
const EBMBranchService = require('../services/ebmBranchService');

const companyIdOf = (req) => toIdString(req.user.company._id || req.user.company);

// @desc    Get all users
// @route   GET /api/users
// @access  Private (admin)
exports.getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, isActive, search } = req.query;

    // Multi-tenancy: Filter by company
    const where = { companyId: companyIdOf(req) };

    if (role) {
      where.role = role;
    }

    if (isActive !== undefined) {
      where.isActive = isActive === 'true';
    }
    if (String(search || '').trim()) {
      const term = String(search).trim().slice(0, 120);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { role: { contains: term, mode: 'insensitive' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [total, active, inactive, administrators, roles, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.count({ where: { ...where, isActive: true } }),
      prisma.user.count({ where: { ...where, isActive: false } }),
      prisma.user.count({ where: { ...where, role: 'admin' } }),
      prisma.role.findMany({
        where: { OR: [{ isSystemRole: true }, { companyId: companyIdOf(req) }] },
        select: { name: true },
      }),
      prisma.user.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    res.json({
      success: true,
      count: users.length,
      total,
      pages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      summary: { total, active, inactive, administrators, roles: roles.length },
      data: users.map(userToApi)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (admin)
exports.getUser = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a user through the secure invitation flow
// @route   POST /api/users
// @access  Private (admin)
exports.createUser = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    if (req.body.password) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_MUST_BE_SET_BY_INVITEE',
        message: 'Passwords are set by the invited user through the secure email link. Do not send passwords through user management.',
      });
    }
    const branchId = req.body.branch || req.body.defaultWarehouse;
    const branch = branchId ? await Warehouse.findOne({ _id: branchId, company: companyId }) : null;
    if (branchId && !branch) return res.status(400).json({ success: false, message: 'Select a branch in this company' });
    const result = await UserService.inviteUserToCompany(req.user.id, {
      name: req.body.name,
      email: req.body.email,
      role: req.body.role,
      departmentId: req.body.departmentId || req.body.department || null,
      companyId,
    });
    if (branchId) {
      await prisma.user.update({ where: { id: result.user._id, companyId }, data: { branchId: toIdString(branchId) } });
      result.user.branch = toIdString(branchId);
      if (branch.rraBranchId) {
        result.branchUserSubmission = await EBMBranchService.submitBranchUsers(companyId, branch.rraBranchId, req.user);
        const updatedUser = await prisma.user.findFirst({
          where: { id: result.user._id, companyId },
          include: { roles: { include: { role: true } } },
        });
        result.user = userToApi(updatedUser);
      }
    }
    res.status(201).json({
      success: true,
      data: result.user,
      isNewUser: result.isNewUser,
      invitationEmailSent: result.invitationEmailSent,
      message: result.message,
      ...(result.branchUserSubmission ? { branchUserSubmission: result.branchUserSubmission } : {}),
    });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'An account with this email is already present in the workspace', code: 'USER_ALREADY_MEMBER' });
    if (error.code === 'USER_ALREADY_MEMBER') return res.status(409).json({ success: false, message: 'User is already a member of this company', code: error.code });
    if (['INVALID_ROLE', 'INVALID_DEPARTMENT', 'USER_BELONGS_TO_OTHER_COMPANY'].includes(error.code)) {
      const messages = {
        INVALID_ROLE: 'The selected role is not available in this company.',
        INVALID_DEPARTMENT: 'The selected department is not active in this company.',
        USER_BELONGS_TO_OTHER_COMPANY: 'This email already belongs to another company. Multi-company account invitations are not supported yet.',
      };
      return res.status(409).json({ success: false, code: error.code, message: messages[error.code] });
    }
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (admin)
exports.updateUser = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);

    // Don't allow password update through this route
    delete req.body.password;
    // Don't allow changing company
    delete req.body.company;

    const existing = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const data = userInputToPrisma(req.body);

    // If role is being updated, also relink the roles join table with the
    // corresponding Role (system role OR company custom role)
    if (req.body.role) {
      const roleDoc = await prisma.role.findFirst({
        where: {
          name: String(req.body.role).trim(),
          OR: [{ isSystemRole: true }, { companyId }],
        },
      });
      if (!roleDoc) return res.status(400).json({ success: false, code: 'INVALID_ROLE', message: 'Select a valid system or company role' });
      if (roleDoc.name === 'platform_admin' && req.user.role !== 'platform_admin') {
        return res.status(403).json({ success: false, code: 'PLATFORM_ROLE_ASSIGNMENT_FORBIDDEN', message: 'Only a platform administrator can assign the platform administrator role' });
      }
      data.role = roleDoc.name;
      data.roles = { deleteMany: {}, create: [{ roleId: roleDoc.id }] };
    }

    const departmentValue = req.body.departmentId !== undefined ? req.body.departmentId : req.body.department;
    if (departmentValue) {
      const department = await prisma.department.findFirst({
        where: { id: toIdString(departmentValue), companyId, isActive: true },
        select: { id: true },
      });
      if (!department) return res.status(400).json({ success: false, code: 'INVALID_DEPARTMENT', message: 'Select an active department in this company' });
      data.departmentId = department.id;
    } else if (departmentValue === null || departmentValue === '') {
      data.departmentId = null;
    }

    const branchWasProvided = Object.prototype.hasOwnProperty.call(req.body, 'branch')
      || Object.prototype.hasOwnProperty.call(req.body, 'defaultWarehouse');
    const assignedBranch = Object.prototype.hasOwnProperty.call(req.body, 'branch')
      ? req.body.branch
      : req.body.defaultWarehouse;
    let branch = null;
    if (branchWasProvided && assignedBranch) {
      branch = await Warehouse.findOne({ _id: assignedBranch, company: companyId });
      if (!branch) return res.status(400).json({ success: false, code: 'INVALID_BRANCH', message: 'Select a branch in this company' });
      data.branchId = toIdString(assignedBranch);
    } else if (branchWasProvided) {
      data.branchId = null;
    }

    let user = await prisma.user.update({
      where: { id: existing.id },
      data,
      include: { roles: { include: { role: true } } },
    });

    let branchUserSubmission = null;
    if (branch?.rraBranchId) {
      branchUserSubmission = await EBMBranchService.submitBranchUsers(companyId, branch.rraBranchId, req.user);
      user = await prisma.user.findFirst({
        where: { id: existing.id, companyId },
        include: { roles: { include: { role: true } } },
      });
    }

    res.json({
      success: true,
      data: userToApi(user),
      ...(branchUserSubmission ? { branchUserSubmission } : {}),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update current user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = toIdString(req.user._id);

    // Only allow specific fields for profile update
    const allowedFields = ['name', 'email', 'phone', 'jobTitle', 'bio', 'avatar'];
    const updateData = {};

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // If a file was uploaded via multipart/form-data (avatar), set avatar URL
    if (req.file) {
      updateData.avatar = `/uploads/users/${req.file.filename}`;
    }

    let user;
    try {
      user = await prisma.user.update({
        where: { id: userId },
        data: userInputToPrisma(updateData),
      });
    } catch (e) {
      if (e.code === 'P2025') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      throw e;
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user._id) } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: userToApi(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (admin)
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deleting yourself
    if (user.id === toIdString(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    await prisma.user.delete({ where: { id: user.id } });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset user password (Admin only)
// @route   POST /api/users/:id/reset-password
// @access  Private (admin)
exports.resetPassword = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);

    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.body.newPassword) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_MUST_BE_SET_BY_USER',
        message: 'Administrators cannot set or view a user password. Send a secure reset link instead.',
      });
    }

    await UserService.requestPasswordReset(user.email);
    return res.json({
      success: true,
      emailSent: true,
      message: `Password reset link sent to ${user.email}`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle user active status (Admin only)
// @route   PUT /api/users/:id/toggle-status
// @access  Private (admin)
exports.toggleUserStatus = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId: companyIdOf(req) },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deactivating yourself
    if (user.id === toIdString(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isActive: !user.isActive },
    });

    res.json({
      success: true,
      data: userToApi(updated),
      message: updated.isActive ? 'User activated successfully' : 'User deactivated successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.resendInvitation = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const result = await UserService.resendUserInvitation(req.user.id, companyId, req.params.id);
    res.json({
      success: true,
      invitationEmailSent: result.invitationEmailSent,
      message: result.invitationEmailSent
        ? 'Password setup invitation sent'
        : 'Email was not delivered; check notification and provider settings',
    });
  } catch (error) {
    if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ success: false, message: 'User not found' });
    if (error.code === 'INVITATION_NOT_PENDING') return res.status(409).json({ success: false, message: 'This user has already completed password setup' });
    next(error);
  }
};

// @desc    Get user action logs
// @route   GET /api/users/:id/action-logs
// @access  Private (admin)
exports.getUserActionLogs = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const { page = 1, limit = 50, module } = req.query;

    // First verify user belongs to company
    const user = await prisma.user.findFirst({
      where: { id: toIdString(req.params.id), companyId },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Action logs are still Mongo-backed until their own migration phase
    const query = { user: req.params.id, company: companyId };

    if (module) {
      query.module = module;
    }

    const total = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: logs.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: logs
    });
  } catch (error) {
    next(error);
  }
};

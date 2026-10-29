const CompanyService = require('../services/CompanyService');
const AuditLogService = require('../services/AuditLogService');
const UserService = require('../services/UserService');
const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const passwordUtils = require('../utils/passwordUtils');
const TokenService = require('../services/tokenService');
const SubscriptionPlanService = require('../services/SubscriptionPlanService');
const JournalService = require('../services/journalService');
const SequenceService = require('../services/sequenceService');
const { BankAccount } = require('../models/BankAccount');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

/**
 * Company Controller
 * Handles company profile CRUD operations
 */

// Create company (super-admin only)
exports.createCompany = async (req, res) => {
  try {
    const { user } = req;
    
    // Only platform admin can create companies
    if (user.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: Only platform admin can create companies'
      });
    }

    const company = await CompanyService.create(req.body, user._id);

    res.status(201).json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get company by ID
exports.getCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await CompanyService.getById(id);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get all companies (platform admin)
exports.getAllCompanies = async (req, res) => {
  try {
    const { user } = req;
    
    // Only platform admin can list all companies
    if (user.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: Only platform admin can list all companies'
      });
    }

    const { page, limit, isActive } = req.query;
    const result = await CompanyService.getAll({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      isActive: isActive !== undefined ? isActive === 'true' : undefined
    });

    res.json({
      success: true,
      data: result.companies,
      pagination: result.pagination
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Update current user's company
exports.updateMyCompany = async (req, res) => {
  try {
    const companyRef = req.user.company;
    const companyId = req.companyId || (companyRef ? (companyRef._id ? companyRef._id.toString() : companyRef.toString()) : null);

    if (!companyId) {
      return res.status(400).json({
        success: false,
        error: 'NO_COMPANY',
        message: 'User is not associated with a company'
      });
    }

    const company = await CompanyService.update(companyId, req.body, req.user._id);;

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Update company
exports.updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    // Users can only update their own company
    if (user.company && user.company.toString() !== id) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: You can only update your own company'
      });
    }

    const company = await CompanyService.update(id, req.body, user._id);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('NOT_FOUND') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
};

// Upload logo
exports.uploadLogo = async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    // Users can only update their own company logo
    if (user.company && user.company.toString() !== id) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: You can only update your own company logo'
      });
    }

    // Accept either a provided `logo_url` or an uploaded file (multipart/form-data)
    let logo_url = req.body.logo_url;
    if (!logo_url && req.file) {
      // Build a relative URL to the uploaded file
      const urlPath = `/uploads/companies/${req.file.filename}`;
      logo_url = urlPath;
    }

    if (!logo_url) {
      return res.status(400).json({
        success: false,
        error: 'LOGO_URL_REQUIRED'
      });
    }

    const company = await CompanyService.uploadLogo(id, logo_url, user._id);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Get setup status
exports.getSetupStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const status = await CompanyService.getSetupStatus(id);

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Mark setup step complete
exports.markSetupStepComplete = async (req, res) => {
  try {
    const { id, step } = req.params;
    const { user } = req;

    // Users can only update their own company
    if (user.company && user.company.toString() !== id) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: You can only update your own company'
      });
    }

    const company = await CompanyService.markSetupStepComplete(id, step);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// Delete company (soft delete)
exports.deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    // Only platform admin can delete companies
    if (user.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN: Only platform admin can delete companies'
      });
    }

    const company = await CompanyService.delete(id, user._id);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

/** POST /api/companies/register — public */
exports.registerPublic = async (req, res) => {
  try {
    const { company, admin } = req.body;
    const result = await CompanyService.registerPublicCompany({ company, admin });
    res.status(201).json({
      success: true,
      message: 'Registration submitted. A platform administrator will review your application.',
      data: {
        company: {
          _id: result.company._id,
          name: result.company.name,
          email: result.company.email,
          status: result.company.approvalStatus
        },
        user: { _id: result.user._id, email: result.user.email }
      }
    });
  } catch (error) {
    const code = error.code || error.message;
    if (code === 'COMPANY_EMAIL_ALREADY_REGISTERED') {
      return res.status(409).json({
        success: false,
        message: 'A company with this business email is already registered',
        code
      });
    }
    if (code === 'INVALID_SUBSCRIPTION_PLAN') {
      return res.status(400).json({
        success: false,
        message: 'Please select an active subscription plan.'
      });
    }
    if (code === 'EMAIL_NOT_AVAILABLE') {
      return res.status(409).json({
        success: false,
        message: 'This email cannot be used for registration',
        code
      });
    }
    if (code === 'DUPLICATE_USER_EMAIL_FOR_COMPANY' || code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists for this registration',
        code: 'DUPLICATE_USER_EMAIL_FOR_COMPANY'
      });
    }
    if (code === 'PASSWORD_TOO_SHORT') {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters', code });
    }
    if (code === 'PASSWORD_POLICY_VIOLATION') {
      return res.status(400).json({ success: false, message: error.message, code });
    }
    if (error.message === 'MISSING_REQUIRED_FIELDS') {
      return res.status(400).json({ success: false, message: 'Please fill in all required fields' });
    }
    console.error('registerPublic:', error);
    res.status(500).json({ success: false, message: error.message || 'Registration failed' });
  }
};

/** GET /api/companies/pending — platform_admin */
exports.getPendingCompanies = async (req, res) => {
  try {
    const data = await CompanyService.listCompaniesByApprovalStatus('pending');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load pending companies' });
  }
};

/** GET /api/companies/rejected — platform_admin */
exports.getRejectedCompanies = async (req, res) => {
  try {
    const data = await CompanyService.listCompaniesByApprovalStatus('rejected');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load rejected companies' });
  }
};

/** GET /api/companies/platform-dashboard — platform_admin */
exports.getPlatformDashboard = async (req, res) => {
  try {
    const data = await CompanyService.getPlatformDashboard();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load platform dashboard' });
  }
};

/** GET /api/companies/platform-analytics — platform_admin */
exports.getPlatformAnalytics = async (req, res) => {
  try {
    const data = await CompanyService.getPlatformAnalytics();
    res.json({ success: true, data });
  } catch (error) {
    console.error('getPlatformAnalytics error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to load analytics' });
  }
};

/** PUT /api/companies/:id/platform-access — platform_admin */
exports.updatePlatformAccess = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await CompanyService.updatePlatformAccess(id, req.body, req.user._id);
    res.json({ success: true, message: 'Platform access updated', data: company });
  } catch (error) {
    if (error.message === 'COMPANY_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to update platform access' });
  }
};

/** POST /api/companies/:id/payment-reminder — platform_admin */
exports.sendPaymentReminder = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await CompanyService.sendPaymentReminder(id, req.body || {}, req.user._id);
    res.json({ success: true, message: 'Payment reminder processed', data: result });
  } catch (error) {
    if (error.message === 'COMPANY_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to send payment reminder' });
  }
};

/** POST /api/companies/platform-broadcast — platform_admin */
exports.broadcastPlatformUpdate = async (req, res) => {
  try {
    const result = await CompanyService.broadcastPlatformUpdate(req.body || {}, req.user._id);
    res.json({ success: true, message: 'Platform update processed', data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to send platform update' });
  }
};

/** GET /api/companies/platform-audit-logs — platform_admin */
exports.getPlatformAuditLogs = async (req, res) => {
  try {
    const { action, entity_type, entity_id, date_from, date_to, status, company_id, page = 1, per_page = 50 } = req.query;

    const filters = {
      action,
      entityType: entity_type,
      entityId: entity_id,
      dateFrom: date_from,
      dateTo: date_to,
      status,
      companyId: company_id
    };

    const options = {
      page: parseInt(page) || 1,
      perPage: parseInt(per_page) || 50
    };

    const result = await AuditLogService.queryPlatformLogs(filters, options);

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('getPlatformAuditLogs error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to load audit logs' });
  }
};

/** GET /api/companies/:id/users — platform_admin */
exports.getCompanyUsers = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50, role, isActive, search } = req.query;

    const result = await UserService.getUsers(id, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      role,
      isActive,
      search
    });

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('getCompanyUsers error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to load company users' });
  }
};

/** PUT /api/companies/:id/approve — platform_admin */
exports.approveCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await CompanyService.approveCompanyById(id, req.user._id);
    res.json({
      success: true,
      message: 'Company approved successfully',
      data: company
    });
  } catch (error) {
    if (error.message === 'COMPANY_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }
    if (error.message === 'COMPANY_NOT_PENDING') {
      return res.status(400).json({ success: false, message: 'Company is not awaiting approval' });
    }
    res.status(500).json({ success: false, message: error.message || 'Approval failed' });
  }
};

/** PUT /api/companies/:id/reject — platform_admin */
exports.rejectCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = req.body && req.body.reason;
    const company = await CompanyService.rejectCompanyById(id, reason, req.user._id);
    res.json({
      success: true,
      message: 'Company registration rejected',
      data: company
    });
  } catch (error) {
    if (error.message === 'COMPANY_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }
    if (error.message === 'COMPANY_NOT_PENDING') {
      return res.status(400).json({ success: false, message: 'Company is not awaiting approval' });
    }
    res.status(500).json({ success: false, message: error.message || 'Rejection failed' });
  }
};

// Get current user's company
exports.getMyCompany = async (req, res) => {
  try {
    // Get company ID from user's company field (works for both regular and platform admin users)
    const companyRef = req.user.company;
    const companyId = req.companyId || (companyRef ? (companyRef._id ? companyRef._id.toString() : companyRef.toString()) : null);

    if (!companyId) {
      return res.status(400).json({
        success: false,
        error: 'NO_COMPANY',
        message: 'User is not associated with a company'
      });
    }

    const company = await CompanyService.getProfileById(companyId);

    // Get system settings
    const SystemSettingsService = require('../services/systemSettingsService');
    let settings = null;
    try {
      settings = await SystemSettingsService.get(companyId);
    } catch {
      // Settings may not exist yet
    }

    res.json({
      success: true,
      data: company,
      settings: settings
    });
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

/** POST /api/companies/:id/users/:userId/impersonate — platform_admin */
exports.impersonateUser = async (req, res) => {
  try {
    const { id, userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: toIdString(userId) },
      include: { company: { select: { id: true, name: true, email: true } } },
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Verify user belongs to the specified company
    if (user.companyId !== toIdString(id)) {
      return res.status(400).json({ success: false, message: 'User does not belong to this company' });
    }

    const memberships = [{
      companyId: user.companyId || null,
      role: user.role
    }];

    const { access_token, refresh_token } = await TokenService.generateTokenPair(user.id, memberships);

    await AuditLogService.log({
      companyId: user.companyId || null,
      userId: req.user._id,
      action: 'user.impersonated',
      entityType: 'user',
      entityId: user.id,
      changes: { impersonatedUserEmail: user.email }
    });

    res.json({
      success: true,
      data: {
        access_token,
        refresh_token,
        user: {
          _id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          company: user.company
            ? { _id: user.company.id, name: user.company.name, email: user.company.email }
            : null
        }
      }
    });
  } catch (error) {
    console.error('impersonateUser error:', error);
    res.status(500).json({ success: false, message: error.message || 'Impersonation failed' });
  }
};

/** POST /api/companies/:id/users/:userId/force-password-reset — platform_admin */
exports.forcePasswordReset = async (req, res) => {
  try {
    const { id, userId } = req.params;

    const user = await prisma.user.findUnique({ where: { id: toIdString(userId) } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.companyId !== toIdString(id)) {
      return res.status(400).json({ success: false, message: 'User does not belong to this company' });
    }

    // Generate temporary password
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let tempPassword = '';
    for (let i = 0; i < 10; i++) {
      tempPassword += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await passwordUtils.hash(tempPassword),
        mustChangePassword: true,
        tempPassword: true,
      },
    });

    await AuditLogService.log({
      companyId: user.companyId || null,
      userId: req.user._id,
      action: 'user.force_password_reset',
      entityType: 'user',
      entityId: user.id,
      changes: { targetEmail: user.email }
    });

    res.json({
      success: true,
      message: 'Password reset successfully',
      data: {
        tempPassword,
        user: { _id: user.id, name: user.name, email: user.email }
      }
    });
  } catch (error) {
    console.error('forcePasswordReset error:', error);
    res.status(500).json({ success: false, message: error.message || 'Password reset failed' });
  }
};

/** GET /api/companies/subscription-plans — platform_admin */
exports.getSubscriptionPlans = async (req, res) => {
  try {
    // The registration page is public, so it may be the first endpoint hit
    // after deployment. Ensure the standard package catalog exists first.
    await SubscriptionPlanService.seedDefaultPlans();
    const activeOnly = req.query.active === 'true';
    const plans = await SubscriptionPlanService.getAllPlans(activeOnly);
    res.json({ success: true, data: plans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load plans' });
  }
};

/** POST /api/companies/subscription-plans — platform_admin */
exports.createSubscriptionPlan = async (req, res) => {
  try {
    const plan = await SubscriptionPlanService.createPlan(req.body);
    await AuditLogService.log({
      companyId: null,
      userId: req.user._id,
      action: 'subscription_plan.created',
      entityType: 'subscription_plan',
      entityId: plan._id,
      changes: { key: plan.key, name: plan.name }
    });
    res.status(201).json({ success: true, data: plan });
  } catch (error) {
    if (error.code === 'PLAN_KEY_EXISTS') {
      return res.status(409).json({ success: false, message: 'Plan key already exists' });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to create plan' });
  }
};

/** PUT /api/companies/subscription-plans/:key — platform_admin */
exports.updateSubscriptionPlan = async (req, res) => {
  try {
    const { key } = req.params;
    const plan = await SubscriptionPlanService.updatePlan(key, req.body);
    await AuditLogService.log({
      companyId: null,
      userId: req.user._id,
      action: 'subscription_plan.updated',
      entityType: 'subscription_plan',
      entityId: plan._id,
      changes: req.body
    });
    res.json({ success: true, data: plan });
  } catch (error) {
    if (error.code === 'PLAN_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to update plan' });
  }
};

/** DELETE /api/companies/subscription-plans/:key — platform_admin */
exports.deleteSubscriptionPlan = async (req, res) => {
  try {
    const { key } = req.params;
    await SubscriptionPlanService.deletePlan(key);
    await AuditLogService.log({
      companyId: null,
      userId: req.user._id,
      action: 'subscription_plan.deleted',
      entityType: 'subscription_plan',
      entityId: key,
      changes: { key }
    });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    if (error.code === 'PLAN_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to delete plan' });
  }
};

// ── Capital Management ────────────────────────────────────────────────

/** POST /api/companies/capital/share */
exports.recordShareCapital = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { amount, description, date, bankAccountId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const txDate = date ? new Date(date) : new Date();
    const narration = description || 'Share capital injection';

    // Determine bank account
    let bankAccount = null;
    let bankLedgerCode = DEFAULT_ACCOUNTS.cashAtBank;
    if (bankAccountId) {
      bankAccount = await BankAccount.findOne({ _id: bankAccountId, company: companyId, isActive: true });
      if (bankAccount && bankAccount.ledgerAccountId) {
        bankLedgerCode = bankAccount.ledgerAccountId;
      }
    }

    // Journal: Dr Bank / Cr Share Capital (3000)
    const journalEntry = await JournalService.createEntry(companyId, req.user._id, {
      date: txDate,
      description: narration,
      sourceType: 'capital_injection',
      sourceId: req.user._id,
      sourceReference: 'Share Capital',
      lines: [
        JournalService.createDebitLine(bankLedgerCode, amount, narration),
        JournalService.createCreditLine(DEFAULT_ACCOUNTS.shareCapital, amount, narration)
      ],
      isAutoGenerated: true
    });

    // Bank transaction
    let bankTransaction = null;
    if (bankAccount) {
      try {
        bankTransaction = await bankAccount.addTransaction({
          type: 'deposit',
          amount,
          description: narration,
          date: txDate,
          referenceNumber: journalEntry.entryNumber,
          referenceType: 'CapitalInjection',
          reference: journalEntry._id,
          createdBy: req.user._id,
          notes: 'Share capital recorded',
          journalEntryId: journalEntry._id
        });
      } catch (btErr) {
        console.error('BankTransaction creation failed for share capital:', btErr.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Share capital recorded successfully',
      data: { journalEntry, bankTransaction }
    });
  } catch (error) {
    console.error('Error recording share capital:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to record share capital' });
  }
};

/** POST /api/companies/capital/owner */
exports.recordOwnerCapital = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { amount, description, date, bankAccountId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const txDate = date ? new Date(date) : new Date();
    const narration = description || 'Owner capital contribution';

    // Determine bank account
    let bankAccount = null;
    let bankLedgerCode = DEFAULT_ACCOUNTS.cashAtBank;
    if (bankAccountId) {
      bankAccount = await BankAccount.findOne({ _id: bankAccountId, company: companyId, isActive: true });
      if (bankAccount && bankAccount.ledgerAccountId) {
        bankLedgerCode = bankAccount.ledgerAccountId;
      }
    }

    // Journal: Dr Bank / Cr Opening Balance Equity (3500) — used for owner contributions
    const journalEntry = await JournalService.createEntry(companyId, req.user._id, {
      date: txDate,
      description: narration,
      sourceType: 'capital_injection',
      sourceId: req.user._id,
      sourceReference: 'Owner Capital',
      lines: [
        JournalService.createDebitLine(bankLedgerCode, amount, narration),
        JournalService.createCreditLine(DEFAULT_ACCOUNTS.openingBalanceEquity, amount, narration)
      ],
      isAutoGenerated: true
    });

    // Bank transaction
    let bankTransaction = null;
    if (bankAccount) {
      try {
        bankTransaction = await bankAccount.addTransaction({
          type: 'deposit',
          amount,
          description: narration,
          date: txDate,
          referenceNumber: journalEntry.entryNumber,
          referenceType: 'CapitalInjection',
          reference: journalEntry._id,
          createdBy: req.user._id,
          notes: 'Owner capital recorded',
          journalEntryId: journalEntry._id
        });
      } catch (btErr) {
        console.error('BankTransaction creation failed for owner capital:', btErr.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Owner capital recorded successfully',
      data: { journalEntry, bankTransaction }
    });
  } catch (error) {
    console.error('Error recording owner capital:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to record owner capital' });
  }
};

/** GET /api/companies/platform-security-stats — platform_admin */
exports.getPlatformSecurityStats = async (req, res) => {
  try {
    // Action/audit logs and IP whitelist are still Mongo-backed until their own migration phase
    const ActionLog = require('../models/ActionLog');
    const AuditLog = require('../models/AuditLog');
    const IPWhitelist = require('../models/IPWhitelist');

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeUsers,
      lockedUsers,
      twoFAUsers,
      totalActionLogs,
      todayLogins,
      todayFailedLogins,
      weekFailedLogins,
      totalAuditLogs,
      auditByEntity,
      auditByStatus,
      recentAuditLogs,
      ipEntries,
      recentFailedLogins,
      userActivityTrend
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { lockedUntil: { gte: now } } }),
      prisma.user.count({ where: { twoFAEnabled: true } }),
      ActionLog.countDocuments(),
      ActionLog.countDocuments({ action: 'login', createdAt: { $gte: todayStart } }),
      ActionLog.countDocuments({ action: 'login_failed', createdAt: { $gte: todayStart } }),
      ActionLog.countDocuments({ action: 'login_failed', createdAt: { $gte: weekStart } }),
      AuditLog.countDocuments(),
      AuditLog.aggregate([
        { $group: { _id: '$entity_type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AuditLog.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      AuditLog.find()
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('user_id', 'name email')
        .populate('company_id', 'name code')
        .lean(),
      IPWhitelist.countDocuments(),
      ActionLog.find({ action: 'login_failed' })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('user', 'name email')
        .lean(),
      // Daily activity trend for last 7 days
      ActionLog.aggregate([
        { $match: { createdAt: { $gte: weekStart } } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
              day: { $dayOfMonth: '$createdAt' }
            },
            count: { $sum: 1 },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
      ])
    ]);

    const failedLoginRate = todayLogins + todayFailedLogins > 0
      ? Math.round((todayFailedLogins / (todayLogins + todayFailedLogins)) * 100)
      : 0;

    const twoFARate = totalUsers > 0 ? Math.round((twoFAUsers / totalUsers) * 100) : 0;

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          locked: lockedUsers,
          twoFAEnabled: twoFAUsers,
          twoFARate,
          inactive: totalUsers - activeUsers
        },
        logins: {
          todayTotal: todayLogins + todayFailedLogins,
          todaySuccess: todayLogins,
          todayFailed: todayFailedLogins,
          weekFailed: weekFailedLogins,
          failedRate: failedLoginRate
        },
        audit: {
          total: totalAuditLogs,
          actionLogs: totalActionLogs,
          byEntity: auditByEntity,
          byStatus: auditByStatus
        },
        ipWhitelist: { total: ipEntries },
        recentEvents: recentAuditLogs.map(log => ({
          _id: log._id,
          action: log.action,
          entity_type: log.entity_type,
          status: log.status,
          user: log.user_id ? { name: log.user_id.name || log.user_id.email, email: log.user_id.email } : null,
          company: log.company_id ? { name: log.company_id.name, code: log.company_id.code } : null,
          ip_address: log.ip_address,
          createdAt: log.createdAt
        })),
        recentFailedLogins: recentFailedLogins.map(l => ({
          _id: l._id,
          user: l.user ? { name: l.user.name, email: l.user.email } : null,
          ipAddress: l.ipAddress,
          createdAt: l.createdAt
        })),
        activityTrend: userActivityTrend.map(d => ({
          date: `${d._id.year}-${String(d._id.month).padStart(2, '0')}-${String(d._id.day).padStart(2, '0')}`,
          total: d.count,
          failed: d.failed
        }))
      }
    });
  } catch (error) {
    console.error('getPlatformSecurityStats error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to load security stats' });
  }
};

/** GET /api/companies/capital/balance */
exports.getCapitalBalance = async (req, res) => {
  try {
    const companyId = req.user.company._id;

    const AccountBalance = require('../models/AccountBalance');
    const shareBal = await AccountBalance.findOne({ company: companyId, accountCode: DEFAULT_ACCOUNTS.shareCapital }).lean();
    const ownerBal = await AccountBalance.findOne({ company: companyId, accountCode: DEFAULT_ACCOUNTS.openingBalanceEquity }).lean();

    const shareCapital = shareBal ? (shareBal.credit || 0) - (shareBal.debit || 0) : 0;
    const ownerCapital = ownerBal ? (ownerBal.credit || 0) - (ownerBal.debit || 0) : 0;

    res.json({
      success: true,
      data: {
        shareCapital: Math.round(shareCapital * 100) / 100,
        ownerCapital: Math.round(ownerCapital * 100) / 100,
        totalCapital: Math.round((shareCapital + ownerCapital) * 100) / 100
      }
    });
  } catch (error) {
    console.error('Error fetching capital balance:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch capital balance' });
  }
};

const EBMDeviceService = require('../services/ebmDeviceService');
const EBMCodeSyncService = require('../services/ebmCodeSyncService');
const EBMCode = require('../models/EBMCode');
const EBMCodeClass = require('../models/EBMCodeClass');
const EBMItemClass = require('../models/EBMItemClass');
const EBMTIN = require('../models/EBMTIN');
const EBMNotice = require('../models/EBMNotice');
const EBMBranchService = require('../services/ebmBranchService');
const ebmService = require('../services/ebmService');
const EBMImportedItemService = require('../services/ebmImportedItemService');
const EBMPurchaseService = require('../services/ebmPurchaseService');
const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const EBMAlert = require('../models/EBMAlert');
const Company = require('../models/Company');
const EBMQueueService = require('../services/ebmQueueService');
const EBMApprovalService = require('../services/ebmApprovalService');
const EBMStockService = require('../services/ebmStockService');
const EBMReadinessService = require('../services/ebmReadinessService');
const EBMSalesSyncService = require('../services/ebmSalesSyncService');
const EBMItemSyncService = require('../services/ebmItemSyncService');
const { getOperationCatalog } = require('../constants/ebmOperationCatalog');
const { wantsCursor, cursorFilter, cursorSort, cursorPage } = require('../utils/cursorPagination');
const reconcileCodeDefinitionBaseline = require('../utils/ebmCodeDefinitionReconciliation');

function getCompanyId(req) {
  return req.companyId || req.company?._id || req.user?.company?._id || req.user?.company;
}

function getRequestedBranchId(body = {}) {
  const supplied = [body.branchId, body.bhfId].filter((value) => value !== undefined && value !== null);
  if (!supplied.length || supplied.some((value) => typeof value !== 'string' || !/^\d{1,2}$/.test(value.trim()))) {
    const error = new Error('A one- or two-digit RRA branch ID is required.');
    error.code = 'EBM_BRANCH_ID_INVALID';
    error.statusCode = 422;
    throw error;
  }
  const normalized = supplied.map((value) => value.trim().padStart(2, '0'));
  if (normalized.some((value) => value !== normalized[0])) {
    const error = new Error('branchId and bhfId must identify the same RRA branch.');
    error.code = 'EBM_BRANCH_ID_MISMATCH';
    error.statusCode = 422;
    throw error;
  }
  return normalized[0];
}

exports.getOperationCatalog = async (req, res) => {
  res.json({ success: true, data: getOperationCatalog() });
};

exports.getCompanyEbmSetting = async (req, res, next) => {
  try {
    if (req.user?.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        code: 'EBM_PLATFORM_ADMIN_REQUIRED',
        message: 'Only a platform administrator can view the EBM workflow setting.',
      });
    }

    const companyId = req.params.companyId || req.query.companyId;
    if (!companyId) {
      return res.status(400).json({ success: false, code: 'EBM_COMPANY_ID_REQUIRED', message: 'companyId is required.' });
    }
    const company = await Company.findById(companyId).lean();
    if (!company) {
      return res.status(404).json({ success: false, code: 'COMPANY_NOT_FOUND', message: 'Company not found.' });
    }
    return res.json({
      success: true,
      data: {
        companyId: company.id || company._id,
        ebmEnabled: company.ebmEnabled !== false && company.ebm_enabled !== false,
        reason: company.ebmToggleReason || company.ebm_toggle_reason || null,
        changedAt: company.ebmToggleChangedAt || company.ebm_toggle_changed_at || null,
        changedBy: company.ebmToggleChangedBy || company.ebm_toggle_changed_by || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateCompanyEbmSetting = async (req, res, next) => {
  try {
    if (req.user?.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        code: 'EBM_PLATFORM_ADMIN_REQUIRED',
        message: 'Only a platform administrator can change the EBM workflow setting.',
      });
    }

    const companyId = req.params.companyId || req.query.companyId;
    const enabled = req.body.enabled;
    if (companyId == null) {
      return res.status(400).json({ success: false, code: 'EBM_COMPANY_ID_REQUIRED', message: 'companyId is required.' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, code: 'EBM_ENABLED_REQUIRED', message: 'enabled must be a boolean.' });
    }

    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ success: false, code: 'COMPANY_NOT_FOUND', message: 'Company not found.' });
    }

    const previousValue = company.ebmEnabled !== false && company.ebm_enabled !== false;
    const update = {
      ebmEnabled: enabled,
      ebmToggleReason: enabled ? null : (reason || 'Platform administrator paused EBM integration.'),
      ebmToggleChangedAt: new Date(),
      ebmToggleChangedBy: req.user?._id || req.user?.id || null,
    };
    const nextCompany = await Company.findByIdAndUpdate(companyId, update, { new: true });

    return res.json({
      success: true,
      data: {
        companyId: nextCompany.id || nextCompany._id,
        ebmEnabled: nextCompany.ebmEnabled !== false && nextCompany.ebm_enabled !== false,
        reason: nextCompany.ebmToggleReason || nextCompany.ebm_toggle_reason || null,
        changedAt: nextCompany.ebmToggleChangedAt || nextCompany.ebm_toggle_changed_at || null,
        changedBy: nextCompany.ebmToggleChangedBy || nextCompany.ebm_toggle_changed_by || null,
        previousValue,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCompanyRraApproval = async (req, res, next) => {
  try {
    if (req.user?.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        code: 'EBM_PLATFORM_ADMIN_REQUIRED',
        message: 'Only a platform administrator can view RRA approval evidence.',
      });
    }
    const data = await EBMApprovalService.getApproval(req.params.companyId);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.updateCompanyRraApproval = async (req, res, next) => {
  try {
    if (req.user?.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        code: 'EBM_PLATFORM_ADMIN_REQUIRED',
        message: 'Only a platform administrator can record RRA approval.',
      });
    }
    const data = await EBMApprovalService.updateApproval(req.params.companyId, {
      approved: req.body.approved,
      reference: req.body.reference,
      reason: req.body.reason,
      userId: req.user?._id || req.user?.id || null,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.getDeviceStatus = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const status = await EBMDeviceService.getInitializationStatus(companyId);
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

exports.initializeDevice = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMDeviceService.initializeDevice(
      companyId,
      {
        branchId: req.body.branchId,
        bhfId: req.body.bhfId,
        deviceSerialNo: req.body.deviceSerialNo,
        dvcSrlNo: req.body.dvcSrlNo,
        tin: req.body.tin,
      },
      req.user?._id || req.user?.id || null,
    );

    res.json({
      success: true,
      data: result.device,
      outcome: result.alreadyInitialized ? 'already_initialized' : 'initialized',
      ...(result.alreadyInitialized ? { alreadyInitialized: true } : {}),
      ...(result.response ? { vsdc: {
        resultCd: result.response.resultCd,
        resultMsg: result.response.resultMsg,
        resultDt: result.response.resultDt,
        requestId: result.response.requestId || null,
        mode: result.response.mode,
      } } : {}),
    });
  } catch (error) {
    const isUnknownOutcome = [
      'EBM_INIT_OUTCOME_UNKNOWN',
      'EBM_INIT_RESPONSE_MALFORMED',
      'EBM_INIT_ATTEMPT_NEEDS_RECONCILIATION',
    ].includes(error.code);
    if (isUnknownOutcome || error.code === 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED'
      || (error.dispatched === true && (error.code === 'EBM_VSDC_REJECTED' || String(error.code || '').startsWith('EBM_VSDC_')))) {
      const localSetupFailed = error.code === 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED';
      const rejected = !isUnknownOutcome && !localSetupFailed;
      return res.status(error.statusCode || (localSetupFailed ? 503 : rejected ? 502 : 503)).json({
        success: false,
        outcome: localSetupFailed ? 'initialized_local_setup_failed' : rejected ? 'rejected' : 'outcome_unknown',
        ...(localSetupFailed ? { rraOutcome: 'initialized' } : {}),
        code: error.code,
        message: error.message,
        requestId: error.requestId || null,
        ...(error.response ? { vsdc: {
          resultCd: error.response.resultCd || error.resultCd || null,
          resultMsg: error.response.resultMsg ?? null,
          resultDt: error.response.resultDt ?? null,
        } } : {}),
      });
    }
    next(error);
  }
};

exports.syncCodes = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMCodeSyncService.syncAll(companyId, {
      branchId: req.body.branchId || req.body.bhfId,
      full: req.body.full === true,
    });
    res.json({ success: result.outcome === 'complete', data: result });
  } catch (error) {
    next(error);
  }
};

exports.getCodeSyncStatus = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const states = await EBMCodeSyncService.getSyncStates(companyId);
    const intervalValue = process.env.EBM_CODE_SYNC_INTERVAL_HOURS;
    const intervalHours = intervalValue === undefined ? 24 : Number(intervalValue);
    const staleAfterMs = Number.isFinite(intervalHours) && intervalHours > 0
      ? intervalHours * 60 * 60 * 1000
      : 0;
    const now = Date.now();
    const data = states.map((state) => {
      if (state.syncType !== 'standard_codes') return state;
      const lastSuccessfulAt = state.lastSuccessfulSyncAt
        ? new Date(state.lastSuccessfulSyncAt).getTime()
        : NaN;
      return {
        ...state,
        isStale: staleAfterMs === 0
          || !Number.isFinite(lastSuccessfulAt)
          || lastSuccessfulAt <= now - staleAfterMs,
      };
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.getBranchReconciliation = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const data = await EBMCodeSyncService.getBranchReconciliation(companyId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.getCodes = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const allCodes = await EBMCode.find({ company: companyId }).sort({ codeClass: 1, sortOrder: 1, code: 1 }).lean();
    const codeClasses = await EBMCodeClass.find({ company: companyId }).lean();
    const requestedClass = req.query.codeClass == null ? null : String(req.query.codeClass);
    const activeClassIds = new Set(codeClasses
      .filter((codeClass) => codeClass.useYn !== 'N' && codeClass.active !== false)
      .map((codeClass) => String(codeClass.codeClass)));
    const codes = allCodes.filter((code) => code.useYn !== 'N'
      && code.active !== false
      && activeClassIds.has(String(code.codeClass))
      && (!requestedClass || String(code.codeClass) === requestedClass));
    const visibleClasses = codeClasses.filter((codeClass) => codeClass.useYn !== 'N'
      && codeClass.active !== false
      && (!requestedClass || String(codeClass.codeClass) === requestedClass));
    const grouped = Object.fromEntries(visibleClasses.map((codeClass) => [codeClass.codeClass, {
      codeClass: codeClass.codeClass,
      codeClassName: codeClass.name,
      codeClassDescription: codeClass.description,
      classUserDefinedName1: codeClass.userDefinedName1,
      classUserDefinedName2: codeClass.userDefinedName2,
      classUserDefinedName3: codeClass.userDefinedName3,
      codeClassUseYn: codeClass.useYn,
      codeClassSource: codeClass.source,
      codes: [],
    }]));
    for (const code of codes) {
      if (!grouped[code.codeClass]) {
        grouped[code.codeClass] = {
          codeClass: code.codeClass,
          codeClassName: code.codeClassName,
          codeClassDescription: code.codeClassDescription,
          classUserDefinedName1: code.classUserDefinedName1,
          classUserDefinedName2: code.classUserDefinedName2,
          classUserDefinedName3: code.classUserDefinedName3,
          codeClassUseYn: code.codeClassUseYn,
          codeClassSource: code.codeClassSource,
          codes: [],
        };
      }
      grouped[code.codeClass].codes.push({
        code: code.code,
        name: code.name,
        description: code.description,
        sortOrder: code.sortOrder,
        userDefinedCode1: code.userDefinedCode1,
        userDefinedCode2: code.userDefinedCode2,
        userDefinedCode3: code.userDefinedCode3,
        useYn: code.useYn,
        active: code.active,
        source: code.source,
      });
    }

    res.json({
      success: true,
      data: grouped,
      definitionReconciliation: reconcileCodeDefinitionBaseline(codeClasses, allCodes),
    });
  } catch (error) {
    next(error);
  }
};

exports.getItemClasses = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const search = String(req.query.search || '').trim();
    const query = { company: companyId, active: { $ne: false } };
    if (search) {
      query.$or = [
        { itemClassCode: { $regex: search, $options: 'i' } },
        { itemClassName: { $regex: search, $options: 'i' } },
      ];
    }

    const itemClasses = await EBMItemClass.find(query)
      .sort({ itemClassCode: 1 })
      .limit(Math.min(Number(req.query.limit || 1000), 5000))
      .lean();

    res.json({ success: true, data: itemClasses });
  } catch (error) {
    next(error);
  }
};

exports.searchTINs = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ success: false, message: 'Company context is required.' });
    const EBMTinService = require('../services/ebmCustomerTinService');
    const branchId = await EBMTinService.resolveBranchId(companyId, req.query.branchId || req.query.bhfId);
    const search = String(req.query.search || req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const query = { company: companyId, branchId, active: { $ne: false } };
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { tin: { $regex: `^${escapedSearch}`, $options: 'i' } },
        { taxpayerName: { $regex: escapedSearch, $options: 'i' } },
      ];
    }
    const tins = await EBMTIN.find(query)
      .sort({ tin: 1 })
      .limit(limit)
      .lean();
    res.json({ success: true, data: tins });
  } catch (error) {
    next(error);
  }
};


exports.verifyCustomerTin = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const EBMTinService = require('../services/ebmCustomerTinService');
    const verification = await EBMTinService.verifyTin(companyId, req.body.tin || req.body.custmTin || req.body.custTin, {
      branchId: req.body.branchId || req.body.bhfId,
    });
    res.json({ success: true, data: verification, verification });
  } catch (error) {
    next(error);
  }
};
exports.getNotices = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 200)) : 50;
    const notices = await EBMNotice.find({ company: companyId, active: { $ne: false } })
      .sort({ noticeDate: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, data: notices });
  } catch (error) {
    next(error);
  }
};

exports.registerBranch = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const branchId = getRequestedBranchId(req.body);
    const branch = await EBMBranchService.registerBranchById(companyId, branchId, req.user?._id || req.user?.id || null);
    res.json({
      success: true,
      data: branch,
      verification: {
        mode: ebmService.mode,
        productionConfirmed: ebmService.mode === 'production',
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.submitBranchInsurance = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const branchId = getRequestedBranchId(req.body);
    const result = await EBMBranchService.submitBranchInsurance(
      companyId,
      branchId,
      req.user,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getBranchInsuranceStatus = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const data = await EBMBranchService.getBranchInsuranceStatus(companyId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.__test__ = { getRequestedBranchId };

exports.syncImportedItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMImportedItemService.syncImports(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.listImportedItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imports = await EBMImportedItemService.listImports(companyId, req.query);
    res.json({ success: true, data: imports, mode: EBMImportedItemService.getMode() });
  } catch (error) {
    next(error);
  }
};

exports.confirmImportedItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.confirmImport(
      companyId,
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};

exports.mapImportedItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.mapImport(
      companyId,
      req.params.id,
      req.body,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};

exports.rejectImportedItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.rejectImport(
      companyId,
      req.params.id,
      req.body.reason,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};

exports.retryImportedItemStock = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const imported = await EBMImportedItemService.retryStockUpdate(
      companyId,
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, data: imported });
  } catch (error) {
    next(error);
  }
};
exports.reconcileStockMaster = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMStockService.reconcileStockMaster(companyId, {
      branchId: req.body.branchId,
      lastReqDt: req.body.lastReqDt,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.resubmitStockMaster = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMStockService.resubmitStockMasterFromReconciliation(
      companyId,
      {
        branchId: req.body.branchId,
        itemCd: req.body.itemCd,
        itemCode: req.body.itemCode,
        productId: req.body.productId,
        allDiscrepancies: req.body.allDiscrepancies === true,
        lastReqDt: req.body.lastReqDt,
      },
      req.user,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.syncPurchases = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMPurchaseService.syncPurchases(companyId, {
      branchId: req.body.branchId && req.body.bhfId
        ? getRequestedBranchId(req.body)
        : (req.body.branchId || req.body.bhfId || '00'),
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.listUnmatchedPurchases = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const purchases = await EBMPurchaseService.listUnmatched(companyId, req.query);
    res.json({ success: true, data: purchases });
  } catch (error) {
    next(error);
  }
};

exports.listSubmissionQueue = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const filter = { companyId };
    if (req.query.status) filter.ebmStatus = req.query.status;
    if (!req.query.status) filter.ebmStatus = { $ne: 'submitted' };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    if (req.query.companyId && ['platform_admin', 'superadmin'].includes(req.user?.role)) {
      filter.companyId = req.query.companyId;
    }
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) filter.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) filter.createdAt.$lte = new Date(req.query.toDate);
    }

    const pageSize = Math.min(Math.max(1, Number(req.query.pageSize || req.query.limit || 20)), 100);
    if (wantsCursor(req.query)) {
      // Queue status can change while an operator is browsing it, so use the
      // immutable creation timestamp (plus _id tiebreaker) as the keyset.
      // The existing status/retry ordering remains available to page-number
      // clients for backwards compatibility.
      const cursorQuery = { ...filter, ...cursorFilter(req.query.cursor, 'desc') };
      const rows = await EBMSubmissionQueue.find(cursorQuery)
        .sort(cursorSort('createdAt', 'desc'))
        .limit(pageSize + 1)
        .populate('companyId', 'name code')
        .lean();
      const { data, pagination } = cursorPage(rows, pageSize, 'createdAt');
      return res.json({ success: true, data: { queue: data, records: data, pagination } });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const skip = (page - 1) * pageSize;
    const queue = await EBMSubmissionQueue.find(filter)
      .sort({ ebmStatus: 1, nextRetryAt: 1, createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('companyId', 'name code')
      .lean();
    const total = await EBMSubmissionQueue.countDocuments(filter);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const counts = await EBMSubmissionQueue.aggregate([
      { $match: { companyId } },
      { $group: { _id: '$ebmStatus', count: { $sum: 1 } } },
    ]);
    const submittedToday = await EBMSubmissionQueue.countDocuments({
      companyId,
      ebmStatus: 'submitted',
      resolvedAt: { $gte: today },
    });
    const unacknowledgedAlerts = await EBMAlert.countDocuments({ companyId, acknowledged: false });
    res.json({
      success: true,
      data: {
        counts: {
          ...counts.reduce((acc, item) => ({ ...acc, [item._id]: item.count }), {}),
          submittedToday,
          unacknowledgedAlerts,
        },
        queue,
        records: queue,
        pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getSubmissionQueueItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const item = await EBMSubmissionQueue.findOne({ _id: req.params.id, companyId })
      .populate('companyId', 'name code')
      .lean();
    if (!item) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

exports.retryQueueItem = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const item = await EBMQueueService.resetForManualRetry(req.params.id, companyId);
    if (!item) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    const { processRecord } = require('../services/ebmRetryJob');
    const result = await processRecord(item);
    const refreshed = await EBMSubmissionQueue.findOne({ _id: item._id, companyId }).lean();
    res.json({ success: true, data: refreshed, result });
  } catch (error) {
    next(error);
  }
};

exports.bulkRetryQueueItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = [];
    for (const id of ids) {
      try {
        const item = await EBMQueueService.resetForManualRetry(id, companyId);
        if (!item) {
          results.push({ id, ok: false, message: 'Not found' });
        } else {
          results.push({ id, ok: true, status: item.ebmStatus });
        }
      } catch (error) {
        results.push({ id, ok: false, message: error.message });
      }
    }
    res.json({
      success: true,
      data: {
        reset: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok),
        results,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.markQueueItemResolved = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const unknownOutcomeCodes = [
      'EBM_SALES_OUTCOME_UNKNOWN',
      'EBM_PURCHASE_OUTCOME_UNKNOWN',
      'EBM_PURCHASE_ACCEPTED_UNRECORDED',
      'EBM_OPERATION_OUTCOME_UNKNOWN',
    ];
    const existing = await EBMSubmissionQueue.findOne({ _id: req.params.id, companyId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'EBM queue item not found' });
    if (unknownOutcomeCodes.includes(existing.lastError?.code)) {
      return res.status(409).json({
        success: false,
        code: 'EBM_RECONCILIATION_REQUIRED',
        message: 'This operation has an unknown or accepted-but-unrecorded outcome. Reconcile it against RRA evidence before resolving or retrying; this action cannot mark it submitted.',
      });
    }
    const item = await EBMSubmissionQueue.findOneAndUpdate(
      { _id: req.params.id, companyId, 'lastError.code': { $nin: unknownOutcomeCodes } },
      { $set: { ebmStatus: 'submitted', resolvedAt: new Date(), isRetryable: false } },
      { new: true },
    );
    if (!item) return res.status(409).json({
      success: false,
      code: 'EBM_RECONCILIATION_REQUIRED',
      message: 'The queue outcome changed while resolving it. Refresh and reconcile before retrying.',
    });
    res.json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
};

exports.listAlerts = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const filter = { companyId, acknowledged: false };
    if (req.query.documentType) filter.documentType = req.query.documentType;
    if (req.query.fromDate || req.query.toDate) {
      filter.abandonedAt = {};
      if (req.query.fromDate) filter.abandonedAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) filter.abandonedAt.$lte = new Date(req.query.toDate);
    }
    const alerts = await EBMAlert.find(filter).sort({ abandonedAt: -1 }).limit(200).lean();
    res.json({ success: true, data: alerts });
  } catch (error) {
    next(error);
  }
};

exports.acknowledgeAlert = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const alert = await EBMAlert.findOneAndUpdate(
      { _id: req.params.id, companyId },
      {
        $set: {
          acknowledged: true,
          acknowledgedAt: new Date(),
          acknowledgedBy: req.user?._id || req.user?.id || null,
          status: 'acknowledged',
        },
      },
      { new: true },
    );
    if (!alert) return res.status(404).json({ success: false, message: 'EBM alert not found' });
    res.json({ success: true, data: alert });
  } catch (error) {
    next(error);
  }
};

exports.resetAlert = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const alert = await EBMAlert.findOne({ _id: req.params.id, companyId });
    if (!alert) return res.status(404).json({ success: false, message: 'EBM alert not found' });
    const item = await EBMQueueService.resetForManualRetry(alert.queueId, companyId);
    alert.status = 'reset';
    alert.acknowledged = true;
    alert.acknowledgedAt = alert.acknowledgedAt || new Date();
    alert.resetAt = new Date();
    alert.resetBy = req.user?._id || req.user?.id || null;
    await alert.save();
    res.json({ success: true, data: { alert, queue: item } });
  } catch (error) {
    next(error);
  }
};

exports.getReadiness = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const branchId = String(req.query.branchId || req.query.bhfId || '00').padStart(2, '0').slice(-2);
    const data = await EBMReadinessService.getReadiness(companyId, branchId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.syncSalesSummaries = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMSalesSyncService.syncSalesSummaries(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
      prcOrdCd: req.body.prcOrdCd,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.syncRegisteredItems = async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await EBMItemSyncService.syncRegisteredItems(companyId, {
      branchId: req.body.branchId || req.body.bhfId || '00',
      full: req.body.full === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

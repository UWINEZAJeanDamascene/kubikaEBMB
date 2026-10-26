const { randomUUID } = require('crypto');
const EBMDevice = require('../models/EBMDevice');
const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { EBM_MODES, EBMServiceError, extractInitInfo } = require('./ebmService');
const EBMFiscalSequenceService = require('./ebmFiscalSequenceService');
const { buildInitInfoRequest } = require('../utils/vsdcPayloadSanitizer');
const { assertInitEncryptionConfigured, protectInitResult } = require('../utils/ebmInitResultProtection');

function normalizeBranchId(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  return text.padStart(2, '0');
}

function extractTin(company) {
  const tin = String(company?.tax_identification_number || '').trim();
  return /^\d{9}$/.test(tin) ? tin : '';
}

function toPublicDevice(device) {
  if (!device) return null;
  const raw = typeof device.toObject === 'function' ? device.toObject() : device;
  return {
    _id: raw._id,
    company: raw.company,
    tin: raw.tin,
    branchId: raw.branchId,
    environment: raw.environment || raw.initializedMode || raw.lastAttemptMode || null,
    branchName: raw.branchName,
    branchRef: raw.branchRef,
    deviceSerialNo: raw.deviceSerialNo,
    status: raw.status,
    initializedAt: raw.initializedAt,
    lastAttemptAt: raw.lastAttemptAt,
    lastRequestId: raw.lastRequestId || null,
    sequenceSeedStatus: raw.sequenceSeedStatus || null,
    lastSuccessfulContactAt: raw.lastSuccessfulContactAt || null,
    lastSuccessfulFiscalAt: raw.lastSuccessfulFiscalAt || null,
    lastErrorMessage: raw.lastErrorMessage,
    initializedMode: raw.initializedMode,
    lastAttemptMode: raw.lastAttemptMode,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

class EBMDeviceService {
  static normalizeBranchId = normalizeBranchId;

  static async getCompany(companyId) {
    const company = await Company.findById(companyId).lean();
    if (!company) {
      const error = new Error('Company not found');
      error.statusCode = 404;
      throw error;
    }
    return company;
  }

  static async getBranchRows(companyId) {
    const warehouses = await Warehouse.find({ company: companyId, isActive: { $ne: false } })
      .sort({ isDefault: -1, createdAt: 1, name: 1 })
      .lean();

    return warehouses.map((warehouse) => ({
      branchId: normalizeBranchId(warehouse.rraBranchId),
      branchName: warehouse.name || warehouse.code || `Branch ${warehouse.rraBranchId || ''}`,
      branchRef: warehouse._id,
      rraBranchId: warehouse.rraBranchId || null,
    })).filter((branch) => branch.branchId && branch.branchRef);
  }

  static async getInitializationStatus(companyId) {
    const [company, branches, devices] = await Promise.all([
      this.getCompany(companyId),
      this.getBranchRows(companyId),
      EBMDevice.find({ company: companyId }).lean(),
    ]);

    const tin = extractTin(company);
    const currentMode = ebmService.getConfig().mode;
    const devicesByBranch = new Map();
    devices
      .filter((device) => (device.environment || device.initializedMode || device.lastAttemptMode || 'mock') === currentMode)
      .forEach((device) => {
        const rows = devicesByBranch.get(device.branchId) || [];
        rows.push(device);
        devicesByBranch.set(device.branchId, rows);
      });

    return {
      mode: currentMode,
      tin,
      branches: branches.map((branch) => {
        const branchDevices = devicesByBranch.get(branch.branchId) || [];
        const device = branchDevices.length === 1 ? branchDevices[0] : null;
        const duplicateBranchMapping = branches.filter((candidate) => candidate.branchId === branch.branchId).length > 1;
        const initializationBlocked = ['initializing', 'outcome_unknown'].includes(device?.status);
        return {
          ...branch,
          tin,
          deviceSerialNo: device?.deviceSerialNo || null,
          configurationError: duplicateBranchMapping || branchDevices.length > 1,
          initializationBlocked,
          status: duplicateBranchMapping || branchDevices.length > 1
            ? EBM_DEVICE_STATUSES.FAILED
            : device?.status || EBM_DEVICE_STATUSES.NOT_INITIALIZED,
          initializedAt: device?.initializedAt || null,
          lastAttemptAt: device?.lastAttemptAt || null,
          lastRequestId: device?.lastRequestId || null,
          sequenceSeedStatus: device?.sequenceSeedStatus || null,
          lastErrorMessage: duplicateBranchMapping
            ? `RRA branch ${branch.branchId} is assigned to multiple active warehouses.`
            : branchDevices.length > 1
              ? `Multiple device records exist for RRA branch ${branch.branchId} in ${currentMode}.`
              : initializationBlocked
                ? 'An initialization attempt may have reached RRA but has no confirmed outcome. Reconcile it by request ID before trying again.'
              : device?.lastErrorMessage || null,
          initializedMode: device?.initializedMode || null,
          lastAttemptMode: device?.lastAttemptMode || null,
          modeMatches: !duplicateBranchMapping && branchDevices.length === 1
            && device?.status === EBM_DEVICE_STATUSES.INITIALIZED
            && !['pending', 'failed'].includes(device?.sequenceSeedStatus)
            && (device?.environment || device?.initializedMode || device?.lastAttemptMode) === currentMode
            && device?.initializedMode === currentMode,
          recordId: device?._id || null,
        };
      }),
    };
  }

  static async ensureInitialized({ companyId, branchId, mode }) {
    const normalizedBranchId = normalizeBranchId(branchId);
    if (!companyId) {
      throw new EBMServiceError('Company context is required before calling VSDC.', {
        code: 'EBM_COMPANY_CONTEXT_REQUIRED',
        mode,
        retryable: false,
      });
    }
    if (!normalizedBranchId) {
      throw new EBMServiceError('Branch ID is required before calling VSDC.', {
        code: 'EBM_BRANCH_CONTEXT_REQUIRED',
        mode,
        retryable: false,
      });
    }

    const device = await EBMDevice.findOne({
      company: companyId,
      branchId: normalizedBranchId,
      environment: mode,
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: mode,
    }).lean();

    if (!device) {
      throw new EBMServiceError(
        `EBM device is not initialized for company ${companyId}, branch ${normalizedBranchId}, mode ${mode}. Run device initialization before making VSDC calls.`,
        {
          code: 'EBM_DEVICE_NOT_INITIALIZED',
          mode,
          retryable: false,
        },
      );
    }

    if (device.sequenceSeedStatus === 'pending' || device.sequenceSeedStatus === 'failed') {
      throw new EBMServiceError(
        'RRA initialized this device, but local fiscal sequence setup is incomplete. Reconcile sequence setup before submitting fiscal operations. Do not initialize the device again.',
        { code: 'EBM_LOCAL_SEQUENCE_NOT_READY', mode, retryable: false, requestId: device.lastRequestId },
      );
    }

    return device;
  }

  static async initializeDevice(companyId, data = {}, userId = null) {
    const company = await this.getCompany(companyId);
    const tin = extractTin(company);
    const suppliedTin = data.tin == null ? null : String(data.tin).trim();
    if (!tin) {
      const error = new Error('Set the company tax identification number to a valid 9-digit TIN before EBM device initialization.');
      error.statusCode = 422;
      error.code = 'EBM_COMPANY_TIN_REQUIRED';
      throw error;
    }
    if (suppliedTin && suppliedTin !== tin) {
      const error = new Error('The supplied TIN does not match the authenticated company tax identification number.');
      error.statusCode = 422;
      error.code = 'EBM_COMPANY_TIN_MISMATCH';
      throw error;
    }

    if (data.branchId != null && data.bhfId != null
      && normalizeBranchId(data.branchId) !== normalizeBranchId(data.bhfId)) {
      const error = new Error('branchId and bhfId identify different branches. Send only one branch identifier or make them match.');
      error.statusCode = 422;
      error.code = 'EBM_BRANCH_ID_MISMATCH';
      throw error;
    }
    const requestedBranchId = data.branchId ?? data.bhfId;
    const branchId = normalizeBranchId(requestedBranchId);
    if (!branchId) {
      const error = new Error('Select a valid RRA branch ID containing one or two digits.');
      error.statusCode = 422;
      error.code = 'EBM_BRANCH_ID_INVALID';
      throw error;
    }

    const branches = await this.getBranchRows(companyId);
    const matchingBranches = branches.filter((candidate) => candidate.branchId === branchId);
    if (matchingBranches.length === 0) {
      const error = new Error(`RRA branch ${branchId} is not configured on an active warehouse belonging to this company.`);
      error.statusCode = 404;
      error.code = 'EBM_BRANCH_NOT_MAPPED';
      throw error;
    }
    if (matchingBranches.length > 1) {
      const error = new Error(`RRA branch ${branchId} is assigned to multiple active warehouses. Resolve the duplicate branch mapping before initialization.`);
      error.statusCode = 409;
      error.code = 'EBM_BRANCH_MAPPING_AMBIGUOUS';
      throw error;
    }
    const [branch] = matchingBranches;

    const mode = ebmService.getConfig().mode;
    const internalSerial = data.deviceSerialNo == null ? null : String(data.deviceSerialNo).trim();
    const wireSerial = data.dvcSrlNo == null ? null : String(data.dvcSrlNo).trim();
    if (internalSerial && wireSerial && internalSerial !== wireSerial) {
      const error = new Error('deviceSerialNo and dvcSrlNo contain different values. Send one device serial value.');
      error.statusCode = 422;
      error.code = 'EBM_DEVICE_SERIAL_MISMATCH';
      throw error;
    }
    const requestedSerial = internalSerial ?? wireSerial;
    const requestedSerialNo = requestedSerial == null ? '' : String(requestedSerial).trim();
    const deviceRecords = await EBMDevice.find({ company: companyId, branchId, environment: mode }).lean();
    if (deviceRecords.length > 1) {
      const error = new Error(`Multiple device records exist for RRA branch ${branchId} in ${mode}. Resolve the device registry before initializing.`);
      error.statusCode = 409;
      error.code = 'EBM_DEVICE_IDENTITY_AMBIGUOUS';
      throw error;
    }
    const device = deviceRecords[0] || null;
    const registeredSerialNo = String(device?.deviceSerialNo || '').trim();
    if (device?.tin && device.tin !== tin) {
      const error = new Error('The stored device TIN no longer matches the authenticated company TIN. Reconcile the company tax identity before continuing.');
      error.statusCode = 409;
      error.code = 'EBM_DEVICE_TIN_MISMATCH';
      throw error;
    }
    if (device?.branchRef && String(device.branchRef) !== String(branch.branchRef)) {
      const error = new Error('The stored device belongs to a different warehouse mapping. Resolve the device-to-branch mapping before continuing.');
      error.statusCode = 409;
      error.code = 'EBM_DEVICE_BRANCH_MISMATCH';
      throw error;
    }
    if (registeredSerialNo && requestedSerialNo && registeredSerialNo !== requestedSerialNo) {
      const error = new Error('Device serial number is immutable once registered for this company, branch, and environment.');
      error.statusCode = 409;
      error.code = 'EBM_DEVICE_SERIAL_MISMATCH';
      throw error;
    }
    const serialNo = registeredSerialNo || requestedSerialNo;
    // Validate the resolved application values before creating or mutating a device record.
    buildInitInfoRequest({ tin, bhfId: branchId, dvcSrlNo: serialNo });
    if (mode !== EBM_MODES.MOCK) {
      await require('./ebmApprovalService').assertApproved(companyId);
      assertInitEncryptionConfigured();
    }
    if (['initializing', 'outcome_unknown'].includes(device?.status)) {
      const error = new EBMServiceError(
        'A previous initialization attempt has no confirmed outcome. Reconcile it by request ID before trying again; do not send another initialization request.',
        { code: 'EBM_INIT_ATTEMPT_NEEDS_RECONCILIATION', mode, retryable: false, requestId: device.lastRequestId },
      );
      error.code = 'EBM_INIT_ATTEMPT_NEEDS_RECONCILIATION';
      error.retryable = false;
      error.requestId = device.lastRequestId || null;
      error.statusCode = 409;
      throw error;
    }
    if (device?.status === EBM_DEVICE_STATUSES.INITIALIZED && device.initializedMode === mode) {
      return {
        success: true,
        alreadyInitialized: true,
        device: toPublicDevice(device),
        response: null,
      };
    }
    let attemptDevice = device;
    if (!attemptDevice) {
      attemptDevice = await EBMDevice.create({
        company: companyId,
        tin,
        branchId,
        environment: mode,
        branchName: branch.branchName,
        branchRef: branch.branchRef,
        deviceSerialNo: serialNo,
        status: EBM_DEVICE_STATUSES.NOT_INITIALIZED,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    const previousStatus = attemptDevice.status || EBM_DEVICE_STATUSES.NOT_INITIALIZED;
    attemptDevice.tin = tin;
    attemptDevice.branchName = branch.branchName;
    attemptDevice.branchRef = branch.branchRef;
    attemptDevice.lastAttemptAt = new Date();
    attemptDevice.status = EBM_DEVICE_STATUSES.INITIALIZING;
    const requestId = randomUUID();
    attemptDevice.lastRequestId = requestId;
    attemptDevice.lastAttemptMode = mode;
    attemptDevice.updatedBy = userId;
    await attemptDevice.save();

    let response;
    try {
      response = await ebmService.initializeDevice({
        companyId,
        tin,
        bhfId: branchId,
        dvcSrlNo: serialNo,
        requestId,
      }, { approvalVerified: mode !== EBM_MODES.MOCK });
    } catch (error) {
      if (error.dispatched === true) {
        attemptDevice.status = ['EBM_INIT_OUTCOME_UNKNOWN', 'EBM_INIT_RESPONSE_MALFORMED'].includes(error.code)
          ? EBM_DEVICE_STATUSES.OUTCOME_UNKNOWN
          : EBM_DEVICE_STATUSES.FAILED;
        attemptDevice.lastErrorMessage = error.message || 'EBM initialization failed';
        attemptDevice.initResult = error.response || null;
      } else attemptDevice.status = previousStatus;
      await attemptDevice.save();
      throw error;
    }

    // Persist the confirmed remote success before the idempotent local sequence seeding.
    attemptDevice.status = EBM_DEVICE_STATUSES.INITIALIZED;
    attemptDevice.initializedAt = new Date();
    attemptDevice.initializedMode = mode;
    attemptDevice.sequenceSeedStatus = 'pending';
    attemptDevice.lastErrorMessage = null;
    attemptDevice.initResult = protectInitResult(response.raw);
    attemptDevice.lastSuccessfulContactAt = new Date();
    await attemptDevice.save();

    try {
      await EBMFiscalSequenceService.seedFromInitInfo(
        companyId,
        branchId,
        extractInitInfo(response.data || response.raw?.data || {}),
      );
    } catch (error) {
      attemptDevice.sequenceSeedStatus = 'failed';
      attemptDevice.lastErrorMessage = 'RRA initialization succeeded, but local fiscal sequence setup failed. Do not initialize again; reconcile local sequences using the request ID.';
      await attemptDevice.save();
      const localError = new EBMServiceError(
        `${attemptDevice.lastErrorMessage} Request ID ${requestId}.`,
        {
          code: 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED',
          mode,
          requestId,
          retryable: false,
          cause: error,
        },
      );
      localError.code = 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED';
      localError.retryable = false;
      localError.statusCode = 503;
      localError.remoteInitialized = true;
      throw localError;
    }

    attemptDevice.sequenceSeedStatus = 'complete';
    attemptDevice.lastErrorMessage = null;
    await attemptDevice.save();
    return {
      success: true,
      device: toPublicDevice(attemptDevice),
      response,
    };
  }
}

module.exports = EBMDeviceService;
module.exports.EBM_DEVICE_STATUSES = EBM_DEVICE_STATUSES;
module.exports.EBM_MODES = EBM_MODES;

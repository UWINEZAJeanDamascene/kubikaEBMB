/**
 * EBMDevice — PostgreSQL (Prisma) backed (global delegate, company stored on row).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmDeviceToApi,
  ebmDeviceTranslateCreate,
  ebmDeviceTranslateUpdate,
} = require('../utils/phase10Mappers');

const EBM_DEVICE_STATUSES = Object.freeze({
  NOT_INITIALIZED: 'not_initialized',
  INITIALIZING: 'initializing',
  INITIALIZED: 'initialized',
  FAILED: 'failed',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

const EBM_DEVICE_MODES = Object.freeze({
  MOCK: 'mock',
  SANDBOX: 'sandbox',
  PRODUCTION: 'production',
});

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  tin: { target: 'tin' },
  branchId: { target: 'branchId' },
  environment: { target: 'environment' },
  branchName: { target: 'branchName' },
  deviceSerialNo: { target: 'deviceSerialNo' },
  status: { target: 'status' },
  initializedAt: { target: 'initializedAt' },
  lastAttemptAt: { target: 'lastAttemptAt' },
  lastRequestId: { target: 'lastRequestId' },
  sequenceSeedStatus: { target: 'sequenceSeedStatus' },
  initResult: { target: 'initResult' },
  lastSuccessfulContactAt: { target: 'lastSuccessfulContactAt' },
  lastSuccessfulFiscalAt: { target: 'lastSuccessfulFiscalAt' },
  initializedMode: { target: 'initializedMode' },
  lastAttemptMode: { target: 'lastAttemptMode' },
  branchRef: { target: 'branchRefId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  updatedBy: { target: 'updatedById', isId: true },
};

const EBMDevice = buildGlobalModel({
  name: 'EBMDevice',
  collection: 'ebmdevices',
  delegateName: 'ebmDevice',
  fieldMap: FIELD_MAP,
  toApi: ebmDeviceToApi,
  translateCreate: ebmDeviceTranslateCreate,
  translateUpdate: ebmDeviceTranslateUpdate,
  mutable: true,
});

module.exports = EBMDevice;
module.exports.EBM_DEVICE_STATUSES = EBM_DEVICE_STATUSES;
module.exports.EBM_DEVICE_MODES = EBM_DEVICE_MODES;

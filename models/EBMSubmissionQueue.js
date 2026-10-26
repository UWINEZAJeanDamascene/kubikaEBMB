/**
 * EBMSubmissionQueue — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  ebmSubmissionQueueToApi,
  ebmSubmissionQueueTranslateCreate,
  ebmSubmissionQueueTranslateUpdate,
} = require('../utils/phase10Mappers');

const DOCUMENT_TYPES = Object.freeze([
  'invoice',
  'pos',
  'creditNote',
  'purchase',
  'purchaseOrder',
  'stockMovement',
  'stockMaster',
  'branchTransfer',
  'stockAdjustment',
]);

const QUEUE_STATUSES = Object.freeze(['pending', 'submitting', 'failed', 'submitted', 'abandoned']);

const FIELD_MAP = {
  companyId: { target: 'companyId', isId: true },
  company: { target: 'companyId', isId: true },
  documentType: { target: 'documentType' },
  documentId: { target: 'documentId', isId: true },
  endpoint: { target: 'endpoint' },
  operationKey: { target: 'operationKey' },
  correlationId: { target: 'correlationId' },
  environment: { target: 'environment' },
  prerequisiteType: { target: 'prerequisiteType' },
  prerequisiteEndpoint: { target: 'prerequisiteEndpoint' },
  prerequisiteOperationKey: { target: 'prerequisiteOperationKey' },
  fiscalResponse: { target: 'fiscalResponse' },
  sourceAppliedAt: { target: 'sourceAppliedAt' },
  dependentsDispatchedAt: { target: 'dependentsDispatchedAt' },
  ebmStatus: { target: 'ebmStatus' },
  isRetryable: { target: 'isRetryable' },
};

const EBMSubmissionQueue = buildTenantModel({
  name: 'EBMSubmissionQueue',
  collection: 'ebmsubmissionqueues',
  delegateName: 'ebmSubmissionQueue',
  fieldMap: FIELD_MAP,
  toApi: ebmSubmissionQueueToApi,
  translateCreate: ebmSubmissionQueueTranslateCreate,
  translateUpdate: ebmSubmissionQueueTranslateUpdate,
  tenantField: 'companyId',
  mutable: true,
});

module.exports = EBMSubmissionQueue;
module.exports.DOCUMENT_TYPES = DOCUMENT_TYPES;
module.exports.QUEUE_STATUSES = QUEUE_STATUSES;

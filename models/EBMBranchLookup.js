/** Environment-scoped RRA branch directory used for warehouse reconciliation. */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  tin: { target: 'tin' },
  branchId: { target: 'branchId' },
  environment: { target: 'environment' },
  branchName: { target: 'branchName' },
  statusCode: { target: 'statusCode' },
  provinceName: { target: 'provinceName' },
  districtName: { target: 'districtName' },
  sectorName: { target: 'sectorName' },
  locationDescription: { target: 'locationDescription' },
  managerName: { target: 'managerName' },
  managerPhone: { target: 'managerPhone' },
  managerEmail: { target: 'managerEmail' },
  headOfficeYn: { target: 'headOfficeYn' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    tin: row.tin,
    branchId: row.branchId,
    environment: row.environment,
    branchName: row.branchName ?? null,
    statusCode: row.statusCode ?? null,
    provinceName: row.provinceName ?? null,
    districtName: row.districtName ?? null,
    sectorName: row.sectorName ?? null,
    locationDescription: row.locationDescription ?? null,
    managerName: row.managerName ?? null,
    managerPhone: row.managerPhone ?? null,
    managerEmail: row.managerEmail ?? null,
    headOfficeYn: row.headOfficeYn ?? null,
    source: row.source ?? {},
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company || data.companyId),
    tin: data.tin,
    branchId: data.branchId,
    environment: data.environment,
    branchName: data.branchName ?? null,
    statusCode: data.statusCode ?? null,
    provinceName: data.provinceName ?? null,
    districtName: data.districtName ?? null,
    sectorName: data.sectorName ?? null,
    locationDescription: data.locationDescription ?? null,
    managerName: data.managerName ?? null,
    managerPhone: data.managerPhone ?? null,
    managerEmail: data.managerEmail ?? null,
    headOfficeYn: data.headOfficeYn ?? null,
    source: data.source ?? {},
    lastSyncedAt: data.lastSyncedAt,
  };
}

function translateUpdate(update = {}) {
  const fields = update.$set || update;
  const mapped = {};
  for (const [key, value] of Object.entries(fields)) {
    const target = FIELD_MAP[key]?.target;
    if (target && target !== 'companyId') mapped[target] = value;
  }
  return mapped;
}

module.exports = buildGlobalModel({
  name: 'EBMBranchLookup',
  collection: 'ebm_branch_lookups',
  delegateName: 'ebmBranchLookup',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});

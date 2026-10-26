/**
 * Tenant and branch scoped cache of RRA customer TIN lookups.
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmTinToApi,
  ebmTinTranslateCreate,
  ebmTinTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  branchId: { target: 'branchId' },
  tin: { target: 'tin' },
  taxpayerName: { target: 'taxpayerName' },
  statusCode: { target: 'statusCode' },
  provinceName: { target: 'provinceName' },
  districtName: { target: 'districtName' },
  sectorName: { target: 'sectorName' },
  verificationMode: { target: 'verificationMode' },
  active: { target: 'active' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

module.exports = buildGlobalModel({
  name: 'EBMTIN',
  collection: 'ebmtins',
  delegateName: 'ebmTin',
  fieldMap: FIELD_MAP,
  toApi: ebmTinToApi,
  translateCreate: ebmTinTranslateCreate,
  translateUpdate: ebmTinTranslateUpdate,
  mutable: true,
});

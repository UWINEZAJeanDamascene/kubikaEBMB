/**
 * EBMItemClass — PostgreSQL (Prisma) backed (global delegate, company stored on row).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmItemClassToApi,
  ebmItemClassTranslateCreate,
  ebmItemClassTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  itemClassCode: { target: 'itemClassCode' },
  itemClassName: { target: 'itemClassName' },
  itemClassLevel: { target: 'itemClassLevel' },
  parentCode: { target: 'parentCode' },
  taxTypeCode: { target: 'taxTypeCode' },
  majorTarget: { target: 'majorTarget' },
  majorTargetYn: { target: 'majorTargetYn' },
  useYn: { target: 'useYn' },
  active: { target: 'active' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

module.exports = buildGlobalModel({
  name: 'EBMItemClass',
  collection: 'ebmitemclasses',
  delegateName: 'ebmItemClass',
  fieldMap: FIELD_MAP,
  toApi: ebmItemClassToApi,
  translateCreate: ebmItemClassTranslateCreate,
  translateUpdate: ebmItemClassTranslateUpdate,
  mutable: true,
});

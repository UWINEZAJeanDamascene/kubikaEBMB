/**
 * EBMCode — PostgreSQL (Prisma) backed (global delegate, company stored on row).
 */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const {
  ebmCodeToApi,
  ebmCodeTranslateCreate,
  ebmCodeTranslateUpdate,
} = require('../utils/phase10Mappers');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  codeClass: { target: 'codeClass' },
  codeClassName: { target: 'codeClassName' },
  codeClassDescription: { target: 'codeClassDescription' },
  classUserDefinedName1: { target: 'classUserDefinedName1' },
  classUserDefinedName2: { target: 'classUserDefinedName2' },
  classUserDefinedName3: { target: 'classUserDefinedName3' },
  codeClassUseYn: { target: 'codeClassUseYn' },
  codeClassSource: { target: 'codeClassSource' },
  code: { target: 'code' },
  name: { target: 'name' },
  description: { target: 'description' },
  sortOrder: { target: 'sortOrder' },
  userDefinedCode1: { target: 'userDefinedCode1' },
  userDefinedCode2: { target: 'userDefinedCode2' },
  userDefinedCode3: { target: 'userDefinedCode3' },
  useYn: { target: 'useYn' },
  active: { target: 'active' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

module.exports = buildGlobalModel({
  name: 'EBMCode',
  collection: 'ebmcodes',
  delegateName: 'ebmCode',
  fieldMap: FIELD_MAP,
  toApi: ebmCodeToApi,
  translateCreate: ebmCodeTranslateCreate,
  translateUpdate: ebmCodeTranslateUpdate,
  mutable: true,
});

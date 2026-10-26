/** RRA code-class metadata, stored independently so empty detail lists survive sync. */

const { buildGlobalModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const FIELD_MAP = {
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  codeClass: { target: 'codeClass' },
  name: { target: 'name' },
  description: { target: 'description' },
  userDefinedName1: { target: 'userDefinedName1' },
  userDefinedName2: { target: 'userDefinedName2' },
  userDefinedName3: { target: 'userDefinedName3' },
  useYn: { target: 'useYn' },
  active: { target: 'active' },
  source: { target: 'source' },
  lastSyncedAt: { target: 'lastSyncedAt' },
};

function toApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    codeClass: row.codeClass,
    name: row.name,
    description: row.description ?? null,
    userDefinedName1: row.userDefinedName1 ?? null,
    userDefinedName2: row.userDefinedName2 ?? null,
    userDefinedName3: row.userDefinedName3 ?? null,
    useYn: row.useYn ?? null,
    active: row.active,
    source: row.source ?? {},
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: data.company || data.companyId,
    codeClass: data.codeClass,
    name: data.name,
    description: data.description ?? null,
    userDefinedName1: data.userDefinedName1 ?? null,
    userDefinedName2: data.userDefinedName2 ?? null,
    userDefinedName3: data.userDefinedName3 ?? null,
    useYn: data.useYn ?? null,
    active: data.active ?? true,
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
  name: 'EBMCodeClass',
  collection: 'ebmcodeclasses',
  delegateName: 'ebmCodeClass',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  mutable: true,
});

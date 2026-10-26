const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

function invalidScope(field) {
  const error = new TypeError(`Registered-item lookup scope requires a valid ${field}.`);
  error.code = 'EBM_ITEM_LOOKUP_SCOPE_INVALID';
  error.statusCode = 422;
  error.field = field;
  return error;
}

function validateScope(scope = {}) {
  if (typeof scope.companyId !== 'string' || scope.companyId.trim() === '') {
    throw invalidScope('companyId');
  }
  if (typeof scope.tin !== 'string' || !/^\d{9}$/.test(scope.tin)) {
    throw invalidScope('tin');
  }
  if (typeof scope.branchId !== 'string' || !/^\d{2}$/.test(scope.branchId)) {
    throw invalidScope('branchId');
  }
  if (typeof scope.environment !== 'string' || !scope.environment.trim()) {
    throw invalidScope('environment');
  }
  return {
    companyId: scope.companyId.trim(),
    tin: scope.tin,
    branchId: scope.branchId,
    environment: scope.environment.trim(),
  };
}

function malformedItem(index, field, detail) {
  const error = new TypeError(`VSDC item select response row ${index + 1} has invalid ${field}: ${detail}.`);
  error.code = 'EBM_ITEM_SELECT_RESPONSE_MALFORMED';
  error.statusCode = 502;
  error.retryable = false;
  error.row = index + 1;
  error.field = field;
  return error;
}

function mapRegisteredItemForUpsert(scope, item, syncedAt) {
  const data = {
    itemClsCd: item.itemClsCd ?? null,
    itemNm: item.itemNm ?? null,
    useYn: item.useYn ?? null,
    source: item,
    lastSyncedAt: syncedAt,
  };
  return {
    where: {
      scopeItemKey: {
        ...scope,
        itemCd: item.itemCd,
      },
    },
    create: {
      id: generateObjectId(),
      ...scope,
      itemCd: item.itemCd,
      ...data,
    },
    update: data,
  };
}

async function persistRegisteredItems(tx, scope, itemList, syncedAt = new Date()) {
  const validatedScope = validateScope(scope);
  if (!tx?.ebmRegisteredItem || typeof tx.ebmRegisteredItem.upsert !== 'function') {
    throw new TypeError('A Prisma transaction client with the ebmRegisteredItem delegate is required.');
  }
  if (!Array.isArray(itemList)) {
    throw new TypeError('Registered-item persistence requires a validated item array.');
  }
  if (!(syncedAt instanceof Date) || Number.isNaN(syncedAt.getTime())) {
    throw new TypeError('Registered-item persistence requires a valid sync timestamp.');
  }

  const seenItemCodes = new Set();
  for (let index = 0; index < itemList.length; index += 1) {
    const item = itemList[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw malformedItem(index, 'item', 'expected an object');
    }
    const itemCodeLength = typeof item.itemCd === 'string' ? Array.from(item.itemCd).length : 0;
    if (typeof item.itemCd !== 'string' || itemCodeLength === 0 || itemCodeLength > 20) {
      throw malformedItem(index, 'itemCd', 'expected a non-empty string of at most 20 characters');
    }
    if (seenItemCodes.has(item.itemCd)) {
      throw malformedItem(index, 'itemCd', 'duplicates an item code in the same response');
    }
    seenItemCodes.add(item.itemCd);
  }

  for (const item of itemList) {
    await tx.ebmRegisteredItem.upsert(mapRegisteredItemForUpsert(validatedScope, item, syncedAt));
  }

  return { upserted: itemList.length };
}

async function findRegisteredItems(scope) {
  const validatedScope = validateScope(scope);
  return prisma.ebmRegisteredItem.findMany({
    where: validatedScope,
    orderBy: { itemCd: 'asc' },
  });
}

module.exports = {
  findRegisteredItems,
  mapRegisteredItemForUpsert,
  persistRegisteredItems,
  validateScope,
};

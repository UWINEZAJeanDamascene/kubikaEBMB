jest.mock('../lib/prisma', () => ({
  prisma: {
    ebmRegisteredItem: {
      findMany: jest.fn(),
    },
  },
}));

const { prisma } = require('../lib/prisma');
const {
  findRegisteredItems,
  persistRegisteredItems,
} = require('../services/ebmRegisteredItemService');

const SCOPE = {
  companyId: '0123456789abcdef01234567',
  tin: '999991130',
  branchId: '02',
  environment: 'sandbox',
};

function makeTransaction() {
  return {
    ebmRegisteredItem: {
      upsert: jest.fn(async () => ({ id: 'item-row-id' })),
    },
  };
}

describe('registered RRA item persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts complete source records under the company, TIN, branch, and environment identity', async () => {
    const tx = makeTransaction();
    const item = {
      tin: '999991130',
      regBhfId: '02',
      itemCd: '00123456789012345678',
      itemClsCd: '1234567890',
      itemNm: 'Registered item',
      itemStdNm: null,
      dftPrc: 25.5,
      useYn: 'Y',
      extensionFromRra: { preserved: true },
    };
    const syncedAt = new Date('2026-10-15T10:00:00.000Z');

    await expect(persistRegisteredItems(tx, SCOPE, [item], syncedAt)).resolves.toEqual({ upserted: 1 });

    expect(tx.ebmRegisteredItem.upsert).toHaveBeenCalledWith({
      where: {
        scopeItemKey: {
          ...SCOPE,
          itemCd: '00123456789012345678',
        },
      },
      create: expect.objectContaining({
        ...SCOPE,
        itemCd: '00123456789012345678',
        itemClsCd: '1234567890',
        itemNm: 'Registered item',
        useYn: 'Y',
        source: item,
        lastSyncedAt: syncedAt,
      }),
      update: {
        itemClsCd: '1234567890',
        itemNm: 'Registered item',
        useYn: 'Y',
        source: item,
        lastSyncedAt: syncedAt,
      },
    });
    expect(tx.ebmRegisteredItem.upsert.mock.calls[0][0].create.id).toMatch(/^[a-f\d]{24}$/);
  });

  it('preserves inactive records and does not delete items absent from a later response', async () => {
    const tx = makeTransaction();
    const inactiveItem = { itemCd: 'RW1ITEM00000001', useYn: 'N' };

    await persistRegisteredItems(tx, SCOPE, [inactiveItem]);

    expect(tx.ebmRegisteredItem.upsert).toHaveBeenCalledTimes(1);
    expect(tx.ebmRegisteredItem.upsert.mock.calls[0][0].create.useYn).toBe('N');
    expect(tx.ebmRegisteredItem).not.toHaveProperty('deleteMany');
  });

  it('uses a composite key that isolates company, TIN, branch, environment, and exact item code', async () => {
    const tx = makeTransaction();
    const itemCode = '00000000000000000001';
    const scopes = [
      SCOPE,
      { ...SCOPE, companyId: '1123456789abcdef01234567' },
      { ...SCOPE, tin: '111111111' },
      { ...SCOPE, branchId: '00' },
      { ...SCOPE, environment: 'production' },
    ];

    for (const scope of scopes) {
      await persistRegisteredItems(tx, scope, [{ itemCd: itemCode }]);
    }

    expect(tx.ebmRegisteredItem.upsert.mock.calls.map(([args]) => args.where.scopeItemKey))
      .toEqual(scopes.map((scope) => ({ ...scope, itemCd: itemCode })));
  });

  it('rejects duplicate or missing item codes instead of overwriting an ambiguous response row', async () => {
    const tx = makeTransaction();

    await expect(persistRegisteredItems(tx, SCOPE, [
      { itemCd: 'DUPLICATE' },
      { itemCd: 'DUPLICATE' },
    ])).rejects.toMatchObject({
      code: 'EBM_ITEM_SELECT_RESPONSE_MALFORMED',
      row: 2,
      field: 'itemCd',
    });
    expect(tx.ebmRegisteredItem.upsert).not.toHaveBeenCalled();

    const emptyTx = makeTransaction();
    await expect(persistRegisteredItems(emptyTx, SCOPE, [{ itemNm: 'No identity' }])).rejects.toMatchObject({
      code: 'EBM_ITEM_SELECT_RESPONSE_MALFORMED',
      row: 1,
      field: 'itemCd',
    });
    expect(emptyTx.ebmRegisteredItem.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['companyId', { ...SCOPE, companyId: '' }],
    ['tin', { ...SCOPE, tin: '99999113' }],
    ['branchId', { ...SCOPE, branchId: '002' }],
    ['environment', { ...SCOPE, environment: '' }],
  ])('rejects missing or invalid %s on reads and writes', async (field, scope) => {
    const tx = makeTransaction();

    await expect(persistRegisteredItems(tx, scope, [])).rejects.toMatchObject({ field, statusCode: 422 });
    await expect(findRegisteredItems(scope)).rejects.toMatchObject({ field, statusCode: 422 });
    expect(tx.ebmRegisteredItem.upsert).not.toHaveBeenCalled();
    expect(prisma.ebmRegisteredItem.findMany).not.toHaveBeenCalled();
  });

  it('requires complete scope for reads so one tenant or environment cannot query another scope', async () => {
    const expected = { ...SCOPE };
    prisma.ebmRegisteredItem.findMany.mockResolvedValue([]);

    await expect(findRegisteredItems(expected)).resolves.toEqual([]);

    expect(prisma.ebmRegisteredItem.findMany).toHaveBeenCalledWith({
      where: expected,
      orderBy: { itemCd: 'asc' },
    });
  });
});

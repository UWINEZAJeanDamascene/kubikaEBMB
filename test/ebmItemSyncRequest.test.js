jest.mock('../models/Product', () => ({
  find: jest.fn(),
}));

jest.mock('../models/EBMDevice', () => ({
  EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' },
  EBM_DEVICE_MODES: { MOCK: 'mock', SANDBOX: 'sandbox', PRODUCTION: 'production' },
  findOne: jest.fn(),
}));

jest.mock('../models/EBMSyncState', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../services/transactionService', () => ({
  runInPrismaTransaction: jest.fn(async (operation) => operation({
    ebmRegisteredItem: { upsert: jest.fn(async () => ({})) },
  })),
}));

jest.mock('../services/ebmRegisteredItemService', () => ({
  persistRegisteredItems: jest.fn(async () => ({ upserted: 0 })),
}));

jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  selectItems: jest.fn(async () => ({
    ok: true,
    resultCd: '000',
    resultMsg: 'It is succeeded',
    resultDt: '20261015120000',
    data: { itemList: [] },
  })),
  formatVsdcDateTime: jest.fn(() => '20261015120000'),
}));

const Product = require('../models/Product');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const transactionService = require('../services/transactionService');
const registeredItemService = require('../services/ebmRegisteredItemService');
const ebmService = require('../services/ebmService');
const EBMItemSyncService = require('../services/ebmItemSyncService');
let transactionClient;
const originalInitialCursor = process.env.RRA_ITEM_SELECT_INITIAL_CURSOR;
const originalCursorConfirmed = process.env.RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createTransactionClient() {
  return {
    ebmRegisteredItem: { upsert: jest.fn(async () => ({})) },
    ebmSyncState: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
}

function makeState(lastReqDt = '20261014120000') {
  return {
    lastReqDt,
    save: jest.fn(async function save() {
      return this;
    }),
  };
}

function arrange({ tin = '999991130', cursor = '20261014120000' } = {}) {
  const state = makeState(cursor);
  EBMDevice.findOne.mockReturnValue({
    lean: jest.fn(async () => ({ tin })),
  });
  EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
  Product.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn(async () => []),
    }),
  });
  return state;
}

describe('registered-item select request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RRA_ITEM_SELECT_INITIAL_CURSOR;
    delete process.env.RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED;
    transactionClient = null;
    transactionService.runInPrismaTransaction.mockImplementation(async (operation) => {
      transactionClient = createTransactionClient();
      return operation(transactionClient);
    });
    registeredItemService.persistRegisteredItems.mockResolvedValue({ upserted: 0 });
    ebmService.getConfig.mockReturnValue({ mode: 'mock' });
    ebmService.selectItems.mockResolvedValue({
      ok: true,
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261015120000',
      data: { itemList: [] },
    });
  });

  afterAll(() => {
    restoreEnv('RRA_ITEM_SELECT_INITIAL_CURSOR', originalInitialCursor);
    restoreEnv('RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED', originalCursorConfirmed);
  });

  it('sends only the documented three fields with authenticated tenant, device TIN, branch and active mode', async () => {
    arrange();

    const result = await EBMItemSyncService.syncRegisteredItems('company-1', { branchId: '02' });

    expect(EBMDevice.findOne).toHaveBeenCalledWith({
      company: 'company-1',
      branchId: '02',
      status: 'initialized',
      initializedMode: 'mock',
    });
    expect(EBMSyncState.findOneAndUpdate).toHaveBeenCalledWith(
      { company: 'company-1', branchId: '02', syncType: 'registered_items', mode: 'mock' },
      expect.any(Object),
      { upsert: true, new: true },
    );
    expect(ebmService.selectItems).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '02',
      lastReqDt: '20261014120000',
    });
    expect(ebmService.selectItems.mock.calls[0][0]).toEqual({
      tin: '999991130',
      bhfId: '02',
      lastReqDt: '20261014120000',
    });
    expect(result).toMatchObject({ companyId: 'company-1', branchId: '02', mode: 'mock' });
  });

  it('uses the first-sync cursor for a full sync', async () => {
    arrange({ cursor: '20261014120000' });

    const result = await EBMItemSyncService.syncRegisteredItems('company-1', { full: true });

    expect(ebmService.selectItems).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });
    expect(result.summary).toMatchObject({
      cursorPolicy: 'mock_simulated_incremental',
      cursorBaseline: '20000101000000',
    });
  });

  it('accepts a successful empty list and commits only the valid server result date', async () => {
    const state = arrange({ cursor: '20261014120000' });
    ebmService.selectItems.mockResolvedValue({
      ok: true,
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261015123045',
      data: { itemList: [] },
    });

    const result = await EBMItemSyncService.syncRegisteredItems('company-1');

    expect(result.items).toEqual([]);
    expect(result.summary.pulled).toBe(0);
    expect(result.lastReqDt).toBe('20261015123045');
    expect(state.lastReqDt).toBe('20261015123045');
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: 'company-1',
        branchId: '00',
        syncType: 'registered_items',
        mode: 'mock',
        lastReqDt: '20261014120000',
      }),
      data: expect.objectContaining({ lastReqDt: '20261015123045' }),
    }));
    expect(transactionService.runInPrismaTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 120000, isolationLevel: 'Serializable' },
    );
    expect(transactionClient.ebmSyncState.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(registeredItemService.persistRegisteredItems.mock.invocationCallOrder[0]);
    expect(registeredItemService.persistRegisteredItems.mock.calls[0][0]).toBe(transactionClient);
    expect(result.summary.cursorPolicy).toBe('mock_simulated_incremental');
  });

  it.each([
    ['missing itemList', { ok: true, resultCd: '000', resultMsg: 'ok', resultDt: '20261015123045', data: {} }],
    ['missing result date', { ok: true, resultCd: '000', resultMsg: 'ok', data: { itemList: [] } }],
    ['malformed result date', { ok: true, resultCd: '000', resultMsg: 'ok', resultDt: '20260230000000', data: { itemList: [] } }],
    ['non-success result code', { ok: true, resultCd: '001', resultMsg: 'rejected', resultDt: '20261015123045', data: { itemList: [] } }],
    ['failed normalized envelope', { ok: false, resultCd: '000', resultMsg: 'ok', resultDt: '20261015123045', data: { itemList: [] } }],
  ])('rejects %s before product lookup and cursor commit', async (_caseName, response) => {
    const state = arrange({ cursor: '20261014120000' });
    ebmService.selectItems.mockResolvedValue(response);

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      statusCode: 502,
    });

    expect(Product.find).not.toHaveBeenCalled();
    expect(transactionService.runInPrismaTransaction).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20261014120000');
    expect(transactionService.runInPrismaTransaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed later row before any local product query or cursor commit', async () => {
    const state = arrange({ cursor: '20261014120000' });
    ebmService.selectItems.mockResolvedValue({
      ok: true,
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261015123045',
      data: {
        itemList: [
          { itemCd: 'RW1MOCK000000001', itemNm: 'Valid' },
          { itemCd: 'RW1MOCK000000002', itemNm: 'X'.repeat(201) },
        ],
      },
    });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SELECT_RESPONSE_MALFORMED',
      statusCode: 502,
      row: 2,
      field: 'itemNm',
    });
    expect(Product.find).not.toHaveBeenCalled();
    expect(transactionService.runInPrismaTransaction).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20261014120000');
    expect(transactionService.runInPrismaTransaction).not.toHaveBeenCalled();
  });

  it('matches by the unmodified string itemCd and preserves inactive rows', async () => {
    const state = arrange();
    const localProduct = { _id: 'local-1', name: 'Local item', ebm: { ebmItemCode: '00123456789012345678' } };
    Product.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn(async () => [localProduct]),
      }),
    });
    ebmService.selectItems.mockResolvedValue({
      ok: true,
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261015123045',
      data: {
        itemList: [{
          itemCd: '00123456789012345678',
          itemNm: 'RRA item',
          itemClsCd: '1234567890',
          taxTyCd: 'B',
          useYn: 'N',
        }],
      },
    });

    const result = await EBMItemSyncService.syncRegisteredItems('company-1');

    expect(result.items[0]).toMatchObject({
      itemCd: '00123456789012345678',
      matchStatus: 'matched',
      localProductId: 'local-1',
      useYn: 'N',
    });
    expect(Product.find).toHaveBeenCalledWith({
      company: 'company-1',
      'ebm.ebmItemCode': { $in: ['00123456789012345678'] },
    });
    expect(state.lastReqDt).toBe('20261015123045');
    expect(result.summary.inactive).toBe(1);
    expect(registeredItemService.persistRegisteredItems).toHaveBeenCalledWith(
      expect.any(Object),
      { companyId: 'company-1', tin: '999991130', branchId: '00', environment: 'mock' },
      expect.arrayContaining([expect.objectContaining({
        itemCd: '00123456789012345678',
        useYn: 'N',
      })]),
      expect.any(Date),
    );
    expect(transactionService.runInPrismaTransaction).toHaveBeenCalledTimes(1);
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not save the sync cursor if durable item persistence fails', async () => {
    const state = arrange({ cursor: '20261014120000' });
    registeredItemService.persistRegisteredItems.mockRejectedValueOnce(new Error('database write failed'));

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_PERSISTENCE_FAILED',
      statusCode: 503,
      retryable: true,
    });

    expect(state.lastReqDt).toBe('20261014120000');
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledTimes(1);
  });

  it('retains the previous stored cursor after a failed full sync that requested the application baseline', async () => {
    const state = arrange({ cursor: '20261014120000' });
    registeredItemService.persistRegisteredItems.mockRejectedValueOnce(new Error('database write failed'));

    await expect(EBMItemSyncService.syncRegisteredItems('company-1', { full: true })).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_PERSISTENCE_FAILED',
    });

    expect(ebmService.selectItems).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lastReqDt: '20261014120000' }),
      data: expect.objectContaining({ lastReqDt: '20261015120000' }),
    }));
    expect(state.lastReqDt).toBe('20261014120000');
  });

  it('keeps the old cursor if the transaction commit fails after writes were staged', async () => {
    const state = arrange({ cursor: '20261014120000' });
    const commitError = new Error('simulated transaction commit failure');
    transactionService.runInPrismaTransaction.mockImplementationOnce(async (operation) => {
      transactionClient = createTransactionClient();
      await operation(transactionClient);
      throw commitError;
    });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_PERSISTENCE_FAILED',
      statusCode: 503,
      cause: commitError,
    });
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledTimes(1);
    expect(registeredItemService.persistRegisteredItems).toHaveBeenCalledTimes(1);
    expect(state.lastReqDt).toBe('20261014120000');
  });

  it('does not persist item records when another sync has already moved the cursor', async () => {
    const state = arrange({ cursor: '20261014120000' });
    transactionService.runInPrismaTransaction.mockImplementationOnce(async (operation) => {
      transactionClient = createTransactionClient();
      transactionClient.ebmSyncState.updateMany.mockResolvedValueOnce({ count: 0 });
      return operation(transactionClient);
    });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_CURSOR_CONFLICT',
      statusCode: 409,
      retryable: true,
    });

    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledTimes(1);
    expect(registeredItemService.persistRegisteredItems).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20261014120000');
  });

  it.each([
    ['missing authenticated company context', null, {}, 'companyId'],
    ['non-string branch ID', 'company-1', { branchId: 2 }, 'bhfId'],
    ['short branch ID', 'company-1', { branchId: '2' }, 'bhfId'],
    ['overlong branch ID', 'company-1', { branchId: '002' }, 'bhfId'],
  ])('rejects %s before querying device state', async (_caseName, companyId, options, field) => {
    await expect(EBMItemSyncService.syncRegisteredItems(companyId, options)).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_REQUEST_INVALID',
      field,
      statusCode: 422,
    });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('rejects an invalid initialized-device TIN before reading the cursor or calling VSDC', async () => {
    EBMDevice.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ tin: '99999X130' })),
    });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_REQUEST_INVALID',
      field: 'tin',
      statusCode: 422,
    });
    expect(EBMSyncState.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('rejects an uninitialized device in the active mode before reading cursor state', async () => {
    EBMDevice.findOne.mockReturnValue({
      lean: jest.fn(async () => null),
    });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_DEVICE_NOT_INITIALIZED',
      statusCode: 409,
    });
    expect(EBMSyncState.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('rejects an invalid stored cursor before calling selectItems', async () => {
    arrange({ cursor: '20260230000000' });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_REQUEST_INVALID',
      field: 'lastReqDt',
      statusCode: 422,
    });
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('rejects an unavailable EBM mode before device or sync-state queries', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'unknown' });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_REQUEST_INVALID',
      field: 'mode',
      statusCode: 422,
    });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
    expect(EBMSyncState.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('requires an explicit starting cursor in sandbox before querying device or cursor state', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_CURSOR_BASELINE_REQUIRED',
      statusCode: 409,
      retryable: false,
    });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
    expect(EBMSyncState.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ebmService.selectItems).not.toHaveBeenCalled();
  });

  it('replays a configured baseline without advancing an unconfirmed sandbox cursor', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    process.env.RRA_ITEM_SELECT_INITIAL_CURSOR = '20160523000000';
    const state = arrange({ cursor: '20261014120000' });

    const result = await EBMItemSyncService.syncRegisteredItems('company-1');

    expect(ebmService.selectItems).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20160523000000',
    });
    expect(result.lastReqDt).toBe('20160523000000');
    expect(result.summary).toMatchObject({
      cursorPolicy: 'fixed_baseline_replay_unconfirmed',
      cursorAdvanced: false,
      cursorBaseline: '20160523000000',
    });
    expect(state.lastReqDt).toBe('20160523000000');
    expect(transactionClient.ebmSyncState.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lastReqDt: '20261014120000' }),
      data: expect.objectContaining({ lastReqDt: '20160523000000' }),
    }));
  });

  it('uses and advances the stored sandbox cursor only after cursor semantics are explicitly confirmed', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    process.env.RRA_ITEM_SELECT_INITIAL_CURSOR = '20160523000000';
    process.env.RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED = 'true';
    const state = arrange({ cursor: '20261014120000' });

    const result = await EBMItemSyncService.syncRegisteredItems('company-1');

    expect(ebmService.selectItems).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20261014120000',
    });
    expect(result.lastReqDt).toBe('20261015120000');
    expect(result.summary).toMatchObject({
      cursorPolicy: 'rra_confirmed_incremental',
      cursorAdvanced: true,
    });
    expect(state.lastReqDt).toBe('20261015120000');
  });

  it('rejects an invalid configured sandbox baseline before device lookup', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'production' });
    process.env.RRA_ITEM_SELECT_INITIAL_CURSOR = '20260230000000';

    await expect(EBMItemSyncService.syncRegisteredItems('company-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SYNC_CURSOR_BASELINE_REQUIRED',
      statusCode: 409,
    });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
  });
});

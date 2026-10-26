jest.mock('../models/Company', () => ({ find: jest.fn() }));
jest.mock('../models/Client', () => Object.assign(jest.fn(), { find: jest.fn() }));
jest.mock('../models/EBMDevice', () => Object.assign(jest.fn(), {
  find: jest.fn(),
  findOne: jest.fn(),
  EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' },
}));
jest.mock('../models/EBMCode', () => Object.assign(jest.fn(), { bulkWrite: jest.fn() }));
jest.mock('../models/EBMCodeClass', () => Object.assign(jest.fn(), { bulkWrite: jest.fn() }));
jest.mock('../models/EBMBranchLookup', () => Object.assign(jest.fn(), { bulkWrite: jest.fn(), find: jest.fn() }));
jest.mock('../models/EBMItemClass', () => Object.assign(jest.fn(), { bulkWrite: jest.fn() }));
jest.mock('../models/EBMTIN', () => Object.assign(jest.fn(), { bulkWrite: jest.fn() }));
jest.mock('../models/EBMNotice', () => Object.assign(jest.fn(), { bulkWrite: jest.fn() }));
jest.mock('../models/EBMSyncState', () => Object.assign(jest.fn(), {
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'sandbox' })),
  formatVsdcDateTime: jest.fn(() => '20261013120000'),
  selectCodes: jest.fn(),
  selectItemClasses: jest.fn(),
  selectCustomer: jest.fn(),
  selectBranches: jest.fn(),
  selectNotices: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(async (operation) => operation()),
}));

const EBMSyncState = require('../models/EBMSyncState');
const Company = require('../models/Company');
const Client = require('../models/Client');
const EBMDevice = require('../models/EBMDevice');
const EBMCode = require('../models/EBMCode');
const EBMCodeClass = require('../models/EBMCodeClass');
const EBMBranchLookup = require('../models/EBMBranchLookup');
const EBMItemClass = require('../models/EBMItemClass');
const EBMTIN = require('../models/EBMTIN');
const EBMNotice = require('../models/EBMNotice');
const ebmService = require('../services/ebmService');
const EBMCodeSyncService = require('../services/ebmCodeSyncService');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const CODE_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.1-4.3.json');
const NATION_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.4.json');
const UNIT_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.5-4.6.json');
const CURRENCY_TRANSACTION_PAYMENT_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.7-4.10.json');

describe('EBM lookup sync boundaries', () => {
  const originalCursor = process.env.EBM_CODE_SYNC_INITIAL_CURSOR;
  const originalItemClassCursorFlag = process.env.EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED;
  const originalStandardCursorFlag = process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EBM_CODE_SYNC_INITIAL_CURSOR = '20200101000000';
    process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED = 'true';
    delete process.env.EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED;
  });
  afterAll(() => {
    if (originalCursor === undefined) delete process.env.EBM_CODE_SYNC_INITIAL_CURSOR;
    else process.env.EBM_CODE_SYNC_INITIAL_CURSOR = originalCursor;
    if (originalItemClassCursorFlag === undefined) delete process.env.EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED;
    else process.env.EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED = originalItemClassCursorFlag;
    if (originalStandardCursorFlag === undefined) delete process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED;
    else process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED = originalStandardCursorFlag;
  });

  it('pins the versioned §4.1–4.3 table rows and source identity exactly', () => {
    expect(CODE_DEFINITION_BASELINE.source).toEqual({
      documentId: 'RRA_VSDC_DOC_v1.0.5',
      version: '1.0.5',
      sha256: '25DF854736B60E7E4EB128BF99904813C5D96ACF99464B7B48F23C7FAB3DF9C1',
      section: '4.1-4.3',
      printedPage: 58,
      physicalPdfPage: 62,
    });
    expect(CODE_DEFINITION_BASELINE.classifications).toEqual([
      {
        codeClass: '04', codeClassName: 'Tax Type', details: [
          { code: 'A', sortOrder: 1, name: 'A-EX', description: 'A-EX', remark: '' },
          { code: 'B', sortOrder: 2, name: 'B-18.00%', description: 'B-18.00%', remark: '' },
          { code: 'C', sortOrder: 3, name: 'C', description: 'C', remark: '' },
          { code: 'D', sortOrder: 4, name: 'D', description: 'D', remark: '' },
        ],
      },
      {
        codeClass: '15', codeClassName: 'Taxpayer Status', details: [
          { code: 'A', sortOrder: 1, name: 'Active', description: 'Active', remark: '' },
          { code: 'D', sortOrder: 2, name: 'Discard', description: 'Discard', remark: '' },
        ],
      },
      {
        codeClass: '24', codeClassName: 'Product Type', details: [
          { code: '1', sortOrder: 1, name: 'Raw Material', description: 'Raw Material', remark: '' },
          { code: '2', sortOrder: 2, name: 'Finished Product', description: 'Finished Product', remark: '' },
          { code: '3', sortOrder: 3, name: 'Service without stock', description: 'Service without stock', remark: '' },
        ],
      },
    ]);
  });

  it('does not advance a tenant/branch/type/environment cursor when response shape is invalid', async () => {
    const state = {
      lastReqDt: '20261001101010',
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.selectCodes.mockResolvedValue({
      raw: {
        resultCd: '000',
        resultMsg: 'It is succeeded',
        resultDt: '20261013120000',
        data: { clsList: {} },
      },
    });

    await expect(EBMCodeSyncService.syncType(
      'tenant-1',
      '00',
      EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    )).rejects.toMatchObject({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' });

    expect(EBMSyncState.findOneAndUpdate).toHaveBeenCalledWith(
      { company: 'tenant-1', branchId: '00', syncType: 'standard_codes', mode: 'sandbox' },
      expect.any(Object),
      { upsert: true, new: true },
    );
    expect(state.lastReqDt).toBe('20261001101010');
    expect(state.lastErrorMessage).toMatch(/invalid response/i);
    expect(state.save).toHaveBeenCalledTimes(1);
  });

  it('persists every class and detail field, including an empty class, before committing the response cursor', async () => {
    const state = {
      lastReqDt: '20200101000000',
      lastSuccessfulSyncAt: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: 2, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0 });
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013120000',
      data: { clsList: [
        {
          cdCls: '04', cdClsNm: 'Tax Type', cdClsDesc: null, useYn: 'Y',
          userDfnNm1: 'Tax Rate', userDfnNm2: null, userDfnNm3: null,
          dtlList: [{
            cd: 'B', cdNm: 'B - 18.00%', cdDesc: 'Standard rate', useYn: 'Y', srtOrd: 2,
            userDfnCd1: '18', userDfnCd2: null, userDfnCd3: null,
          }],
        },
        {
          cdCls: '99', cdClsNm: 'Empty class', cdClsDesc: null, useYn: 'N',
          userDfnNm1: null, userDfnNm2: null, userDfnNm3: null, dtlList: [],
        },
      ] },
    } });

    const result = await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    expect(ebmService.selectCodes).toHaveBeenCalledWith({
      tin: '001234567', bhfId: '00', lastReqDt: '20200101000000',
    });
    expect(EBMCodeClass.bulkWrite).toHaveBeenCalledTimes(1);
    const classOps = EBMCodeClass.bulkWrite.mock.calls[0][0];
    expect(classOps).toHaveLength(2);
    expect(classOps[0].updateOne.filter).toEqual({ company: 'tenant-1', codeClass: '04' });
    expect(classOps[0].updateOne.update.$set).toMatchObject({
      name: 'Tax Type', description: null, userDefinedName1: 'Tax Rate',
      userDefinedName2: null, userDefinedName3: null, useYn: 'Y', active: true,
      source: expect.objectContaining({ cdCls: '04', dtlList: expect.any(Array) }),
    });
    expect(classOps[1].updateOne.update.$set).toMatchObject({ codeClass: '99', active: false });
    expect(classOps[1].updateOne.update.$set.source.dtlList).toEqual([]);
    expect(EBMCode.bulkWrite.mock.calls[0][0][0].updateOne.update.$set).toMatchObject({
      codeClass: '04', code: 'B', name: 'B - 18.00%', description: 'Standard rate',
      sortOrder: 2, userDefinedCode1: '18', userDefinedCode2: null, userDefinedCode3: null,
      useYn: 'Y', source: expect.objectContaining({ cd: 'B' }),
    });
    expect(state.lastReqDt).toBe('20261013120000');
    expect(state.summary).toMatchObject({ receivedClasses: 2, receivedDetails: 1, classesUpserted: 2 });
    expect(result).toMatchObject({ success: true, receivedClasses: 2, receivedDetails: 1, resultDt: '20261013120000' });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(EBMCodeClass.bulkWrite.mock.invocationCallOrder[0]).toBeLessThan(EBMCode.bulkWrite.mock.invocationCallOrder[0]);
    expect(EBMCode.bulkWrite.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0]);
  });

  it('persists all published nation codes under exact class 05 before advancing the sync cursor', async () => {
    const state = {
      lastReqDt: '20200101000000',
      lastSuccessfulSyncAt: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const nation = NATION_DEFINITION_BASELINE.classifications[0];
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: nation.details.length, matchedCount: 0, modifiedCount: 0 });
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013120000',
      data: { clsList: [{
        cdCls: nation.codeClass,
        cdClsNm: nation.codeClassName,
        cdClsDesc: 'Nation',
        useYn: 'Y',
        userDfnNm1: null,
        userDfnNm2: null,
        userDfnNm3: null,
        dtlList: nation.details.map((detail) => ({
          cd: detail.code,
          cdNm: detail.name,
          cdDesc: detail.description,
          useYn: 'Y',
          srtOrd: detail.sortOrder,
          userDfnCd1: null,
          userDfnCd2: null,
          userDfnCd3: null,
        })),
      }] },
    } });

    await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    const classOp = EBMCodeClass.bulkWrite.mock.calls[0][0][0].updateOne;
    expect(classOp.filter).toEqual({ company: 'tenant-1', codeClass: '05' });
    expect(classOp.update.$set).toMatchObject({ name: 'Nation', active: true });
    const nationCodeOps = EBMCode.bulkWrite.mock.calls[0][0]
      .map((operation) => operation.updateOne)
      .filter((operation) => operation.filter.codeClass === '05');
    expect(nationCodeOps).toHaveLength(252);
    expect(nationCodeOps.find((operation) => operation.filter.code === 'RW').update.$set)
      .toMatchObject({ name: 'RWANDA', description: 'RWANDA', sortOrder: 193, active: true });
    expect(state.lastReqDt).toBe('20261013120000');
    expect(state.save).toHaveBeenCalledTimes(1);
  });

  it('persists all 95 unit rows under tenant and exact class identities with source values before cursor commit', async () => {
    const state = {
      lastReqDt: '20200101000000',
      lastSuccessfulSyncAt: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const clsList = UNIT_DEFINITION_BASELINE.classifications.map((classification) => ({
      cdCls: classification.codeClass,
      cdClsNm: classification.codeClassName,
      cdClsDesc: null,
      userDfnNm1: null,
      userDfnNm2: null,
      userDfnNm3: null,
      useYn: 'Y',
      dtlList: classification.details.map((detail) => ({
        cd: detail.code,
        cdNm: detail.name,
        cdDesc: detail.description,
        srtOrd: detail.sortOrder,
        userDfnCd1: null,
        userDfnCd2: null,
        userDfnCd3: null,
        useYn: 'Y',
      })),
    }));
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: 2, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: 95, matchedCount: 0, modifiedCount: 0 });
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList },
    } });

    const result = await EBMCodeSyncService.syncType(
      'tenant-units', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    expect(EBMCodeClass.bulkWrite).toHaveBeenCalledTimes(1);
    expect(EBMCodeClass.bulkWrite.mock.calls[0][0].map(({ updateOne }) => updateOne.filter)).toEqual([
      { company: 'tenant-units', codeClass: '17' },
      { company: 'tenant-units', codeClass: '10' },
    ]);
    const detailOps = EBMCode.bulkWrite.mock.calls[0][0].map(({ updateOne }) => updateOne);
    expect(detailOps).toHaveLength(95);
    for (const classification of UNIT_DEFINITION_BASELINE.classifications) {
      for (const detail of classification.details) {
        const operation = detailOps.find(({ filter }) => (
          filter.company === 'tenant-units'
          && filter.codeClass === classification.codeClass
          && filter.code === detail.code
        ));
        expect(operation).toBeDefined();
        expect(operation.update.$set).toMatchObject({
          company: 'tenant-units',
          codeClass: classification.codeClass,
          codeClassName: classification.codeClassName,
          code: detail.code,
          name: detail.name,
          description: detail.description,
          sortOrder: detail.sortOrder,
          active: true,
          useYn: 'Y',
          source: expect.objectContaining({
            cd: detail.code,
            cdNm: detail.name,
            cdDesc: detail.description,
            srtOrd: detail.sortOrder,
          }),
          codeClassSource: expect.objectContaining({ cdCls: classification.codeClass }),
        });
      }
    }
    expect(result).toMatchObject({ receivedClasses: 2, receivedDetails: 95, resultDt: '20261013120000' });
    expect(state.lastReqDt).toBe('20261013120000');
    expect(EBMCode.bulkWrite.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0]);
  });

  it('syncs every exact §4.1–4.3 baseline code, label, order, and raw detail under tenant-scoped identities', async () => {
    const state = {
      lastReqDt: '20200101000000',
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: 3, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: 9, matchedCount: 0 });
    const clsList = CODE_DEFINITION_BASELINE.classifications.map((classification) => ({
      cdCls: classification.codeClass,
      cdClsNm: classification.codeClassName,
      cdClsDesc: null,
      userDfnNm1: null,
      userDfnNm2: null,
      userDfnNm3: null,
      useYn: 'Y',
      dtlList: classification.details.map((detail) => ({
        cd: detail.code,
        cdNm: detail.name,
        cdDesc: detail.description,
        srtOrd: detail.sortOrder,
        userDfnCd1: null,
        userDfnCd2: null,
        userDfnCd3: null,
        useYn: 'Y',
      })),
    }));
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList },
    } });

    await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    const classOps = EBMCodeClass.bulkWrite.mock.calls[0][0].map((operation) => operation.updateOne);
    const detailOps = EBMCode.bulkWrite.mock.calls[0][0].map((operation) => operation.updateOne);
    for (const classification of CODE_DEFINITION_BASELINE.classifications) {
      const classOp = classOps.find((operation) => operation.filter.codeClass === classification.codeClass);
      expect(classOp.filter).toEqual({ company: 'tenant-1', codeClass: classification.codeClass });
      expect(classOp.update.$set.name).toBe(classification.codeClassName);
      expect(classOp.update.$set.source.cdCls).toBe(classification.codeClass);
      expect(classOp.update.$set.source.dtlList).toHaveLength(classification.details.length);

      for (const detail of classification.details) {
        const operation = detailOps.find((candidate) => (
          candidate.filter.codeClass === classification.codeClass
          && candidate.filter.code === detail.code
        ));
        expect(operation.filter).toEqual({
          company: 'tenant-1', codeClass: classification.codeClass, code: detail.code,
        });
        expect(operation.update.$set).toMatchObject({
          codeClass: classification.codeClass,
          code: detail.code,
          name: detail.name,
          description: detail.description,
          sortOrder: detail.sortOrder,
          useYn: 'Y',
          active: true,
          source: expect.objectContaining({
            cd: detail.code,
            cdNm: detail.name,
            cdDesc: detail.description,
            srtOrd: detail.sortOrder,
          }),
        });
        expect(typeof operation.update.$set.code).toBe('string');
        expect(typeof operation.update.$set.sortOrder).toBe('number');
      }
    }
    expect(detailOps).toHaveLength(9);
    expect(state.lastReqDt).toBe('20261013120000');
  });

  it('persists §§4.7–4.10 source values with compound tenant/class/code keys and no delete operations', async () => {
    const state = { lastReqDt: '20200101000000', save: jest.fn().mockResolvedValue(undefined) };
    const clsList = CURRENCY_TRANSACTION_PAYMENT_BASELINE.classifications.map((classification) => ({
      cdCls: classification.codeClass,
      cdClsNm: classification.codeClassName,
      cdClsDesc: null,
      userDfnNm1: null,
      userDfnNm2: null,
      userDfnNm3: null,
      useYn: 'Y',
      dtlList: classification.details.map((detail) => ({
        cd: detail.code,
        cdNm: detail.name,
        cdDesc: detail.description,
        srtOrd: detail.sortOrder,
        userDfnCd1: null,
        userDfnCd2: null,
        userDfnCd3: null,
        useYn: 'Y',
      })),
    }));
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: clsList.length, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: 192, matchedCount: 0, modifiedCount: 0 });
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList },
    } });

    await EBMCodeSyncService.syncType(
      'tenant-currencies', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    const classOps = EBMCodeClass.bulkWrite.mock.calls[0][0].map(({ updateOne }) => updateOne);
    const detailOps = EBMCode.bulkWrite.mock.calls[0][0].map(({ updateOne }) => updateOne);
    expect(classOps).toHaveLength(4);
    expect(detailOps).toHaveLength(192);
    for (const sourceClass of clsList) {
      const classOp = classOps.find(({ filter }) => filter.codeClass === sourceClass.cdCls);
      expect(classOp.filter).toEqual({ company: 'tenant-currencies', codeClass: sourceClass.cdCls });
      expect(classOp.upsert).toBe(true);
      expect(classOp.update.$set.source).toEqual(sourceClass);

      for (const sourceDetail of sourceClass.dtlList) {
        const detailOp = detailOps.find(({ filter }) => (
          filter.codeClass === sourceClass.cdCls && filter.code === sourceDetail.cd
        ));
        expect(detailOp.filter).toEqual({
          company: 'tenant-currencies', codeClass: sourceClass.cdCls, code: sourceDetail.cd,
        });
        expect(detailOp.upsert).toBe(true);
        expect(detailOp.update.$set.source).toEqual(sourceDetail);
        expect(detailOp.update.$set.codeClassSource).toEqual(sourceClass);
        expect(detailOp.update.$set.lastSyncedAt).toBeInstanceOf(Date);
        expect(typeof detailOp.update.$set.code).toBe('string');
        expect(typeof detailOp.update.$set.sortOrder).toBe('number');
        expect(detailOp.deleteOne).toBeUndefined();
        expect(detailOp.deleteMany).toBeUndefined();
      }
    }
    expect(state.lastReqDt).toBe('20261013120000');
    expect(EBMCode.bulkWrite.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0]);
  });

  it('keeps details operationally inactive when their source class is inactive', async () => {
    const state = { lastReqDt: '20200101000000', save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    EBMCode.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0 });
    const sourceClass = {
      cdCls: '37', cdClsNm: 'Sales Receipt Type', cdClsDesc: null,
      userDfnNm1: null, userDfnNm2: null, userDfnNm3: null, useYn: 'N',
      dtlList: [{
        cd: 'S', cdNm: 'Sale', cdDesc: 'Sale', srtOrd: 10,
        userDfnCd1: null, userDfnCd2: null, userDfnCd3: null, useYn: 'Y',
      }],
    };
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000',
      data: { clsList: [sourceClass] },
    } });

    await EBMCodeSyncService.syncType(
      'tenant-inactive-class', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    const detailOp = EBMCode.bulkWrite.mock.calls[0][0][0].updateOne;
    expect(detailOp.update.$set).toMatchObject({
      codeClassUseYn: 'N', useYn: 'Y', active: false,
      codeClassSource: sourceClass, source: sourceClass.dtlList[0],
    });
    expect(state.lastReqDt).toBe('20261013120000');
  });

  it('updates an existing code identity to inactive when RRA returns useYn N', async () => {
    const state = { lastReqDt: '20200101000000', save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    EBMCodeClass.bulkWrite.mockResolvedValue({ matchedCount: 1 });
    EBMCode.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList: [{
        cdCls: '24', cdClsNm: 'Product Type', cdClsDesc: null,
        userDfnNm1: null, userDfnNm2: null, userDfnNm3: null, useYn: 'Y',
        dtlList: [{
          cd: '2', cdNm: 'Finished Product', cdDesc: 'Finished Product', srtOrd: 2,
          userDfnCd1: null, userDfnCd2: null, userDfnCd3: null, useYn: 'N',
        }],
      }] },
    } });

    await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    );

    expect(EBMCode.bulkWrite).toHaveBeenCalledWith([expect.objectContaining({
      updateOne: expect.objectContaining({
        filter: { company: 'tenant-1', codeClass: '24', code: '2' },
        update: { $set: expect.objectContaining({ useYn: 'N', active: false }) },
        upsert: true,
      }),
    })]);
    expect(state.lastReqDt).toBe('20261013120000');
  });

  it.each([
    ['duplicate class key', (classes) => [classes[0], classes[0]]],
    ['duplicate detail key', (classes) => [{ ...classes[0], dtlList: [classes[0].dtlList[0], classes[0].dtlList[0]] }]],
    ['invalid class status flag', (classes) => [{ ...classes[0], useYn: 'X' }]],
    ['invalid detail status flag', (classes) => [{ ...classes[0], dtlList: [{ ...classes[0].dtlList[0], useYn: 'X' }] }]],
  ])('does not write or advance standard-code state for %s', async (_caseName, mutateClasses) => {
    const state = { lastReqDt: '20261001101010', save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    const validClass = {
      cdCls: '04', cdClsNm: 'Tax Type', cdClsDesc: null,
      userDfnNm1: null, userDfnNm2: null, userDfnNm3: null, useYn: 'Y',
      dtlList: [{
        cd: 'A', cdNm: 'A-EX', cdDesc: 'A-EX', srtOrd: 1,
        userDfnCd1: null, userDfnCd2: null, userDfnCd3: null, useYn: 'Y',
      }],
    };
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000',
      data: { clsList: mutateClasses([validClass]) },
    } });

    await expect(EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES,
      { tin: '001234567', bhfId: '00' },
    )).rejects.toMatchObject({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' });

    expect(EBMCodeClass.bulkWrite).not.toHaveBeenCalled();
    expect(EBMCode.bulkWrite).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20261001101010');
    expect(state.lastErrorMessage).toMatch(/duplicate|(?:must be|expected) Y or N/i);
  });

  it('allows an empty successful class list and commits its valid resultDt', async () => {
    const state = { lastReqDt: '20200101000000', lastSuccessfulSyncAt: null, save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList: [] },
    } });
    const result = await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES, { tin: '001234567', bhfId: '00' },
    );
    expect(EBMCodeClass.bulkWrite).not.toHaveBeenCalled();
    expect(EBMCode.bulkWrite).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20261013120000');
    expect(result).toMatchObject({ success: true, receivedClasses: 0, receivedDetails: 0 });
  });

  it('keeps standard-code live sync on the configured baseline until cursor semantics are confirmed', async () => {
    delete process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED;
    const state = { lastReqDt: '20261001101010', lastSuccessfulSyncAt: new Date(), save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.selectCodes.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList: [] },
    } });
    const result = await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES, { tin: '001234567', bhfId: '00' },
    );
    expect(ebmService.selectCodes).toHaveBeenCalledWith({
      tin: '001234567', bhfId: '00', lastReqDt: '20200101000000',
    });
    expect(state.lastReqDt).toBe('20261001101010');
    expect(result).toMatchObject({ cursorAdvanced: false, cursorPolicy: 'baseline_until_semantics_confirmed' });
    process.env.EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED = 'true';
  });

  it.each([
    ['cdCls', 'C'.repeat(3)],
    ['cdClsNm', 'N'.repeat(61)],
    ['cdClsDesc', 'D'.repeat(501)],
    ['userDfnNm1', 'U'.repeat(61)],
    ['userDfnNm2', 'U'.repeat(61)],
    ['userDfnNm3', 'U'.repeat(61)],
    ['useYn', 'Y'.repeat(2)],
  ])('rejects a standard-code class field exceeding its PDF maximum: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { clsList: [{
        cdCls: '04',
        cdClsNm: 'Tax Type',
        cdClsDesc: null,
        userDfnNm1: null,
        userDfnNm2: null,
        userDfnNm3: null,
        useYn: 'Y',
        dtlList: [],
        [field]: value,
      }] },
    };
    expect(() => EBMCodeSyncService.validateStandardCodeResponse(response))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it.each([
    ['cd', 'C'.repeat(6)],
    ['cdNm', 'N'.repeat(61)],
    ['cdDesc', 'D'.repeat(501)],
    ['srtOrd', 100000],
    ['userDfnCd1', 'U'.repeat(21)],
    ['userDfnCd2', 'U'.repeat(21)],
    ['userDfnCd3', 'U'.repeat(21)],
    ['useYn', 'Y'.repeat(2)],
  ])('rejects a standard-code detail field exceeding its PDF maximum: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { clsList: [{
        cdCls: '04',
        cdClsNm: 'Tax Type',
        useYn: 'Y',
        dtlList: [{
          cd: 'A',
          cdNm: 'Exempt',
          cdDesc: null,
          srtOrd: 1,
          userDfnCd1: null,
          userDfnCd2: null,
          userDfnCd3: null,
          useYn: 'Y',
          [field]: value,
        }],
      }] },
    };
    expect(() => EBMCodeSyncService.validateStandardCodeResponse(response))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it('preserves item-class fields and does not advance an unconfirmed item-class cursor', async () => {
    const state = {
      lastReqDt: '20200101000000', lastSuccessfulSyncAt: new Date('2026-10-01T00:00:00Z'),
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    const rraClass = {
      itemClsCd: '0014111400', itemClsNm: 'Paper products', itemClsLvl: 3,
      taxTyCd: null, mjrTgYn: null, useYn: 'Y',
    };
    ebmService.selectItemClasses.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000',
      data: { itemClsList: [rraClass] },
    } });
    EBMItemClass.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0 });

    const result = await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.ITEM_CLASSES,
      { tin: '001234567', bhfId: '00' },
    );

    expect(ebmService.selectItemClasses).toHaveBeenCalledWith({
      tin: '001234567', bhfId: '00', lastReqDt: '20200101000000',
    });
    const op = EBMItemClass.bulkWrite.mock.calls[0][0][0].updateOne;
    expect(op.filter).toEqual({ company: 'tenant-1', itemClassCode: '0014111400' });
    expect(op.update.$set).toMatchObject({
      itemClassCode: '0014111400', itemClassName: 'Paper products', itemClassLevel: 3,
      taxTypeCode: null, majorTargetYn: null, majorTarget: false, useYn: 'Y', active: true,
      source: rraClass,
    });
    expect(op.update.$set).not.toHaveProperty('parentCode');
    expect(state.lastReqDt).toBe('20200101000000');
    expect(state.summary).toMatchObject({
      received: 1, upserted: 1, resultDt: '20261013120000', cursorAdvanced: false,
      cursorPolicy: 'baseline_until_delta_confirmed',
    });
    expect(result).toMatchObject({ success: true, received: 1, lastReqDt: '20200101000000', cursorAdvanced: false });
  });

  it('rejects malformed and duplicate item-class rows before writing', async () => {
    const state = { lastReqDt: '20200101000000', lastSuccessfulSyncAt: null, save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.selectItemClasses.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000',
      data: { itemClsList: [
        { itemClsCd: 'A', itemClsNm: 'Alpha', itemClsLvl: 1, taxTyCd: null, mjrTgYn: null, useYn: 'Y' },
        { itemClsCd: 'A', itemClsNm: 'Duplicate', itemClsLvl: 2, taxTyCd: null, mjrTgYn: null, useYn: 'Y' },
      ] },
    } });
    await expect(EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.ITEM_CLASSES, { tin: '001234567', bhfId: '00' },
    )).rejects.toMatchObject({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' });
    expect(EBMItemClass.bulkWrite).not.toHaveBeenCalled();
    expect(state.lastReqDt).toBe('20200101000000');
    expect(state.lastErrorMessage).toMatch(/duplicate/i);
  });

  it.each([
    ['itemClsCd', 'C'.repeat(11)],
    ['itemClsNm', 'N'.repeat(201)],
    ['itemClsLvl', -1],
    ['taxTyCd', 'T'.repeat(6)],
    ['mjrTgYn', 'Y'.repeat(2)],
    ['useYn', 'Y'.repeat(2)],
  ])('rejects an item-class field outside its PDF shape: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { itemClsList: [{
        itemClsCd: '0014111400',
        itemClsNm: 'Paper products',
        itemClsLvl: 3,
        taxTyCd: null,
        mjrTgYn: null,
        useYn: 'Y',
        [field]: value,
      }] },
    };
    expect(() => EBMCodeSyncService.validateItemClassResponse(response))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it('advances item-class cursors only when delta semantics are explicitly confirmed', async () => {
    process.env.EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED = 'true';
    const state = {
      lastReqDt: '20261001101010', lastSuccessfulSyncAt: new Date('2026-10-01T00:00:00Z'),
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.selectItemClasses.mockResolvedValue({ raw: {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { itemClsList: [] },
    } });
    const result = await EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.ITEM_CLASSES, { tin: '001234567', bhfId: '00' },
    );
    expect(ebmService.selectItemClasses).toHaveBeenCalledWith({
      tin: '001234567', bhfId: '00', lastReqDt: '20261001101010',
    });
    expect(state.lastReqDt).toBe('20261013120000');
    expect(result).toMatchObject({ cursorAdvanced: true, cursorPolicy: 'incremental_confirmed' });
  });

  it('requires an explicit approved baseline for a first production sync', async () => {
    delete process.env.EBM_CODE_SYNC_INITIAL_CURSOR;
    ebmService.getConfig.mockReturnValue({ mode: 'production' });
    const state = { lastReqDt: '', lastErrorMessage: null, save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    await expect(EBMCodeSyncService.syncType(
      'tenant-1', '00', EBM_SYNC_TYPES.STANDARD_CODES, { tin: '001234567', bhfId: '00' },
    )).rejects.toMatchObject({ code: 'EBM_CODE_SYNC_BASELINE_REQUIRED' });
    expect(EBMSyncState.findOneAndUpdate).toHaveBeenCalledWith(
      { company: 'tenant-1', branchId: '00', syncType: 'standard_codes', mode: 'production' },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ lastReqDt: '' }) }),
      { upsert: true, new: true },
    );
    expect(state.lastReqDt).toBe('');
    expect(state.lastErrorMessage).toMatch(/baseline approved/i);
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(ebmService.selectCodes).not.toHaveBeenCalled();
  });

  it('returns explicit partial batch outcomes and per-sequence correlation metadata', async () => {
    const deviceSpy = jest.spyOn(EBMCodeSyncService, 'getInitializedDevice')
      .mockResolvedValue({ tin: '001234567', branchId: '00' });
    const syncSpy = jest.spyOn(EBMCodeSyncService, 'syncType')
      .mockResolvedValueOnce({ syncType: EBM_SYNC_TYPES.STANDARD_CODES, success: true, requestId: 'req-ok' })
      .mockRejectedValueOnce(Object.assign(new Error('RRA unavailable'), {
        code: 'EBM_VSDC_REQUEST_FAILED',
        requestId: 'req-failed',
      }));
    try {
      const result = await EBMCodeSyncService.syncAll('tenant-1', {
        branchId: '00',
        syncTypes: [EBM_SYNC_TYPES.STANDARD_CODES, EBM_SYNC_TYPES.ITEM_CLASSES],
      });
      expect(result).toMatchObject({
        companyId: 'tenant-1',
        branchId: '00',
        outcome: 'partial',
        succeededCount: 1,
        failedCount: 1,
        results: [
          { syncType: EBM_SYNC_TYPES.STANDARD_CODES, success: true, requestId: 'req-ok' },
          { syncType: EBM_SYNC_TYPES.ITEM_CLASSES, success: false, requestId: 'req-failed', errorCode: 'EBM_VSDC_REQUEST_FAILED' },
        ],
      });
    } finally {
      deviceSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });

  it('syncs only overdue lookup sequences per initialized branch', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    const now = new Date();
    const recent = new Date(now.getTime() + 60_000);
    Company.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'tenant-1' }]) }),
    });
    EBMDevice.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { branchId: '00' },
          { branchId: '01' },
        ]),
      }),
    });
    EBMSyncState.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { branchId: '00', syncType: EBM_SYNC_TYPES.STANDARD_CODES, lastSuccessfulSyncAt: recent },
        ...[
          EBM_SYNC_TYPES.STANDARD_CODES,
          EBM_SYNC_TYPES.ITEM_CLASSES,
          EBM_SYNC_TYPES.TINS,
          EBM_SYNC_TYPES.BRANCHES,
          EBM_SYNC_TYPES.NOTICES,
        ].map((syncType) => ({ branchId: '01', syncType, lastSuccessfulSyncAt: recent })),
      ]),
    });
    const syncSpy = jest.spyOn(EBMCodeSyncService, 'syncAll')
      .mockResolvedValue({ outcome: 'complete', branchId: '00' });
    try {
      const results = await EBMCodeSyncService.syncDueCompanies();
      expect(EBMDevice.find).toHaveBeenCalledWith({
        company: 'tenant-1',
        status: 'initialized',
        initializedMode: 'sandbox',
      });
      expect(EBMSyncState.find).toHaveBeenCalledWith({ company: 'tenant-1', mode: 'sandbox' });
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('tenant-1', {
        branchId: '00',
        syncTypes: [
          EBM_SYNC_TYPES.ITEM_CLASSES,
          EBM_SYNC_TYPES.TINS,
          EBM_SYNC_TYPES.BRANCHES,
          EBM_SYNC_TYPES.NOTICES,
        ],
      });
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({
        company: 'tenant-1',
        branchId: '01',
        skipped: true,
      });
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('keeps the local customer TIN index tenant and branch scoped', async () => {
    const state = { lastReqDt: '20200101000000', lastSuccessfulSyncAt: null, save: jest.fn().mockResolvedValue(undefined) };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    Client.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          taxId: '123456789',
          name: 'Client',
          ebmTinVerification: { status: 'valid', mode: 'sandbox', source: { verificationSource: 'vsdc' } },
        }]),
      }),
    });
    EBMTIN.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    const result = await EBMCodeSyncService.syncType(
      'tenant-1',
      '02',
      EBM_SYNC_TYPES.TINS,
      { tin: '001234567', bhfId: '02' },
    );
    expect(Client.find).toHaveBeenCalledWith({
      company: 'tenant-1',
      taxId: { $regex: /^\d{9}$/ },
      isActive: { $ne: false },
    });
    expect(EBMTIN.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({
      company: 'tenant-1',
      branchId: '02',
      tin: '123456789',
    });
    expect(result).toMatchObject({ success: true, upserted: 1 });
    expect(state.summary).toMatchObject({ upserted: 1, matched: 0, requestId: expect.any(String) });
  });

  it('keeps RRA branch records tenant scoped and rejects another taxpayer response', async () => {
    ebmService.selectBranches.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [{
        tin: '001234567',
        bhfId: '01',
        bhfNm: 'Branch 1',
        bhfSttsCd: '01',
        prvncNm: 'Kigali',
        dstrtNm: 'Gasabo',
        sctrNm: 'Kacyiru',
        locDesc: null,
        mgrNm: 'Manager',
        mgrTelNo: '0789000000',
        mgrEmail: 'manager@example.test',
        hqYn: 'N',
      }] },
    } });
    EBMBranchLookup.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    await EBMCodeSyncService.syncBranches('tenant-1', { tin: '001234567', bhfId: '00' });
    expect(EBMBranchLookup.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({
      company: 'tenant-1',
      tin: '001234567',
      branchId: '01',
      environment: 'sandbox',
    });
    expect(EBMBranchLookup.bulkWrite.mock.calls[0][0][0].updateOne.update.$set).toMatchObject({
      branchName: 'Branch 1',
      statusCode: '01',
      provinceName: 'Kigali',
      districtName: 'Gasabo',
      sectorName: 'Kacyiru',
      locationDescription: null,
      managerName: 'Manager',
      managerPhone: '0789000000',
      managerEmail: 'manager@example.test',
      headOfficeYn: 'N',
      source: expect.objectContaining({ bhfSttsCd: '01', hqYn: 'N', locDesc: null }),
    });

    ebmService.selectBranches.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [{ tin: '999999999', bhfId: '01', bhfNm: 'Foreign branch', useYn: 'Y' }] },
    } });
    await expect(EBMCodeSyncService.syncBranches('tenant-1', {
      tin: '001234567',
      bhfId: '00',
    })).rejects.toMatchObject({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' });
    expect(EBMBranchLookup.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bhfNm', 'N'.repeat(61)],
    ['bhfSttsCd', 'S'.repeat(6)],
    ['prvncNm', 'P'.repeat(101)],
    ['dstrtNm', 'D'.repeat(101)],
    ['sctrNm', 'S'.repeat(101)],
    ['locDesc', 'L'.repeat(101)],
    ['mgrNm', 'M'.repeat(61)],
    ['mgrTelNo', 'T'.repeat(21)],
    ['mgrEmail', 'E'.repeat(101)],
    ['hqYn', 'Y'.repeat(2)],
  ])('rejects branch response field exceeding its PDF maximum: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [{ tin: '001234567', bhfId: '01', [field]: value }] },
    };
    expect(() => EBMCodeSyncService.validateBranchResponse(response, '001234567'))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it.each([
    ['bhfNm', 123],
    ['bhfSttsCd', false],
    ['prvncNm', {}],
    ['dstrtNm', 123],
    ['sctrNm', false],
    ['locDesc', 123],
    ['mgrNm', {}],
    ['mgrTelNo', 123],
    ['mgrEmail', false],
    ['hqYn', 1],
  ])('rejects a non-string branch response field: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [{ tin: '001234567', bhfId: '01', [field]: value }] },
    };
    expect(() => EBMCodeSyncService.validateBranchResponse(response, '001234567'))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it('allows nullable branch location while validating all defined response fields', () => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [{
        tin: '001234567',
        bhfId: '00',
        bhfNm: 'Head office',
        bhfSttsCd: '01',
        prvncNm: 'Kigali City',
        dstrtNm: 'Gasabo',
        sctrNm: 'Kacyiru',
        locDesc: null,
        mgrNm: 'Manager',
        mgrTelNo: '0789000000',
        mgrEmail: 'manager@example.test',
        hqYn: 'Y',
      }] },
    };
    expect(EBMCodeSyncService.validateBranchResponse(response, '001234567')[0])
      .toMatchObject({ bhfSttsCd: '01', locDesc: null, mgrEmail: 'manager@example.test' });
  });

  it('rejects duplicate branch IDs from a single taxpayer response', () => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { bhfList: [
        { tin: '001234567', bhfId: '01' },
        { tin: '001234567', bhfId: '01' },
      ] },
    };
    expect(() => EBMCodeSyncService.validateBranchResponse(response, '001234567'))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it('keeps notice records tenant scoped', async () => {
    ebmService.selectNotices.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [{
        noticeNo: 'N-1',
        title: 'Notice',
        cont: 'Details',
        dtlUrl: 'https://rra.gov.rw/notices/1',
        regDt: '20261013110000',
        regrNm: 'RRA',
      }] },
    } });
    EBMNotice.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    await EBMCodeSyncService.syncNotices('tenant-1', { tin: '001234567', bhfId: '00' });
    expect(EBMNotice.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({
      company: 'tenant-1',
      noticeNumber: 'N-1',
    });
    expect(EBMNotice.bulkWrite.mock.calls[0][0][0].updateOne.update.$set.content).toBe('Details');
  });

  it.each([
    ['title', 'T'.repeat(1001)],
    ['cont', 'C'.repeat(4001)],
    ['dtlUrl', 'https://rra.gov.rw/'.padEnd(201, 'x')],
    ['regrNm', 'R'.repeat(61)],
  ])('rejects notice response field exceeding its PDF maximum: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [{ noticeNo: 42, [field]: value }] },
    };
    expect(() => EBMCodeSyncService.validateNoticeResponse(response))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it.each([
    ['title', 123],
    ['cont', {}],
    ['dtlUrl', false],
    ['regrNm', 42],
  ])('rejects a non-string notice response field: %s', (field, value) => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [{ noticeNo: 42, [field]: value }] },
    };
    expect(() => EBMCodeSyncService.validateNoticeResponse(response))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
  });

  it.each(['20261301120000', '20261013126000', '20261013', 20261013120000])(
    'rejects an invalid notice registration datetime: %s',
    (regDt) => {
      const response = {
        resultCd: '000',
        resultMsg: 'Successful',
        resultDt: '20261013120000',
        data: { noticeList: [{ noticeNo: 42, regDt }] },
      };
      expect(() => EBMCodeSyncService.validateNoticeResponse(response))
        .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
    },
  );

  it('preserves exact string notice identifiers and line breaks, and permits nullable fields', () => {
    const content = 'First line\r\n\r\nSecond line';
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [{
        noticeNo: '00000000000000000001',
        title: null,
        cont: content,
        dtlUrl: null,
        regrNm: null,
        regDt: null,
      }] },
    };
    expect(EBMCodeSyncService.validateNoticeResponse(response)[0]).toMatchObject({
      noticeNo: '00000000000000000001',
      cont: content,
      regDt: null,
    });
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'rejects a notice number that cannot be represented exactly: %s',
    (noticeNo) => {
      const response = {
        resultCd: '000',
        resultMsg: 'Successful',
        resultDt: '20261013120000',
        data: { noticeList: [{ noticeNo }] },
      };
      expect(() => EBMCodeSyncService.validateNoticeResponse(response))
        .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED' }));
    },
  );

  it('rejects unsafe notice URLs for display without dropping the original source record', async () => {
    ebmService.selectNotices.mockResolvedValue({ raw: {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [{
        noticeNo: 43,
        title: 'Unsafe URL',
        cont: 'Text',
        dtlUrl: 'http://localhost:9980/path',
        regDt: '20261013110000',
        regrNm: 'RRA',
      }] },
    } });
    EBMNotice.bulkWrite.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    const result = await EBMCodeSyncService.syncNotices('tenant-1', { tin: '001234567', bhfId: '00' });
    const saved = EBMNotice.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(result.unsafeLinksOmitted).toBe(1);
    expect(saved.detailUrl).toBeNull();
    expect(saved.source.dtlUrl).toBe('http://localhost:9980/path');
  });

  it('accepts empty notice results as success-ready data', () => {
    const response = {
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: { noticeList: [] },
    };
    expect(EBMCodeSyncService.validateNoticeResponse(response)).toEqual([]);
  });
});

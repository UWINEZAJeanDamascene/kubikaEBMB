#!/usr/bin/env node
/* eslint-disable no-console */
process.env.EBM_MODE = process.env.EBM_MODE || 'mock';

const EBMDeviceService = require('../services/ebmDeviceService');
const EBMBranchService = require('../services/ebmBranchService');
const EBMDevice = require('../models/EBMDevice');

EBMDeviceService.ensureInitialized = async () => ({ tin: '999991130', branchId: '00' });
EBMBranchService.ensureBranchRegistered = async () => {};
EBMDevice.findOneAndUpdate = async () => null;

const ebmService = require('../services/ebmService');
const { VSDC_ENDPOINTS, isRetryableResultCode } = require('../services/ebmService');
const { sanitizeForEndpoint, extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const EBMItemClass = require('../models/EBMItemClass');
const EBMCode = require('../models/EBMCode');
const Company = require('../models/Company');
const sequenceService = require('../services/sequenceService');
const EBMSyncState = require('../models/EBMSyncState');
const transactionService = require('../services/transactionService');

// Isolate product registration from persistent data while still running the
// production service and mock VSDC transport end to end.
const mockProduct = {
  _id: 'mock-e2e-product',
  company: 'mock-e2e-company',
  name: 'Mock Registered Product',
  sku: 'MOCK-001',
  sellingPrice: 1180,
  isActive: true,
  ebm: {
    itemClassCd: '5059690800',
    taxTyCd: 'B',
    pkgUnitCd: 'NT',
    qtyUnitCd: 'U',
    itemTyCd: '2',
    orgnNatCd: 'RW',
    itemStdNm: 'Mock Registered Product',
    isrcAplcbYn: 'N',
  },
  async save() { return this; },
};
Product.findOne = async () => mockProduct;
Product.exists = async () => false;
Warehouse.findOne = () => ({ lean: async () => ({ _id: 'mock-e2e-warehouse', rraBranchId: '00' }) });
EBMItemClass.exists = async () => true;
EBMCode.countDocuments = async () => 1;
EBMCode.exists = async () => true;
Company.findById = () => ({ lean: async () => ({ _id: 'mock-e2e-company', tax_identification_number: '999991130' }) });
sequenceService.nextGlobalSequence = async () => '0000001';

// Run the real item-sync service against the mock VSDC transport and an
// in-memory transaction adapter. This exercises request -> response
// validation -> scoped persistence -> cursor behavior without a live database.
const mockItemRows = new Map();
const mockSyncState = { lastReqDt: '20000101000000' };
EBMDevice.findOne = () => ({ lean: async () => ({ tin: '999991130' }) });
EBMSyncState.findOneAndUpdate = async () => mockSyncState;
Product.find = () => ({
  select: () => ({ lean: async () => [] }),
});
transactionService.runInPrismaTransaction = async (operation) => operation({
  ebmSyncState: {
    updateMany: async ({ where, data }) => {
      if (where.lastReqDt !== mockSyncState.lastReqDt) return { count: 0 };
      Object.assign(mockSyncState, data);
      return { count: 1 };
    },
  },
  ebmRegisteredItem: {
    upsert: async ({ where, create, update }) => {
      const key = JSON.stringify(where.scopeItemKey);
      mockItemRows.set(key, { ...(mockItemRows.get(key) || create), ...update });
    },
  },
});
const EBMItemSyncService = require('../services/ebmItemSyncService');

const BASE = {
  companyId: 'mock-e2e-company',
  tin: '999991130',
  bhfId: '00',
  lastReqDt: '20000101000000',
};

async function runStep(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  console.log('ok');
}

async function main() {
  console.log(`EBM mock E2E runner (mode=${ebmService.getConfig().mode})`);

  await runStep('initialize device', async () => {
    const response = await ebmService.initializeDevice({
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      dvcSrlNo: 'dvc99999113000',
    });
    if (response.resultCd !== '000') throw new Error(`init failed: ${response.resultMsg}`);
  });

  await runStep('sync codes', async () => {
    const response = await ebmService.selectCodes({ ...BASE });
    if (!response.data?.clsList?.length) throw new Error('code sync returned no classes');
  });

  await runStep('select sales summaries', async () => {
    const response = await ebmService.selectSales({ ...BASE });
    if (!Array.isArray(response.data?.saleList)) throw new Error('sales summary missing saleList');
  });

  await runStep('select registered items', async () => {
    const response = await ebmService.selectItems({ ...BASE });
    if (!Array.isArray(response.data?.itemList)) throw new Error('selectItems missing itemList');
  });

  await runStep('sync and persist registered items through the real mock item-sync service', async () => {
    const requests = [];
    const selectItems = ebmService.selectItems.bind(ebmService);
    ebmService.selectItems = async (payload) => {
      requests.push({ ...payload });
      return selectItems(payload);
    };
    try {
      const first = await EBMItemSyncService.syncRegisteredItems(BASE.companyId, { branchId: BASE.bhfId });
      const second = await EBMItemSyncService.syncRegisteredItems(BASE.companyId, { branchId: BASE.bhfId });
      if (first.summary.cursorPolicy !== 'mock_simulated_incremental') throw new Error('mock cursor policy was not identified');
      if (first.summary.pulled !== 2 || second.summary.pulled !== 2) throw new Error('mock item rows were not fully returned');
      if (requests.length !== 2 || requests[1].lastReqDt !== first.lastReqDt) throw new Error('second request did not use the first mock result cursor');
      if (mockItemRows.size !== 2) throw new Error(`expected two idempotently upserted mock items, got ${mockItemRows.size}`);
    } finally {
      ebmService.selectItems = selectItems;
    }
  });

  await runStep('select stock items', async () => {
    const response = await ebmService.selectStockItems({ ...BASE });
    if (!Array.isArray(response.data?.itemList)) throw new Error('stock select missing itemList');
  });

  await runStep('register a product through the real item-save service and mock VSDC transport', async () => {
    const EBMProductService = require('../services/ebmProductService');
    const requests = [];
    const saveItems = ebmService.saveItems.bind(ebmService);
    ebmService.saveItems = async (payload) => {
      requests.push({ ...payload });
      return saveItems(payload);
    };
    try {
      const registered = await EBMProductService.registerProduct(BASE.companyId, mockProduct._id, {
        tin: BASE.tin,
        companyName: 'Mock Test Company',
      });
      if (requests.length !== 1) throw new Error(`expected one item-save request, got ${requests.length}`);
      if (requests[0].tin !== BASE.tin || requests[0].bhfId !== BASE.bhfId) throw new Error('item-save request used the wrong taxpayer or branch');
      if (requests[0].itemCd !== 'RW2NTU0000001' || requests[0].itemClsCd !== '5059690800') throw new Error('item-save payload did not preserve the generated item code and classification');
      if (registered.ebm.ebmRegistrationStatus !== 'registered' || registered.ebm.isRegisteredWithEBM !== true) throw new Error('local product was not marked registered after mock acceptance');
      if (registered.ebm.ebmRegistrationMode !== 'mock') throw new Error('mock acceptance was not recorded with its environment');
      if (registered.ebm.ebmItemCode !== requests[0].itemCd || registered.ebm.ebmRegistrationAttemptItemCode) throw new Error('local registered item code state is inconsistent');
    } finally {
      ebmService.saveItems = saveItems;
    }
  });

  await runStep('save sales with sanitized payload', async () => {
    const rawPayload = {
      companyId: BASE.companyId,
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      invcNo: 1001,
      orgInvcNo: 0,
      salesTyCd: 'N',
      rcptTyCd: 'S',
      pmtTyCd: '01',
      salesSttsCd: '02',
      cfmDt: '20260604120000',
      salesDt: '20260604',
      prchrAcptcYn: 'N',
      taxblAmtA: '0.00',
      taxblAmtB: '1000.00',
      taxblAmtC: '0.00',
      taxblAmtD: '0.00',
      taxRtA: '0.00',
      taxRtB: '18.00',
      taxRtC: '0.00',
      taxRtD: '0.00',
      taxAmtA: '0.00',
      taxAmtB: '180.00',
      taxAmtC: '0.00',
      taxAmtD: '0.00',
      totItemCnt: 1,
      totTaxblAmt: '1000.00',
      totTaxAmt: '180.00',
      totAmt: '1180.00',
      itemList: [{
        itemSeq: 1,
        itemCd: 'RW1MOCK000000001',
        itemClsCd: '5059690800',
        itemNm: 'Mock item',
        pkgUnitCd: 'NT',
        pkg: '1.00',
        qtyUnitCd: 'U',
        qty: '1.00',
        prc: '1180.00',
        splyAmt: '1000.00',
        dcRt: '0.00',
        dcAmt: '0.00',
        taxTyCd: 'B',
        taxblAmt: '1000.00',
        totTaxAmt: '180.00',
        totAmt: '1180.00',
      }],
      receipt: {
        rptNo: 1,
        prchrAcptcYn: 'N',
      },
      regrId: 'system',
      regrNm: 'System',
      modrId: 'system',
      modrNm: 'System',
    };

    const wirePayload = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, rawPayload);
    if (wirePayload.companyId) throw new Error('companyId was not stripped');
    const response = await ebmService.saveSales(rawPayload);
    const fiscal = extractSaveSalesFiscalData(response);
    if (!fiscal.rcptSign || !fiscal.intrlData) throw new Error('missing fiscal signature data');
  });

  if (!isRetryableResultCode('005')) throw new Error('005 should be retryable');
  if (isRetryableResultCode('884')) throw new Error('884 should not be retryable');

  console.log('All mock E2E checks passed.');
}

main().catch((error) => {
  console.error('\nEBM mock E2E failed:', error.message);
  process.exit(1);
});

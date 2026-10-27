jest.mock('../models/EBMCode', () => ({
  findOne: jest.fn(({ code }) => ({ lean: jest.fn(async () => ({ code })) })),
  find: jest.fn((query) => {
    const classId = String(query?.codeClass || '');
    const active = (row) => ({ ...row, active: true, useYn: 'Y', codeClassUseYn: 'Y' });
    const codeByClass = {
      '04': [
        active({ code: 'A', name: 'A-EX', description: 'A-EX' }),
        active({ code: 'B', name: 'B-18.00%', description: 'B-18.00%' }),
        active({ code: 'C', name: 'C', description: 'C' }),
        active({ code: 'D', name: 'D', description: 'D' }),
      ],
      '07': [
        active({ code: '01', name: 'CASH', description: 'CASH' }),
        active({ code: '02', name: 'CREDIT', description: 'CREDIT' }),
        active({ code: '03', name: 'CASH/CREDIT', description: 'CASH/CREDIT' }),
        active({ code: '04', name: 'BANK CHECK', description: 'BANK CHECK PAYMENT' }),
        active({ code: '05', name: 'DEBIT&CREDIT CARD', description: 'PAYMENT USING CARD' }),
        active({ code: '06', name: 'MOBILE MONEY', description: 'ANY TRANSACTION USING MOBILE MONEY SYSTEM' }),
        active({ code: '07', name: 'OTHER', description: 'OTHER MEANS OF PAYMENT' }),
      ],
      '37': [
        active({ code: 'S', name: 'Sale', description: 'Sale' }),
        active({ code: 'R', name: 'Refund after Sale', description: 'Refund after Sale' }),
      ],
      '14': [
        active({ code: 'C', name: 'Copy', description: 'Sales and purchase type : Copy' }),
        active({ code: 'N', name: 'Normal', description: 'Sales and purchase type : Normal' }),
        active({ code: 'P', name: 'Proforma', description: 'Sales and purchase type : Proforma' }),
        active({ code: 'T', name: 'Training', description: 'Sales and purchase type : Training' }),
      ],
      '11': [
        active({ code: '01', name: 'Wait for Approval', description: 'Wait for Approval' }),
        active({ code: '02', name: 'Approved', description: 'Approved' }),
        active({ code: '03', name: 'Cancel Requested', description: 'Cancel Requested' }),
        active({ code: '04', name: 'Canceled', description: 'Canceled' }),
        active({ code: '05', name: 'Refunded', description: 'Refunded' }),
        active({ code: '06', name: 'Transferred', description: 'Transferred' }),
      ],
      '32': [
        active({ code: '01', name: 'Missing Quantity', description: 'Missing Quantity' }),
        active({ code: '02', name: 'Missing Item', description: 'Missing Item' }),
        active({ code: '03', name: 'Damaged', description: 'Damaged' }),
        active({ code: '04', name: 'Wasted', description: 'Wasted' }),
        active({ code: '05', name: 'Raw Material Shortage', description: 'Raw Material Shortage' }),
        active({ code: '06', name: 'Refund', description: 'Refund' }),
        active({ code: '07', name: 'Wrong Customer TIN', description: 'Wrong Customer TIN' }),
        active({ code: '08', name: 'Wrong Customer name', description: 'Wrong Customer name' }),
        active({ code: '09', name: 'Wrong Amount/price', description: 'Wrong Amount/price' }),
        active({ code: '10', name: 'Wrong Quantity', description: 'Wrong Quantity' }),
        active({ code: '11', name: 'Wrong Item(s)', description: 'Wrong Item(s)' }),
        active({ code: '12', name: 'Wrong tax type', description: 'Wrong tax type' }),
        active({ code: '13', name: 'Other reason', description: 'Other reason' }),
      ],
    };
    const result = codeByClass[classId] || [];

    return {
      sort: jest.fn(() => ({ lean: jest.fn(async () => result) })),
    };
  }),
}));

jest.mock('../services/taxAutomationService', () => ({
  getActiveTaxRate: jest.fn(async (_companyId, { code }) => ({ ratePct: code === 'B' ? '18.00' : '0.00' })),
}));

const { buildSalesTrnPayload } = require('../services/ebmSalesService');
const EBMSalesService = require('../services/ebmSalesService');
const ebmService = require('../services/ebmService');
const EBMCode = require('../models/EBMCode');
const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const EBMQueueService = require('../services/ebmQueueService');
const EBMFiscalSequenceService = require('../services/ebmFiscalSequenceService');
const EBMTinService = require('../services/ebmCustomerTinService');
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');

describe('RRA refund reason code selection', () => {
  it('uses only active synchronized classification 32 codes and preserves the selected two-digit code', async () => {
    await expect(EBMSalesService.__test__.resolveRefundReasonCode('company-1', '03')).resolves.toBe('03');
    expect(EBMCode.find).toHaveBeenCalledWith({ company: 'company-1', active: true, codeClass: '32' });
  });

  it('rejects a code that is not in the synchronized RRA refund-reason class', async () => {
    await expect(EBMSalesService.__test__.resolveRefundReasonCode('company-1', '99'))
      .rejects.toMatchObject({ code: 'EBM_REFUND_REASON_CODE_UNKNOWN' });
  });
});

const BASE_LINE = {
  qty: '2.00',
  unitPrice: '10.25',
  lineSubtotal: '18.45',
  lineTax: '3.32',
  lineTotal: '21.77',
  taxRate: '18.00',
  pkg: '2.00',
  product: {
    name: 'Test Item',
    sku: 'LOCAL-SKU-001',
    barcode: '1234567890123',
    ebm: {
      ebmItemCode: 'RWIN000000001',
      itemClassCd: '50202200',
      taxTyCd: 'B',
      pkgUnitCd: 'NT',
      qtyUnitCd: 'U',
    },
  },
};

function makeInvoice(overrides = {}) {
  const lines = overrides.lines || [{ ...BASE_LINE, ...(overrides.line || {}) }];
  const taxAmount = overrides.taxAmount ?? lines.reduce((sum, line) => sum + Number(line.lineTax), 0).toFixed(2);
  const totalAmount = overrides.totalAmount ?? lines.reduce((sum, line) => sum + Number(line.lineTotal), 0).toFixed(2);
  return {
    company: 'company-1',
    invoiceDate: new Date('2026-06-04T10:00:00Z'),
    confirmedAt: new Date('2026-06-04T10:02:00Z'),
    currencyCode: 'RWF',
    taxAmount,
    totalAmount,
    ebm: {
      invcNo: 1001,
      curRcptNo: 2001,
      totRcptNo: 2001,
      rptNo: 3001,
      prchrAcptcYn: 'N',
    },
    lines,
    ...overrides,
  };
}

const COMPANY = {
  _id: 'company-1',
  tax_identification_number: '999991130',
  ebm: { trdeNm: 'Test Trade' },
};
const BRANCH = { rraBranchId: '00' };
const ACTORS = {
  regr: { name: 'Registrar', id: 'registrar@example.rw' },
  modr: { name: 'Cashier', id: 'cashier@example.rw' },
};

async function build(invoice, options = {}) {
  return buildSalesTrnPayload(invoice, COMPANY, BRANCH, { auditActors: ACTORS, ...options });
}

describe('EBM sales item rows', () => {
  it('rejects an inactive cached tax code before sequence allocation, customer lookup, or queue creation', async () => {
    const invoice = makeInvoice({
      _id: 'invoice-preflight',
      referenceNo: 'INV-PREFLIGHT',
      status: 'confirmed',
      client: { type: 'individual' },
      createdBy: { name: 'Registrar', email: 'registrar@example.rw' },
      ebm: { prchrAcptcYn: 'N' },
    });
    const originalCodeLookup = EBMCode.find.getMockImplementation();
    EBMCode.find.mockImplementation((query) => query?.codeClass === '04'
      ? { sort: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) }
      : originalCodeLookup(query));
    const findQuery = {
      populate: jest.fn().mockReturnThis(),
      then: (resolve) => resolve(invoice),
    };
    const invoiceFind = jest.spyOn(Invoice, 'findOne').mockReturnValue(findQuery);
    const companyFind = jest.spyOn(Company, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(COMPANY),
    });
    const warehouseFind = jest.spyOn(Warehouse, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(BRANCH),
    });
    const enabled = jest.spyOn(EBMQueueService, 'assertEbmEnabled').mockResolvedValue(true);
    const allocate = jest.spyOn(EBMFiscalSequenceService, 'ensureSalesNumbers').mockResolvedValue({});
    const verifyTin = jest.spyOn(EBMTinService, 'verifyInvoiceCustomerTin').mockResolvedValue({});
    const beginQueue = jest.spyOn(EBMQueueService, 'beginOperation');
    const saveSale = jest.spyOn(ebmService, 'saveSales');

    try {
      await expect(EBMSalesService.submitInvoice(invoice._id, { companyId: COMPANY._id, branchId: '00' }))
        .rejects.toMatchObject({ code: 'EBM_PRODUCT_TAX_CODE_INVALID', dispatched: false });
      expect(allocate).not.toHaveBeenCalled();
      expect(invoice.save).toBeUndefined();
      expect(verifyTin).not.toHaveBeenCalled();
      expect(beginQueue).not.toHaveBeenCalled();
      expect(saveSale).not.toHaveBeenCalled();
      expect(enabled).toHaveBeenCalled();
      expect(warehouseFind).toHaveBeenCalled();
    } finally {
      invoiceFind.mockRestore();
      EBMCode.find.mockImplementation(originalCodeLookup);
      companyFind.mockRestore();
      warehouseFind.mockRestore();
      enabled.mockRestore();
      allocate.mockRestore();
      verifyTin.mockRestore();
      beginQueue.mockRestore();
      saveSale.mockRestore();
    }
  });

  it('keeps RWF fiscal amounts independent of local exchange-rate settings', async () => {
    const invoice = makeInvoice({ currencyCode: 'RWF', exchangeRate: '987.654321' });
    const payload = await build(invoice);
    const dto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, payload);

    expect(dto.totAmt).toBe('21.77');
    expect(dto.itemList[0].totAmt).toBe('21.77');
    expect(dto).not.toHaveProperty('currencyCode');
    expect(dto).not.toHaveProperty('exchangeRate');
  });

  it('blocks foreign-currency fiscalization even when a local exchange rate is available', async () => {
    EBMCode.findOne.mockClear();
    const invoice = makeInvoice({ currencyCode: 'USD', exchangeRate: '1450.000000' });

    await expect(build(invoice)).rejects.toMatchObject({
      code: 'EBM_SALES_CURRENCY_UNSUPPORTED',
      dispatched: false,
    });
    expect(EBMCode.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['cash', '01'],
    ['credit', '02'],
    ['cash_credit', '03'],
    ['cheque', '04'],
    ['card', '05'],
    ['mobile_money', '06'],
    ['bank_transfer', '07'],
    ['gift_card', '07'],
    ['store_credit', '07'],
    ['loyalty', '07'],
    ['other', '07'],
  ])('maps the saved local tender %s to RRA class 07 code %s', async (paymentMethod, expectedCode) => {
    const payload = await build(makeInvoice({ payments: [{ amount: '21.77', paymentMethod }] }));
    expect(payload.pmtTyCd).toBe(expectedCode);
    expect(typeof payload.pmtTyCd).toBe('string');
  });

  it('omits the optional payment code for an unpaid sale without inventing credit', async () => {
    const payload = await build(makeInvoice({ paymentMethod: 'credit', amountPaid: 0, payments: [] }));
    expect(payload.pmtTyCd).toBeUndefined();
    expect(sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, payload)).not.toHaveProperty('pmtTyCd');
  });

  it('keeps local tender evidence unchanged and serializes the RRA code as a leading-zero string', async () => {
    const payments = [{ amount: '21.77', paymentMethod: 'cash', reference: 'LOCAL-REF-1' }];
    const invoice = makeInvoice({ payments });
    const payload = await build(invoice);
    const dto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, payload);

    expect(invoice.payments).toEqual(payments);
    expect(dto.pmtTyCd).toBe('01');
    expect(JSON.parse(JSON.stringify(dto)).pmtTyCd).toBe('01');
  });

  it('rejects unknown and mixed tenders rather than falling back to cash or selecting one', async () => {
    await expect(build(makeInvoice({ payments: [{ amount: '21.77', paymentMethod: 'crypto' }] })))
      .rejects.toMatchObject({ code: 'EBM_SALES_PAYMENT_METHOD_UNSUPPORTED', dispatched: false });
    await expect(build(makeInvoice({ payments: [{ amount: '10', paymentMethod: 'cash' }, { amount: '11.77', paymentMethod: 'mobile_money' }] })))
      .rejects.toMatchObject({ code: 'EBM_SPLIT_TENDER_MAPPING_UNCONFIRMED', dispatched: false });
    await expect(build(makeInvoice({ status: 'partially_paid', payments: [{ amount: '10', paymentMethod: 'cash' }] })))
      .rejects.toMatchObject({ code: 'EBM_SALES_PARTIAL_PAYMENT_UNCONFIRMED', dispatched: false });
  });

  it('only submits normal sales as N/S and uses R only for refund-after-sale', async () => {
    const normal = await build(makeInvoice());
    expect(normal).toMatchObject({ salesTyCd: 'N', rcptTyCd: 'S' });
    const refund = await build(makeInvoice({ isDebitNote: true }), { refundAfterSale: true });
    expect(refund).toMatchObject({ salesTyCd: 'N', rcptTyCd: 'R' });
    await expect(build(makeInvoice({ ebm: { ...makeInvoice().ebm, salesTyCd: 'C' } })))
      .rejects.toMatchObject({ code: 'EBM_SALES_TYPE_CODE_INVALID', dispatched: false });
    await expect(build(makeInvoice({ isProforma: true })))
      .rejects.toMatchObject({ code: 'EBM_SALES_TRANSACTION_TYPE_UNSUPPORTED', dispatched: false });
    await expect(build(makeInvoice({ isTraining: true })))
      .rejects.toMatchObject({ code: 'EBM_SALES_TRANSACTION_TYPE_UNSUPPORTED', dispatched: false });
    await expect(build(makeInvoice({ isCopy: true })))
      .rejects.toMatchObject({ code: 'EBM_SALES_TRANSACTION_TYPE_UNSUPPORTED', dispatched: false });
    await expect(build(makeInvoice({ isDebitNote: true })))
      .rejects.toMatchObject({ code: 'EBM_SALES_TRANSACTION_TYPE_UNSUPPORTED', dispatched: false });
    await expect(build(makeInvoice({ ebm: { ...makeInvoice().ebm, rcptTyCd: 'R' } })))
      .rejects.toMatchObject({ code: 'EBM_SALES_RECEIPT_TYPE_UNSUPPORTED', dispatched: false });
  });

  it('aggregates decimal line amounts into header tax buckets and rejects header mismatches', async () => {
    const payload = await build(makeInvoice());
    expect(payload).toMatchObject({
      taxblAmtB: '18.45',
      taxAmtB: '3.32',
      totTaxblAmt: '18.45',
      totTaxAmt: '3.32',
      totAmt: '21.77',
    });

    await expect(build(makeInvoice({ taxAmount: '3.30' })))
      .rejects.toMatchObject({ code: 'EBM_SALES_HEADER_TAX_MISMATCH' });
    await expect(build(makeInvoice({ totalAmount: '21.75' })))
      .rejects.toMatchObject({ code: 'EBM_SALES_HEADER_TOTAL_MISMATCH' });

    const mixedBuckets = await build(makeInvoice({
      lines: [
        { ...BASE_LINE },
        { ...BASE_LINE, qty: '1.00', unitPrice: '5.00', lineSubtotal: '5.00', lineTax: '0.00',
          lineTotal: '5.00', taxRate: '0.00', pkg: '1.00',
          product: { ...BASE_LINE.product, ebm: { ...BASE_LINE.product.ebm, taxTyCd: 'A' } } },
      ],
      taxAmount: '3.32', totalAmount: '26.77',
    }));
    expect(mixedBuckets).toMatchObject({
      taxblAmtA: '5.00', taxblAmtB: '18.45', totTaxblAmt: '23.45', totTaxAmt: '3.32', totAmt: '26.77',
    });
  });

  it('maps saved item identifiers, units, package, quantity, discounts and tax without using the local SKU', async () => {
    const payload = await build(makeInvoice());
    const row = payload.itemList[0];

    expect(row).toMatchObject({
      itemSeq: 1,
      itemCd: 'RWIN000000001',
      itemClsCd: '50202200',
      itemNm: 'Test Item',
      bcd: '1234567890123',
      pkgUnitCd: 'NT',
      pkg: '2.00',
      qtyUnitCd: 'U',
      qty: '2.00',
      prc: '10.25',
      splyAmt: '20.50',
      dcRt: '10.00',
      dcAmt: '2.05',
      taxTyCd: 'B',
      taxblAmt: '18.45',
      totTaxAmt: '3.32',
      totAmt: '21.77',
    });
    expect(row.itemCd).not.toBe('LOCAL-SKU-001');
    expect(row).not.toHaveProperty('isrccCd');
    expect(row).not.toHaveProperty('isrcAmt');
    expect(payload.receipt).toMatchObject({ rptNo: 3001, prchrAcptcYn: 'N' });
    expect(payload.receipt).not.toHaveProperty('curRcptNo');
    expect(payload.receipt).not.toHaveProperty('totRcptNo');
    expect(payload.receipt).not.toHaveProperty('rcptPbctDt');
    expect(payload.receipt).not.toHaveProperty('totItemCnt');
  });

  it('preserves CHAR identifiers and fixed-scale sales quantity and amount strings', async () => {
    const payload = await build(makeInvoice());
    const wireDto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, payload);
    const serialized = JSON.stringify(wireDto);

    expect(wireDto.itemList[0].itemCd).toBe('RWIN000000001');
    expect(serialized).toContain('"qty":"2.00"');
    expect(serialized).toContain('"splyAmt":"20.50"');
    expect(serialized).toContain('"totAmt":"21.77"');
  });

  it('omits absent optional barcode and insurance fields and accepts explicit null optionals at the DTO boundary', async () => {
    const payload = await build(makeInvoice({
      line: { product: { ...BASE_LINE.product, barcode: null } },
    }));
    expect(payload.itemList[0]).not.toHaveProperty('bcd');

    const withNulls = {
      ...payload,
      itemList: [{ ...payload.itemList[0], bcd: null, isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null }],
    };
    const sanitized = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, withNulls);
    expect(sanitized.itemList[0]).toMatchObject({ bcd: null, isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null });
  });

  it('accepts zero-price rows while requiring a positive sale quantity and package quantity', async () => {
    const zeroPrice = makeInvoice({
      line: {
        qty: '1.00', unitPrice: '0.00', lineSubtotal: '0.00', lineTax: '0.00',
        lineTotal: '0.00', taxRate: '0.00', pkg: '1.00',
        product: { ...BASE_LINE.product, ebm: { ...BASE_LINE.product.ebm, taxTyCd: 'A' } },
      },
      taxAmount: '0.00', totalAmount: '0.00',
    });
    const payload = await build(zeroPrice);
    expect(payload.itemList[0]).toMatchObject({ splyAmt: '0.00', dcAmt: '0.00', taxblAmt: '0.00', totTaxAmt: '0.00', totAmt: '0.00' });

    await expect(build(makeInvoice({ line: { qty: '0.00' } }))).rejects.toMatchObject({ code: 'EBM_SALES_ITEM_QUANTITY_INVALID' });
    await expect(build(makeInvoice({ line: { pkg: '0.00' } }))).rejects.toMatchObject({ code: 'EBM_SALES_PACKAGE_QUANTITY_INVALID' });
  });

  it('accepts NUMBER(13,2) quantity boundaries and rejects values beyond precision or scale', async () => {
    const maximumQty = '99999999999.99';
    const boundary = makeInvoice({
      line: { qty: maximumQty, unitPrice: '1.00', lineSubtotal: maximumQty, lineTax: '0.00', lineTotal: maximumQty, taxRate: '0.00', pkg: maximumQty,
        product: { ...BASE_LINE.product, ebm: { ...BASE_LINE.product.ebm, taxTyCd: 'A' } } },
      taxAmount: '0.00', totalAmount: maximumQty,
    });
    const boundaryDto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, await build(boundary));
    expect(boundaryDto.itemList[0].qty).toBe(maximumQty);

    const tooLarge = makeInvoice({ line: { qty: '100000000000.00', pkg: '1.00' } });
    const tooLargePayload = await build(tooLarge);
    expect(() => sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, tooLargePayload)).toThrow();
    await expect(build(makeInvoice({ line: { qty: '1.001' } }))).rejects.toMatchObject({ code: 'EBM_SALES_DECIMAL_SCALE_INVALID' });
  });

  it('rejects invented local SKUs, missing package data, invalid codes, and unreconciled line amounts', async () => {
    const noRraCode = makeInvoice({ line: { product: { ...BASE_LINE.product, ebm: { ...BASE_LINE.product.ebm, ebmItemCode: null } } } });
    await expect(build(noRraCode)).rejects.toMatchObject({ code: 'EBM_PRODUCT_CODES_MISSING' });
    await expect(build(makeInvoice({ line: { pkg: undefined } }))).rejects.toMatchObject({ code: 'EBM_SALES_PACKAGE_QUANTITY_REQUIRED' });
    const invalidUnit = makeInvoice({
      line: {
        product: {
          ...BASE_LINE.product,
          ebm: { ...BASE_LINE.product.ebm, qtyUnitCd: 'TOO-LONG' },
        },
      },
    });
    await expect(build(invalidUnit)).rejects.toMatchObject({ code: 'EBM_SALES_ITEM_CODE_INVALID' });
    const longItemCode = makeInvoice({
      line: {
        product: {
          ...BASE_LINE.product,
          ebm: { ...BASE_LINE.product.ebm, ebmItemCode: 'X'.repeat(21) },
        },
      },
    });
    await expect(build(longItemCode)).rejects.toMatchObject({ code: 'EBM_SALES_ITEM_CODE_INVALID' });
    await expect(build(makeInvoice({ line: { productName: 'N'.repeat(201) } }))).rejects.toMatchObject({ code: 'EBM_SALES_ITEM_NAME_INVALID' });
    await expect(build(makeInvoice({ line: { isrcRt: '20.5' } }))).rejects.toMatchObject({ code: 'EBM_SALES_DECIMAL_SCALE_INVALID' });
    await expect(build(makeInvoice({ line: { lineTax: '3.31', lineTotal: '21.76' } }))).rejects.toMatchObject({ code: 'EBM_SALES_LINE_TAX_MISMATCH' });
    await expect(build(makeInvoice({ line: { lineTotal: '21.76' } }))).rejects.toMatchObject({ code: 'EBM_SALES_LINE_TOTAL_MISMATCH' });
  });

  it('enforces the three-digit sequential row boundary and reconciles the row count', async () => {
    const maxRows = Array.from({ length: 999 }, () => ({ ...BASE_LINE }));
    const maxRowsDto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, await build(makeInvoice({ lines: maxRows })));
    expect(maxRowsDto.totItemCnt).toBe('999');
    expect(maxRowsDto.itemList[998].itemSeq).toBe('999');

    const rows = Array.from({ length: 1000 }, () => ({ ...BASE_LINE }));
    await expect(build(makeInvoice({ lines: rows }))).rejects.toMatchObject({ code: 'EBM_SALES_ITEM_COUNT_EXCEEDED' });

    const payload = await build(makeInvoice());
    expect(payload.totItemCnt).toBe(payload.itemList.length);
    expect(payload.itemList.map((row) => row.itemSeq)).toEqual([1]);
  });

  it('rejects receipt fields absent from the specification sample and rejects conflicting duplicates', async () => {
    const payload = await build(makeInvoice());
    const withUnlistedCounter = {
      ...payload,
      receipt: { ...payload.receipt, curRcptNo: 2001 },
    };
    expect(() => sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, withUnlistedCounter)).toThrow(/curRcptNo is not an allowed request field/);

    const customerTinMismatch = {
      ...payload,
      custTin: '999991111',
      receipt: { ...payload.receipt, custTin: '999992222' },
    };
    expect(() => sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, customerTinMismatch)).toThrow(/customer TIN values conflict/);

    const acceptanceMismatch = {
      ...payload,
      receipt: { ...payload.receipt, prchrAcptcYn: 'Y' },
    };
    expect(() => sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, acceptanceMismatch)).toThrow(/prchrAcptcYn values must match/);
  });
});

  it('preserves selected unit codes separately from package and sale quantities through JSON serialization', async () => {
    const invoice = makeInvoice({
      line: {
        product: {
          ...BASE_LINE.product,
          ebm: { ...BASE_LINE.product.ebm, pkgUnitCd: 'CTN', qtyUnitCd: '4B' },
        },
      },
    });
    const payload = await build(invoice);
    const dto = sanitizeForEndpoint(ebmService.VSDC_ENDPOINTS.SAVE_SALES, payload);
    const row = JSON.parse(JSON.stringify(dto)).itemList[0];

    expect(row).toMatchObject({ pkgUnitCd: 'CTN', pkg: '2.00', qtyUnitCd: '4B', qty: '2.00' });
    expect(typeof row.pkgUnitCd).toBe('string');
    expect(typeof row.qtyUnitCd).toBe('string');
  });

  it('rejects conflicting saved sales-line unit codes instead of inferring a conversion', async () => {
    await expect(build(makeInvoice({ line: { qtyUnitCd: 'KG' } })))
      .rejects.toMatchObject({ code: 'EBM_SALES_ITEM_UNIT_SOURCE_CONFLICT', dispatched: false });
  });

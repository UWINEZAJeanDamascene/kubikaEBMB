jest.mock('../models/Product', () => ({
  findOne: jest.fn(),
  exists: jest.fn(),
}));

jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/EBMItemClass', () => ({
  exists: jest.fn(async () => true),
}));

jest.mock('../models/EBMCode', () => ({
  exists: jest.fn(async () => true),
  countDocuments: jest.fn(async () => 1),
}));

jest.mock('../models/Company', () => ({
  findById: jest.fn(),
}));

jest.mock('../services/sequenceService', () => ({
  nextGlobalSequence: jest.fn(async () => '0000001'),
}));

jest.mock('../services/ebmRegisteredItemService', () => ({
  registeredItemCodeExists: jest.fn(async () => false),
}));

jest.mock('../services/ebmBranchService', () => ({
  ensureBranchRegistered: jest.fn(async () => true),
}));

jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  saveItems: jest.fn(async () => ({
    ok: true,
    resultCd: '000',
    data: null,
    raw: { resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261015120000', data: null },
  })),
}));

const Product = require('../models/Product');
const EBMItemClass = require('../models/EBMItemClass');
const EBMCode = require('../models/EBMCode');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const EBMBranchService = require('../services/ebmBranchService');
const ebmService = require('../services/ebmService');
const EBMProductService = require('../services/ebmProductService');
const { nextGlobalSequence } = require('../services/sequenceService');
const { registeredItemCodeExists } = require('../services/ebmRegisteredItemService');

function baseProduct(overrides = {}) {
  return {
    _id: 'product-1',
    company: 'company-1',
    name: 'Premium Rice 25kg',
    sku: 'RICE-25',
    barcode: '1234567890123',
    description: 'Long grain rice for wholesale',
    sellingPrice: 25000,
    lowStockThreshold: 12,
    isActive: true,
    defaultWarehouse: 'warehouse-1',
    taxCode: 'B',
    ebm: {
      itemClassCd: '5022110100',
      taxTyCd: 'B',
      pkgUnitCd: 'BG',
      qtyUnitCd: 'KG',
      itemTyCd: '2',
      orgnNatCd: 'RW',
      itemStdNm: 'Rice 25kg bag',
      btchNo: 'B26',
      addInfo: 'FIFO',
      sftyQty: 15,
      isrcAplcbYn: 'N',
    },
    save: jest.fn(async function save() {
      return this;
    }),
    ...overrides,
  };
}

describe('EBM product registration payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registeredItemCodeExists.mockResolvedValue(false);
    EBMItemClass.exists.mockResolvedValue(true);
    EBMCode.exists.mockResolvedValue(true);
    EBMCode.countDocuments.mockResolvedValue(1);
    Company.findById.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'company-1', tax_identification_number: '999991130' })),
    });
    Product.exists.mockResolvedValue(false);
  });

  it('maps product data into the exact save DTO without truncation or fabricated optional prices', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1', {
      tin: '999991130',
      companyName: 'Test Company',
    });

    expect(ebmService.saveItems).toHaveBeenCalledWith(
      expect.objectContaining({
        tin: '999991130',
        bhfId: '00',
        itemCd: 'RW2BGKG0000001',
        itemClsCd: '5022110100',
        itemTyCd: '2',
        itemNm: 'Premium Rice 25kg',
        itemStdNm: 'Rice 25kg bag',
        orgnNatCd: 'RW',
        pkgUnitCd: 'BG',
        qtyUnitCd: 'KG',
        taxTyCd: 'B',
        btchNo: 'B26',
        bcd: '1234567890123',
        dftPrc: 25000,
        addInfo: 'FIFO',
        sftyQty: 15,
        isrcAplcbYn: 'N',
        useYn: 'Y',
      }),
      { companyId: 'company-1', branchId: '00' },
    );
    const request = ebmService.saveItems.mock.calls[0][0];
    expect(request).not.toHaveProperty('grpPrcL1');
    expect(request).not.toHaveProperty('companyId');
    expect(EBMBranchService.ensureBranchRegistered).toHaveBeenCalledWith({
      companyId: 'company-1',
      branchId: '00',
      mode: 'mock',
    });
    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: true,
      registeredWithRra: true,
      ebmRegistrationStatus: 'registered',
      ebmItemCode: 'RW2BGKG0000001',
      ebmRegistrationError: null,
    });
    expect(product.ebm.ebmRegisteredAt).toBeInstanceOf(Date);
    expect(product.ebm.registeredAt).toEqual(product.ebm.ebmRegisteredAt);
  });

  it.each(['1', '2', '3'])('sends product type %s unchanged and embeds it unchanged in generated itemCd', async (itemTyCd) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm: { ...baseProduct().ebm, itemTyCd } }));
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1');

    const payload = ebmService.saveItems.mock.calls[0][0];
    expect(payload.itemTyCd).toBe(itemTyCd);
    expect(typeof payload.itemTyCd).toBe('string');
    expect(payload.itemCd).toBe(`RW${itemTyCd}BGKG0000001`);
    expect(nextGlobalSequence).toHaveBeenCalledTimes(1);
  });

  it('skips a generated code already present in the synchronized taxpayer item catalog', async () => {
    Product.findOne.mockResolvedValue(baseProduct());
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    nextGlobalSequence
      .mockResolvedValueOnce('0000001')
      .mockResolvedValueOnce('0000002');
    registeredItemCodeExists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await EBMProductService.registerProduct('company-1', 'product-1');

    expect(registeredItemCodeExists).toHaveBeenNthCalledWith(1, {
      companyId: 'company-1', tin: '999991130', itemCd: 'RW2BGKG0000001',
    });
    expect(ebmService.saveItems).toHaveBeenCalledWith(expect.objectContaining({
      itemCd: 'RW2BGKG0000002',
    }), expect.anything());
  });

  it.each([
    ['lowercase country', { countryCode: 'rw', itemTyCd: '2', pkgUnitCd: 'NT', qtyUnitCd: 'BA', sequence: '0000012' }],
    ['padded unit whitespace', { countryCode: 'RW', itemTyCd: '2', pkgUnitCd: 'NT ', qtyUnitCd: 'BA', sequence: '0000012' }],
    ['zero sequence', { countryCode: 'RW', itemTyCd: '2', pkgUnitCd: 'NT', qtyUnitCd: 'BA', sequence: '0000000' }],
    ['sequence whitespace', { countryCode: 'RW', itemTyCd: '2', pkgUnitCd: 'NT', qtyUnitCd: 'BA', sequence: ' 12 ' }],
  ])('rejects %s rather than silently normalizing the item-code components', async (_label, components) => {
    expect(() => EBMProductService.__test__.buildRraItemCode(components)).toThrow();
  });

  it('matches the §4.17 published item-code example exactly', () => {
    expect(EBMProductService.__test__.buildRraItemCode({
      countryCode: 'RW', itemTyCd: '2', pkgUnitCd: 'NT', qtyUnitCd: 'BA', sequence: '12',
    })).toBe('RW2NTBA0000012');
  });

  it.each([
    ['missing', undefined],
    ['unknown code', '4'],
    ['zero-padded code', '02'],
    ['numeric rather than string', 2],
  ])('rejects %s product type before sequence reservation or fiscal dispatch', async (_label, itemTyCd) => {
    const ebm = { ...baseProduct().ebm };
    if (itemTyCd === undefined) delete ebm.itemTyCd;
    else ebm.itemTyCd = itemTyCd;
    Product.findOne.mockResolvedValue(baseProduct({ ebm }));

    await expect(EBMProductService.registerProduct('company-1', 'product-1'))
      .rejects.toMatchObject({
        code: itemTyCd === undefined ? 'EBM_PRODUCT_FIELDS_MISSING' : 'EBM_PRODUCT_ITEM_TYPE_INVALID',
        statusCode: 422,
      });

    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('blocks registration when synchronized product-type class 24 is absent', async () => {
    Product.findOne.mockResolvedValue(baseProduct());
    EBMCode.countDocuments.mockImplementation(async (query) => (query.codeClass === '24' ? 0 : 1));

    await expect(EBMProductService.registerProduct('company-1', 'product-1'))
      .rejects.toMatchObject({ code: 'EBM_CODES_NOT_SYNCED', statusCode: 409 });

    expect(EBMCode.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1', codeClass: '24', active: { $ne: false },
    }));
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects a product-type code marked inactive even if its code string is published', async () => {
    Product.findOne.mockResolvedValue(baseProduct());
    EBMCode.exists.mockImplementation(async (query) => query.codeClass !== '24');

    await expect(EBMProductService.registerProduct('company-1', 'product-1'))
      .rejects.toMatchObject({ code: 'EBM_PRODUCT_ITEM_TYPE_INVALID', field: 'itemTyCd', statusCode: 422 });

    expect(EBMCode.exists).toHaveBeenCalledWith({
      company: 'company-1',
      active: { $ne: false },
      useYn: { $ne: 'N' },
      codeClassUseYn: { $ne: 'N' },
      codeClass: '24',
      code: '2',
    });
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it.each(['A', 'B', 'C', 'D'])('keeps RRA tax type %s as its code instead of turning the label into a rate', async (taxTyCd) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm: { ...baseProduct().ebm, taxTyCd } }));
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1');

    const payload = ebmService.saveItems.mock.calls[0][0];
    expect(payload.taxTyCd).toBe(taxTyCd);
    expect(typeof payload.taxTyCd).toBe('string');
    expect(payload.taxTyCd).not.toBe(18);
  });

  it('accepts the documented successful response with data null', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    ebmService.saveItems.mockResolvedValueOnce({
      ok: true,
      resultCd: '000',
      data: null,
      raw: {
        resultCd: '000',
        resultMsg: 'It is succeeded',
        resultDt: '20261015120000',
        data: null,
      },
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).resolves.toBe(product);

    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: true,
      registeredWithRra: true,
      ebmRegistrationStatus: 'registered',
    });
  });

  it('persists a definite RRA rejection without marking the product registered', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    const rejection = Object.assign(new Error('VSDC rejected the item: invalid item code'), {
      code: 'EBM_VSDC_REJECTED',
      resultCd: '001',
      endpoint: '/items/saveItems',
      dispatched: true,
      retryable: false,
      response: { resultCd: '001', resultMsg: 'Invalid item code' },
    });
    ebmService.saveItems.mockRejectedValueOnce(rejection);

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_VSDC_REJECTED',
      resultCd: '001',
      message: 'VSDC rejected the item: invalid item code',
    });

    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: false,
      registeredWithRra: false,
      ebmRegistrationStatus: 'failed',
      ebmRegistrationError: 'VSDC rejected the item: invalid item code',
      ebmRegistrationErrorCode: 'EBM_VSDC_REJECTED',
    });
    expect(product.ebm.ebmItemCode).toBeUndefined();
  });

  it('does not treat a malformed success envelope as confirmed registration', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    ebmService.saveItems.mockResolvedValueOnce({
      ok: true,
      resultCd: '000',
      data: null,
      raw: { resultCd: '000' },
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_REGISTRATION_OUTCOME_UNKNOWN',
      statusCode: 409,
      retryable: false,
    });

    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: false,
      registeredWithRra: false,
      ebmRegistrationStatus: 'reconciliation_required',
      ebmRegistrationErrorCode: 'EBM_ITEM_REGISTRATION_OUTCOME_UNKNOWN',
      ebmRegistrationAttemptItemCode: 'RW2BGKG0000001',
    });
    expect(product.ebm.ebmItemCode).toBeUndefined();
  });

  it('records an unknown dispatched outcome and blocks blind retry', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    const transportError = Object.assign(new Error('VSDC request timed out'), {
      code: 'EBM_VSDC_REQUEST_FAILED',
      endpoint: '/items/saveItems',
      dispatched: true,
      retryable: true,
      requestId: 'request-123',
    });
    ebmService.saveItems.mockRejectedValueOnce(transportError);

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_REGISTRATION_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
      requestId: 'request-123',
    });
    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: false,
      registeredWithRra: false,
      ebmRegistrationStatus: 'reconciliation_required',
      ebmRegistrationAttemptItemCode: 'RW2BGKG0000001',
      ebmRegistrationRequestId: 'request-123',
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_REGISTRATION_RECONCILIATION_REQUIRED',
      statusCode: 409,
    });
    expect(ebmService.saveItems).toHaveBeenCalledTimes(1);
  });

  it('marks a request that failed before item dispatch as failed and unregistered', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });
    EBMBranchService.ensureBranchRegistered.mockRejectedValueOnce(
      Object.assign(new Error('Branch prerequisite is not ready'), {
        code: 'EBM_BRANCH_NOT_REGISTERED',
        dispatched: false,
      }),
    );

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_BRANCH_NOT_REGISTERED',
    });
    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: false,
      registeredWithRra: false,
      ebmRegistrationStatus: 'failed',
    });
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('keeps an accepted request in reconciliation when confirmed state cannot be persisted', async () => {
    const product = baseProduct();
    product.save
      .mockResolvedValueOnce(product)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(product);
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_REGISTRATION_ACCEPTED_STATE_PERSIST_FAILED',
      remoteAccepted: true,
      retryable: false,
    });
    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: false,
      registeredWithRra: false,
      ebmRegistrationStatus: 'reconciliation_required',
      ebmRegistrationAttemptItemCode: 'RW2BGKG0000001',
    });
    expect(product.ebm.ebmItemCode).toBeUndefined();
  });

  it('generates and persists a unique RRA item identifier instead of using SKU', async () => {
    const product = baseProduct({
      _id: 'product-2',
      sku: 'SKU-THAT-IS-NOT-RRA',
      defaultWarehouse: null,
      ebm: {
        itemClassCd: '5022110100',
        taxTyCd: 'B',
        itemTyCd: '2',
        pkgUnitCd: 'NT',
        qtyUnitCd: 'U',
        orgnNatCd: 'RW',
      },
    });

    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-2');

    expect(ebmService.saveItems).toHaveBeenCalledWith(
      expect.objectContaining({
        tin: '999991130',
        bhfId: '00',
        itemCd: 'RW2NTU0000001',
      }),
      { companyId: 'company-1', branchId: '00' },
    );
    expect(product.ebm.ebmItemCode).toBe('RW2NTU0000001');
    expect(product.ebm.ebmItemCode).not.toBe(product.sku);
    expect(EBMProductService.__test__.isValidRraItemCode(product.ebm.ebmItemCode)).toBe(true);
  });

  it('preserves the exact identifier of an already registered item even if it is outside the local generator pattern', async () => {
    const existingItemCode = '00123456789012345678';
    const product = baseProduct({
      ebm: {
        ...baseProduct().ebm,
        isRegisteredWithEBM: true,
        ebmRegistrationStatus: 'registered',
        ebmItemCode: existingItemCode,
      },
    });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1');

    expect(ebmService.saveItems).toHaveBeenCalledWith(expect.objectContaining({
      itemCd: existingItemCode,
    }), { companyId: 'company-1', branchId: '00' });
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(registeredItemCodeExists).not.toHaveBeenCalled();
    expect(product.ebm.ebmItemCode).toBe(existingItemCode);
  });

  it('blocks re-submission of an item marked registered when its identifier is missing', async () => {
    const product = baseProduct({
      ebm: {
        ...baseProduct().ebm,
        isRegisteredWithEBM: true,
        ebmRegistrationStatus: 'registered',
        ebmItemCode: null,
      },
    });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_REGISTERED_ITEM_CODE_MISSING',
      statusCode: 409,
    });
    expect(ebmService.saveItems).not.toHaveBeenCalled();
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(product.ebm).toMatchObject({
      isRegisteredWithEBM: true,
      ebmRegistrationStatus: 'registered',
      ebmItemCode: null,
    });
  });

  it('keeps the separate packaging and quantity code strings in the item DTO and generated item code', async () => {
    const product = baseProduct({
      ebm: {
        itemClassCd: '5022110100', taxTyCd: 'B', itemTyCd: '2',
        pkgUnitCd: 'CTN', qtyUnitCd: '4B', orgnNatCd: 'RW',
      },
    });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1');

    const payload = ebmService.saveItems.mock.calls[0][0];
    expect(payload).toMatchObject({
      itemCd: 'RW2CTN4B0000001',
      pkgUnitCd: 'CTN',
      qtyUnitCd: '4B',
    });
    expect(typeof payload.pkgUnitCd).toBe('string');
    expect(typeof payload.qtyUnitCd).toBe('string');
    expect(EBMCode.exists).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1', codeClass: '17', code: 'CTN', active: { $ne: false },
      useYn: { $ne: 'N' }, codeClassUseYn: { $ne: 'N' },
    }));
    expect(EBMCode.exists).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1', codeClass: '10', code: '4B', active: { $ne: false },
      useYn: { $ne: 'N' }, codeClassUseYn: { $ne: 'N' },
    }));
  });

  it.each([
    ['packaging', { pkgUnitCd: 'TOOLONG', qtyUnitCd: '4B' }, 'pkgUnitCd'],
    ['quantity', { pkgUnitCd: 'CTN', qtyUnitCd: 'TOOLONG' }, 'qtyUnitCd'],
    ['numeric package', { pkgUnitCd: 4, qtyUnitCd: '4B' }, 'pkgUnitCd'],
  ])('rejects invalid %s unit values before sequence reservation or fiscal dispatch', async (_label, units, field) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm: { ...baseProduct().ebm, ...units } }));

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: field === 'pkgUnitCd' ? 'EBM_PRODUCT_PACKAGING_UNIT_INVALID' : 'EBM_PRODUCT_QUANTITY_UNIT_INVALID',
      field,
      statusCode: 422,
    });

    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it.each([
    ['packaging', { pkgUnitCd: '4B', qtyUnitCd: 'U' }, '17', '4B', 'EBM_PRODUCT_PACKAGING_UNIT_INVALID'],
    ['quantity', { pkgUnitCd: 'CTN', qtyUnitCd: 'CTN' }, '10', 'CTN', 'EBM_PRODUCT_QUANTITY_UNIT_INVALID'],
  ])('does not accept a %s code merely because it exists in the other class', async (_label, units, codeClass, code, errorCode) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm: { ...baseProduct().ebm, ...units } }));
    EBMCode.exists.mockImplementation(async (query) => !(query.codeClass === codeClass && query.code === code));

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: errorCode,
    });

    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it.each([
    ['packaging', { pkgUnitCd: 'CTN', qtyUnitCd: '4B' }, '17', 'CTN', 'EBM_PRODUCT_PACKAGING_UNIT_INVALID'],
    ['quantity', { pkgUnitCd: 'CTN', qtyUnitCd: '4B' }, '10', '4B', 'EBM_PRODUCT_QUANTITY_UNIT_INVALID'],
  ])('rejects an inactive %s code before reserving an item sequence', async (_label, units, codeClass, code, errorCode) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm: { ...baseProduct().ebm, ...units } }));
    EBMCode.exists.mockImplementation(async (query) => !(query.codeClass === codeClass && query.code === code));

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: errorCode,
      statusCode: 422,
    });
    expect(EBMCode.exists).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1', codeClass, code,
      active: { $ne: false }, useYn: { $ne: 'N' }, codeClassUseYn: { $ne: 'N' },
    }));
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('omits optional fields that have no product source', async () => {
    const product = baseProduct({
      lowStockThreshold: null,
      barcode: null,
      ebm: {
        itemClassCd: '5022110100',
        taxTyCd: 'B',
        itemTyCd: '2',
        pkgUnitCd: 'BG',
        qtyUnitCd: 'KG',
        orgnNatCd: 'RW',
      },
    });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1');

    const request = ebmService.saveItems.mock.calls[0][0];
    for (const field of ['btchNo', 'bcd', 'addInfo', 'sftyQty', 'grpPrcL1', 'grpPrcL2', 'grpPrcL3', 'grpPrcL4', 'grpPrcL5']) {
      expect(request).not.toHaveProperty(field);
    }
  });

  it.each([
    ['itemStdNm', 'x'.repeat(201), 'itemStdNm'],
    ['btchNo', 'x'.repeat(11), 'btchNo'],
    ['addInfo', '12345678', 'addInfo'],
    ['barcode', '1'.repeat(21), 'bcd'],
  ])('rejects overlength %s before any VSDC request', async (field, value, expectedField) => {
    const product = baseProduct({
      ebm: {
        itemClassCd: '5022110100',
        taxTyCd: 'B',
        itemTyCd: '2',
        pkgUnitCd: 'BG',
        qtyUnitCd: 'KG',
        orgnNatCd: 'RW',
        ...(field === 'barcode' ? {} : { [field]: value }),
      },
      ...(field === 'barcode' ? { barcode: value } : {}),
    });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field: expectedField,
      statusCode: 422,
    });
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects a price with unsupported precision before any VSDC request', async () => {
    const product = baseProduct({ sellingPrice: '10.123' });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_NUMERIC_FIELD_INVALID',
      field: 'sellingPrice',
      statusCode: 422,
    });
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects a price when JavaScript number conversion would change its cents', async () => {
    const product = baseProduct({ sellingPrice: '1234567890123456.78' });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_NUMERIC_FIELD_INVALID',
      field: 'sellingPrice',
      statusCode: 422,
    });
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects excess source precision even when number conversion would round it away', async () => {
    const product = baseProduct({ sellingPrice: '1.000000000000000000000001' });
    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_NUMERIC_FIELD_INVALID',
      field: 'sellingPrice',
      statusCode: 422,
    });
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects a code that is not in its matching synchronized RRA code class', async () => {
    const product = baseProduct({
      ebm: {
        itemClassCd: '5022110100',
        taxTyCd: 'B',
        itemTyCd: '2',
        pkgUnitCd: 'NOT-A-PACKAGING-CODE',
        qtyUnitCd: 'KG',
        orgnNatCd: 'RW',
      },
    });
    Product.findOne.mockResolvedValue(product);
    EBMCode.exists.mockImplementation(async (query) => query.code !== 'NOT-A-PACKAGING-CODE');

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_PACKAGING_UNIT_INVALID',
      field: 'pkgUnitCd',
      statusCode: 422,
    });
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('rejects an item classification that is not in the synced item-class cache', async () => {
    const product = baseProduct();
    Product.findOne.mockResolvedValue(product);
    EBMItemClass.exists.mockResolvedValue(false);

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_ITEM_CLASS_INVALID',
      statusCode: 422,
    });
    expect(EBMItemClass.exists).toHaveBeenCalledWith({
      company: 'company-1',
      itemClassCode: '5022110100',
      active: { $ne: false },
    });
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it.each([
    ['tax type', '04', 'B', 'EBM_PRODUCT_TAX_CODE_INVALID', {
      itemClassCd: '5022110100', taxTyCd: 'B', itemTyCd: '2', pkgUnitCd: 'BG', qtyUnitCd: 'KG', orgnNatCd: 'RW',
    }],
    ['quantity unit', '10', 'KG', 'EBM_PRODUCT_QUANTITY_UNIT_INVALID', {
      itemClassCd: '5022110100', taxTyCd: 'B', itemTyCd: '2', pkgUnitCd: 'BG', qtyUnitCd: 'KG', orgnNatCd: 'RW',
    }],
    ['item type', '24', '2', 'EBM_PRODUCT_ITEM_TYPE_INVALID', {
      itemClassCd: '5022110100', taxTyCd: 'B', pkgUnitCd: 'BG', qtyUnitCd: 'KG', itemTyCd: '2', orgnNatCd: 'RW',
    }],
    ['origin nation', '05', 'RW', 'EBM_PRODUCT_ORIGIN_NATION_INVALID', {
      itemClassCd: '5022110100', taxTyCd: 'B', itemTyCd: '2', pkgUnitCd: 'BG', qtyUnitCd: 'KG', orgnNatCd: 'RW',
    }],
  ])('checks %s against its cached code class when that class is available', async (
    _label,
    codeClassPattern,
    rejectedCode,
    expectedError,
    ebm,
  ) => {
    Product.findOne.mockResolvedValue(baseProduct({ ebm }));
    EBMCode.exists.mockImplementation(async (query) => {
      const isTargetClass = query.codeClass === codeClassPattern
        || query.codeClassName?.$regex === codeClassPattern;
      return !isTargetClass || query.code !== rejectedCode;
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: expectedError,
      statusCode: 422,
    });
    if (_label === 'item type') {
      expect(EBMCode.exists).toHaveBeenCalledWith(expect.objectContaining({
        company: 'company-1', active: { $ne: false }, codeClass: '24', code: '2',
      }));
    }
    if (_label === 'origin nation') {
      expect(EBMCode.exists).toHaveBeenCalledWith(expect.objectContaining({
        company: 'company-1', active: { $ne: false }, codeClass: '05', code: 'RW',
      }));
    }
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('keeps registration restricted to RRA head-office branch 00', async () => {
    Product.findOne.mockResolvedValue(baseProduct());
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-2', rraBranchId: '02' })),
    });

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_HEAD_OFFICE_ONLY',
      statusCode: 403,
    });
    expect(EBMBranchService.ensureBranchRegistered).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('returns an actionable validation error when EBM product fields are missing', async () => {
    const product = baseProduct({
      ebm: {
        taxTyCd: 'B',
      },
    });
    Product.findOne.mockResolvedValue(product);

    await expect(
      EBMProductService.registerProduct('company-1', 'product-1'),
    ).rejects.toMatchObject({
      code: 'EBM_PRODUCT_FIELDS_MISSING',
      statusCode: 422,
      message: 'Missing EBM product fields: itemClassCd, itemTyCd, pkgUnitCd, qtyUnitCd, orgnNatCd',
    });
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('does not invent Rwanda when an origin nation is missing', async () => {
    Product.findOne.mockResolvedValue(baseProduct({
      ebm: { ...baseProduct().ebm, orgnNatCd: null, originCountryCode: null },
    }));

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_PRODUCT_FIELDS_MISSING',
      message: 'Missing EBM product fields: orgnNatCd',
    });
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });

  it('blocks fiscal registration when nation class 05 has not been synchronized', async () => {
    Product.findOne.mockResolvedValue(baseProduct());
    EBMCode.countDocuments.mockImplementation(async (query) => query.codeClass === '05' ? 0 : 1);

    await expect(EBMProductService.registerProduct('company-1', 'product-1')).rejects.toMatchObject({
      code: 'EBM_CODES_NOT_SYNCED',
      statusCode: 409,
    });
    expect(EBMCode.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ company: 'company-1', codeClass: '05' }));
    expect(nextGlobalSequence).not.toHaveBeenCalled();
    expect(ebmService.saveItems).not.toHaveBeenCalled();
  });
});

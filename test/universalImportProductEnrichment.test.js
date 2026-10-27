const { getEntityDefinition } = require('../services/importDefinitions');
const ImportService = require('../services/universalImportService');

describe('universal product import enrichment contract', () => {
  it('requires the same core product and RRA classification selections as product creation', () => {
    const fields = getEntityDefinition('products').fields;
    const required = new Set(fields.filter((field) => field.required).map((field) => field.key));

    expect(required).toEqual(new Set([
      'name', 'sku', 'category', 'unit', 'sellingPrice',
      'itemClassCode', 'packagingUnitCode', 'quantityUnitCode',
    ]));
    expect(fields.map((field) => field.key)).toEqual(expect.arrayContaining([
      'supplier',
      'brand',
      'taxTypeCode',
      'itemClassCode',
      'packagingUnitCode',
      'quantityUnitCode',
    ]));
  });

  it('normalizes product units and carries resolved defaults into the product payload', () => {
    expect(ImportService.__test__.quantityUnitFor('kilograms')).toBe('KGM');
    expect(ImportService.__test__.quantityUnitFor('pieces')).toBe('U');

    const payload = ImportService.__test__.productPayload('company-1', 'user-1', {
      name: 'Rice',
      sku: 'rice-1',
      quantityUnitCode: 'KGM',
      taxTypeCode: 'B',
      itemClassCode: '50202306',
      packagingUnitCode: 'NT',
      costPrice: '950',
      sellingPrice: '1200',
      reorderLevel: '20',
      reorderQuantity: '40',
      inventoryAccount: '1400',
      cogsAccount: '5000',
      revenueAccount: '4000',
      supplierId: 'supplier-1',
    });

    expect(payload).toMatchObject({
      sku: 'RICE-1',
      unit: 'kg',
      costingMethod: 'fifo',
      trackingType: 'none',
      barcodeType: 'CODE128',
      inventoryAccount: '1400',
      cogsAccount: '5000',
      revenueAccount: '4000',
      supplier: 'supplier-1',
      ebm: {
        taxTyCd: 'B',
        itemClassCd: '50202306',
        pkgUnitCd: 'NT',
        qtyUnitCd: 'KGM',
      },
    });
  });

  it('only accepts strong matches for automatic resolution', () => {
    expect(ImportService.__test__.matchScore('Main Warehouse', 'main warehouse')).toBe(1);
    expect(ImportService.__test__.bestMatch('Kigali Fresh', [
      { name: 'Kigali Fresh Foods Ltd' },
      { name: 'Other Supplier' },
    ]).candidate.name).toBe('Kigali Fresh Foods Ltd');
  });

  it('recognizes explicit RRA item class codes even when the local cache is incomplete', () => {
    expect(ImportService.__test__.isWellFormedRraItemClassCode('50202306')).toBe(true);
    expect(ImportService.__test__.isWellFormedRraItemClassCode('not-a-code')).toBe(false);
  });

  it('does not treat the §4.11 class-name typo as a quantity-unit namespace', () => {
    const classifiers = ImportService.__test__;
    expect(classifiers.isQuantityUnitCode({ codeClass: '10', codeClassName: 'Unit of Quantity', code: 'U' })).toBe(true);
    expect(classifiers.isQuantityUnitCode({ codeClass: '11', codeClassName: 'Unit of Quantity', code: '02' })).toBe(false);
    expect(classifiers.isQuantityUnitCode({ codeClass: '11', codeClassName: 'Unit of Quantity', code: 'Approved' })).toBe(false);
  });

  it('normalizes duplicate product keys within an import file', () => {
    expect(ImportService.__test__.duplicateKeyFor('products', { sku: ' prd-025 ' })).toBe('PRD-025');
  });
});

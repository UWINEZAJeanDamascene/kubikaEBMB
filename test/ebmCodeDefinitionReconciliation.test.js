const reconcileCodeDefinitionBaseline = require('../utils/ebmCodeDefinitionReconciliation');
const fixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.7-4.10.json');
const progressFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.11.json');
const registrationFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.12.json');
const purchaseReceiptFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.13.json');
const stockInOutFixture = require('../fixtures/rraVsdc/v1.0.5/stock-in-out-types-4.15.json');
const refundReasonFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.16.json');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function makeCache(classifications = fixture.classifications) {
  const classes = classifications.map((item) => ({
    company: 'tenant-1',
    codeClass: item.codeClass,
    name: item.codeClassName,
    description: null,
    useYn: 'Y',
    active: true,
  }));
  const codes = classifications.flatMap((item) => item.details.map((detail) => ({
    company: 'tenant-1',
    codeClass: item.codeClass,
    code: detail.code,
    name: detail.name,
    description: detail.description,
    sortOrder: detail.sortOrder,
    useYn: 'Y',
    active: true,
  })));
  return { classes, codes };
}

describe('§§4.7–4.10 code-definition reconciliation', () => {
  test('recognizes exact current cache matches across all four published classes', () => {
    const { classes, codes } = makeCache();
    const result = reconcileCodeDefinitionBaseline(classes, codes);

    const targetClasses = result.classes.filter((item) => ['33', '14', '37', '07'].includes(item.codeClass));
    expect(targetClasses).toHaveLength(4);
    expect(targetClasses.map((item) => item.codeClass)).toEqual(['33', '14', '37', '07']);
    for (const classification of targetClasses) {
      expect(classification.cacheClassStatus).toBe('active');
      expect(classification.classExactMatch).toBe(true);
      expect(classification.details.every((detail) => detail.exactMatch)).toBe(true);
      expect(classification.additionalCurrentCodes).toEqual([]);
    }
  });

  test('reports changed values, ordering, duplicates, and additional codes with inspectable cache values', () => {
    const { classes, codes } = makeCache();
    const firstCurrency = codes.find((item) => item.codeClass === '33' && item.code === 'AED');
    firstCurrency.name = 'Changed currency label';
    firstCurrency.description = 'Changed currency description';
    firstCurrency.sortOrder = 999;
    codes.push({ ...firstCurrency, name: 'Duplicate currency label', active: false, useYn: 'N' });
    codes.push({
      company: 'tenant-1', codeClass: '33', code: 'NEW', name: 'New RRA currency',
      description: 'Additional code', sortOrder: 180, useYn: 'Y', active: true,
    });
    const duplicateClass = { ...classes.find((item) => item.codeClass === '33'), name: 'Duplicate class label' };
    classes.push(duplicateClass);

    const currency = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '33');
    const aed = currency.details.find((item) => item.code === 'AED');

    expect(currency.duplicateClassRecords).toBe(2);
    expect(currency.duplicateClassValues.map((item) => item.name)).toEqual(['Currency', 'Duplicate class label']);
    expect(aed.differences).toEqual(['name', 'description']);
    expect(aed.differenceValues).toEqual([
      { field: 'name', expected: 'United Arab Emirates dirham', current: 'Changed currency label' },
      { field: 'description', expected: 'United Arab Emirates dirham', current: 'Changed currency description' },
    ]);
    expect(aed.orderingDifference).toEqual({ expected: 1, current: 999 });
    expect(aed.duplicateValues).toEqual([
      { name: 'Changed currency label', description: 'Changed currency description', sortOrder: 999, cacheStatus: 'active' },
      { name: 'Duplicate currency label', description: 'Changed currency description', sortOrder: 999, cacheStatus: 'inactive' },
    ]);
    expect(currency.additionalCurrentCodes).toContainEqual(expect.objectContaining({
      code: 'NEW', name: 'New RRA currency', description: 'Additional code', sortOrder: 180, cacheStatus: 'active',
    }));
  });

  test('distinguishes missing and inactive classes and treats their details as operationally inactive', () => {
    const missing = reconcileCodeDefinitionBaseline([], []).classes.find((item) => item.codeClass === '37');
    expect(missing.cacheClassStatus).toBe('missing');
    expect(missing.details.every((detail) => detail.cacheStatus === 'missing' && !detail.exactMatch)).toBe(true);

    const classification = fixture.classifications.find((item) => item.codeClass === '37');
    const { classes, codes } = makeCache([classification]);
    classes[0].active = false;
    classes[0].useYn = 'N';
    const inactive = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '37');
    expect(inactive.cacheClassStatus).toBe('inactive');
    expect(inactive.details.every((detail) => detail.cacheStatus === 'inactive' && !detail.exactMatch)).toBe(true);
  });
});

describe('§4.11 transaction-progress reconciliation', () => {
  test('compares each published progress code with active synchronized class 11 values', () => {
    const baseline = progressFixture.classifications[0];
    const classes = [{ codeClass: '11', name: baseline.codeClassName, useYn: 'Y', active: true }];
    const codes = baseline.details.map((detail) => ({
      codeClass: '11', code: detail.code, name: detail.name, description: detail.description,
      sortOrder: detail.sortOrder, useYn: 'Y', active: true,
    }));
    const progress = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '11');

    expect(progress).toMatchObject({
      section: '4.11', baselineClassName: 'Unit of Quantity', cacheClassStatus: 'active', classExactMatch: true,
    });
    expect(progress.details).toHaveLength(6);
    expect(progress.details.every((detail) => detail.exactMatch && detail.cacheStatus === 'active')).toBe(true);
  });
});

describe('§4.12 registration-type reconciliation', () => {
  test('compares A and M against active synchronized class 31 values', () => {
    const baseline = registrationFixture.classifications[0];
    const classes = [{ codeClass: '31', name: 'Registration Type', useYn: 'Y', active: true }];
    const codes = baseline.details.map((detail) => ({
      codeClass: '31', code: detail.code, name: detail.name, description: detail.description,
      sortOrder: detail.sortOrder, useYn: 'Y', active: true,
    }));
    const registration = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '31');

    expect(registration).toMatchObject({
      section: '4.12', baselineClassName: 'Registration Type', cacheClassStatus: 'active', classExactMatch: true,
    });
    expect(registration.details.map(({ code, exactMatch, cacheStatus }) => [code, exactMatch, cacheStatus]))
      .toEqual([['A', true, 'active'], ['M', true, 'active']]);
  });
});

describe('§4.13 purchase-receipt-type reconciliation', () => {
  test('compares P and R against active synchronized class 38 values', () => {
    const baseline = purchaseReceiptFixture.classifications[0];
    const classes = [{ codeClass: '38', name: 'Purchase Receipt Type', useYn: 'Y', active: true }];
    const codes = baseline.details.map((detail) => ({
      codeClass: '38', code: detail.code, name: detail.name, description: detail.description,
      sortOrder: detail.sortOrder, useYn: 'Y', active: true,
    }));
    const receiptType = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '38');

    expect(receiptType).toMatchObject({
      section: '4.13', baselineClassName: 'Purchase Receipt Type', cacheClassStatus: 'active', classExactMatch: true,
    });
    expect(receiptType.details.map(({ code, exactMatch, cacheStatus }) => [code, exactMatch, cacheStatus]))
      .toEqual([['P', true, 'active'], ['R', true, 'active']]);
  });
});

describe('§4.16 refund-reason reconciliation', () => {
  test('keeps the source PDF identity and ordered fixture digest verifiable', () => {
    const fixturePath = require.resolve('../fixtures/rraVsdc/v1.0.5/code-definitions-4.16.json');
    const pdfPath = path.resolve(path.dirname(fixturePath), refundReasonFixture.source.pdf);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(refundReasonFixture.source.sha256);
    expect(refundReasonFixture.classifications[0].details).toHaveLength(refundReasonFixture.integrity.rowCount);
    expect(crypto.createHash('sha256').update(JSON.stringify(refundReasonFixture.classifications), 'utf8').digest('hex'))
      .toBe(refundReasonFixture.integrity.sha256);
  });

  test('compares all 13 class 32 refund reasons against active synchronized values', () => {
    const baseline = refundReasonFixture.classifications[0];
    const classes = [{ codeClass: '32', name: baseline.codeClassName, useYn: 'Y', active: true }];
    const codes = baseline.details.map((detail) => ({
      codeClass: '32', code: detail.code, name: detail.name, description: detail.description,
      sortOrder: detail.sortOrder, useYn: 'Y', active: true,
    }));
    const refund = reconcileCodeDefinitionBaseline(classes, codes).classes.find((item) => item.codeClass === '32');

    expect(refund).toMatchObject({
      section: '4.16', baselineClassName: 'Refund reason code', cacheClassStatus: 'active', classExactMatch: true,
    });
    expect(refund.details).toHaveLength(13);
    expect(refund.details.every((detail) => detail.exactMatch && detail.cacheStatus === 'active')).toBe(true);
    expect(refund.details.map(({ code }) => code)).toEqual(baseline.details.map(({ code }) => code));
  });
});

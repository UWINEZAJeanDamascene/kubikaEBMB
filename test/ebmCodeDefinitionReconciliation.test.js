const reconcileCodeDefinitionBaseline = require('../utils/ebmCodeDefinitionReconciliation');
const fixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.7-4.10.json');

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

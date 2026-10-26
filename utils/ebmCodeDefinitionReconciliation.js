const CODE_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.1-4.3.json');
const NATION_CODE_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.4.json');
const UNIT_CODE_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.5-4.6.json');
const CURRENCY_TRANSACTION_PAYMENT_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.7-4.10.json');

const BASELINES = [
  CODE_DEFINITION_BASELINE,
  NATION_CODE_DEFINITION_BASELINE,
  UNIT_CODE_DEFINITION_BASELINE,
  CURRENCY_TRANSACTION_PAYMENT_BASELINE,
];

function isRecordActive(record, parentClassActive = true) {
  return parentClassActive && record.useYn !== 'N' && record.active !== false;
}

function reconcileCodeDefinitionBaseline(classes = [], codes = []) {
  const classByCode = new Map();
  for (const item of classes) {
    const key = String(item.codeClass);
    if (!classByCode.has(key)) classByCode.set(key, []);
    classByCode.get(key).push(item);
  }

  const detailsByClass = new Map();
  for (const item of codes) {
    const key = String(item.codeClass);
    if (!detailsByClass.has(key)) detailsByClass.set(key, new Map());
    const byCode = detailsByClass.get(key);
    const detailCode = String(item.code);
    if (!byCode.has(detailCode)) byCode.set(detailCode, []);
    byCode.get(detailCode).push(item);
  }

  const reconciled = BASELINES.flatMap((baseline) => baseline.classifications.map((baselineClass) => {
    const codeClass = String(baselineClass.codeClass);
    const currentClassRecords = classByCode.get(codeClass) || [];
    const currentClass = currentClassRecords[0];
    const classOperationallyActive = currentClassRecords.some((record) => isRecordActive(record));
    const currentDetails = detailsByClass.get(codeClass) || new Map();
    const classDifferences = currentClass && currentClass.name !== baselineClass.codeClassName
      ? ['className']
      : [];

    const details = baselineClass.details.map((baselineDetail) => {
      const records = currentDetails.get(String(baselineDetail.code)) || [];
      const current = records[0];
      const differences = [];
      if (current && current.name !== baselineDetail.name) differences.push('name');
      if (current && (current.description ?? null) !== (baselineDetail.description ?? null)) differences.push('description');
      const activeRecords = records.filter((record) => isRecordActive(record, classOperationallyActive));
      const orderingDifference = current && Number(current.sortOrder) !== baselineDetail.sortOrder
        ? { expected: baselineDetail.sortOrder, current: current.sortOrder }
        : null;
      const duplicateValues = records.length > 1
        ? records.map((record) => ({
          name: record.name ?? null,
          description: record.description ?? null,
          sortOrder: record.sortOrder ?? null,
          cacheStatus: isRecordActive(record, classOperationallyActive) ? 'active' : 'inactive',
        }))
        : null;
      const exactMatch = Boolean(
        currentClassRecords.length === 1
        && classOperationallyActive
        && records.length === 1
        && activeRecords.length === 1
        && differences.length === 0
        && !orderingDifference,
      );

      return {
        code: baselineDetail.code,
        baselineStatus: 'published',
        cacheStatus: !records.length ? 'missing' : activeRecords.length ? 'active' : 'inactive',
        differences,
        differenceValues: differences.map((field) => ({
          field,
          expected: baselineDetail[field] ?? null,
          current: current?.[field] ?? null,
        })),
        exactMatch,
        unresolvedMismatch: differences.length > 0,
        ...(orderingDifference ? { orderingDifference } : {}),
        ...(records.length > 1 ? {
          duplicateRecords: records.length,
          duplicateValues,
        } : {}),
      };
    });

    const baselineCodes = new Set(baselineClass.details.map((item) => String(item.code)));
    const additionalCurrentCodes = [...currentDetails.entries()]
      .filter(([code]) => !baselineCodes.has(code))
      .flatMap(([code, records]) => records.map((record) => ({
        code,
        name: record.name ?? null,
        description: record.description ?? null,
        sortOrder: record.sortOrder ?? null,
        cacheStatus: isRecordActive(record, classOperationallyActive) ? 'active' : 'inactive',
        ...(records.length > 1 ? {
          duplicateRecords: records.length,
          duplicateValues: records.map((duplicate) => ({
            name: duplicate.name ?? null,
            description: duplicate.description ?? null,
            sortOrder: duplicate.sortOrder ?? null,
            cacheStatus: isRecordActive(duplicate, classOperationallyActive) ? 'active' : 'inactive',
          })),
        } : {}),
      })));

    const nameCodes = new Map();
    for (const baselineDetail of baselineClass.details) {
      const normalizedName = String(baselineDetail.name || '').trim().toLowerCase();
      if (!normalizedName) continue;
      if (!nameCodes.has(normalizedName)) nameCodes.set(normalizedName, []);
      nameCodes.get(normalizedName).push(String(baselineDetail.code));
    }
    const sameNameDifferentCodes = [...nameCodes.entries()]
      .filter(([, codesForName]) => new Set(codesForName).size > 1)
      .map(([name, codesForName]) => ({ name, codes: [...new Set(codesForName)] }));
    const classDifferenceValues = classDifferences.map((field) => ({
      field,
      expected: baselineClass.codeClassName,
      current: currentClass?.name ?? null,
    }));
    const classExactMatch = Boolean(
      currentClassRecords.length === 1
      && classOperationallyActive
      && classDifferences.length === 0,
    );

    return {
      codeClass,
      baselineStatus: 'published',
      baselineClassName: baselineClass.codeClassName,
      baselineSource: baseline.source,
      cacheClassStatus: !currentClassRecords.length ? 'missing' : classOperationallyActive ? 'active' : 'inactive',
      classDifferences,
      classDifferenceValues,
      classExactMatch,
      unresolvedClassMismatch: classDifferences.length > 0,
      ...(currentClassRecords.length > 1 ? {
        duplicateClassRecords: currentClassRecords.length,
        duplicateClassValues: currentClassRecords.map((record) => ({
          name: record.name ?? null,
          description: record.description ?? null,
          cacheStatus: isRecordActive(record) ? 'active' : 'inactive',
        })),
      } : {}),
      details,
      additionalCurrentCodes,
      sameNameDifferentCodes,
    };
  }));

  return {
    source: CODE_DEFINITION_BASELINE.source,
    sources: BASELINES.map((baseline) => baseline.source),
    classes: reconciled,
  };
}

module.exports = reconcileCodeDefinitionBaseline;

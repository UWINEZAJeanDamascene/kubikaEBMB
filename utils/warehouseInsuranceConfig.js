const INSURANCE_FIELDS = Object.freeze(['isrccCd', 'isrccNm', 'isrcRt', 'useYn']);

function invalid(field, message) {
  const error = new TypeError(`Branch insurance ${field} ${message}.`);
  error.code = 'WAREHOUSE_INSURANCE_INVALID';
  error.statusCode = 422;
  error.field = field;
  throw error;
}

function validateWarehouseInsuranceConfig(value) {
  if (!Array.isArray(value)) invalid('list', 'must be an array');

  const seenCodes = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid(`[${index}]`, 'must be an object');
    }

    const normalized = {};
    for (const field of ['isrccCd', 'isrccNm']) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
        invalid(`[${index}].${field}`, 'is required');
      }
      const text = entry[field].trim();
      const maxLength = field === 'isrccCd' ? 10 : 100;
      if (text.length > maxLength) invalid(`[${index}].${field}`, `must be ${maxLength} characters or fewer`);
      normalized[field] = text;
    }
    if (seenCodes.has(normalized.isrccCd)) {
      invalid(`[${index}].isrccCd`, 'must be unique within the branch');
    }
    seenCodes.add(normalized.isrccCd);

    if (typeof entry.isrcRt !== 'number' || !Number.isFinite(entry.isrcRt)) {
      invalid(`[${index}].isrcRt`, 'must be a finite number');
    }
    normalized.isrcRt = entry.isrcRt;

    if (entry.useYn !== 'Y' && entry.useYn !== 'N') {
      invalid(`[${index}].useYn`, 'must be Y or N');
    }
    normalized.useYn = entry.useYn;

    return Object.fromEntries(INSURANCE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(normalized, field))
      .map((field) => [field, normalized[field]]));
  });
}

module.exports = { validateWarehouseInsuranceConfig };

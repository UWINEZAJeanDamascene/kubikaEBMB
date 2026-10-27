const baseline = require('../fixtures/rraVsdc/v1.0.5/import-item-status-4.18.json');

const RRA_IMPORT_ITEM_STATUS_CLASS = baseline.scope.classificationCode;
const RRA_IMPORT_ITEM_STATUS_BY_CODE = Object.freeze(Object.fromEntries(
  baseline.codes.map(({ code, name, sortOrder }) => [code, Object.freeze({ code, name, sortOrder })]),
));

function getRraImportItemStatusName(code) {
  return typeof code === 'string' ? RRA_IMPORT_ITEM_STATUS_BY_CODE[code]?.name ?? null : null;
}

module.exports = {
  RRA_IMPORT_ITEM_STATUS_CLASS,
  RRA_IMPORT_ITEM_STATUS_BY_CODE,
  getRraImportItemStatusName,
};

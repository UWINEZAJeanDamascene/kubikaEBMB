const moduleEntitlementService = require('../services/moduleEntitlementService');

function withFiscalSnapshot(translateCreate) {
  return async function translateFiscalDocumentCreate(data, ...args) {
    const created = await translateCreate(data, ...args);
    const snapshot = await moduleEntitlementService.getFiscalSnapshot(created.companyId);
    return { ...created, ...snapshot };
  };
}

function isExplicitlyNonFiscal(document) {
  return document?.fiscalMode === 'none';
}

module.exports = { withFiscalSnapshot, isExplicitlyNonFiscal };

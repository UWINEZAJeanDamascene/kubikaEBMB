'use strict';

const posNonPostingDocumentService = require('../services/posNonPostingDocumentService');
const { dbClient } = require('../lib/prisma');
const { createDirectSale } = require('./salesLegacyController');

function context(req) {
  const companyId = String(req.posSession?.companyId || req.user?.company?._id || req.user?.companyId || '');
  const registerId = String(req.posSession?.registerId || '');
  const userId = String(req.posSession?.userId || req.user?.id || req.user?._id || '');
  return { companyId, registerId, userId };
}

exports.list = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const documents = await posNonPostingDocumentService.listDocuments({ companyId, registerId, type: req.query.type || null, limit: req.query.limit });
    return res.json({ success: true, data: documents });
  } catch (error) { return next(error); }
};

exports.createTraining = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    if (!req.posRegister?.trainingMode) return res.status(409).json({ success: false, code: 'POS_TRAINING_MODE_DISABLED', message: 'Training mode is not enabled for this register.' });
    const document = await posNonPostingDocumentService.createDocument({ companyId, registerId, userId, kind: 'TRAINING', input: req.body || {} });
    return res.status(201).json({ success: true, data: document, message: 'Training document saved. It did not record a sale.' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

exports.createProforma = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const document = await posNonPostingDocumentService.createDocument({ companyId, registerId, userId, kind: 'PROFORMA', input: req.body || {} });
    return res.status(201).json({ success: true, data: document, message: 'Proforma saved for information only. No sale has been recorded.' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

async function createInformationalDocument(req, res, next, kind, label) {
  try {
    const { companyId, registerId, userId } = context(req);
    const document = await posNonPostingDocumentService.createDocument({ companyId, registerId, userId, kind, input: req.body || {} });
    return res.status(201).json({ success: true, data: document, message: `${label} saved. It did not record a sale or move stock.` });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
}

exports.createQuote = (req, res, next) => createInformationalDocument(req, res, next, 'QUOTE', 'Quote');
exports.createDeliveryNote = (req, res, next) => createInformationalDocument(req, res, next, 'DELIVERY_NOTE', 'Draft delivery note');

exports.convertProforma = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const id = String(req.params.documentId || '');
    const document = await dbClient().posNonPostingDocument.findFirst({ where: { id, companyId, registerId } });
    if (!document || document.documentType !== 'PROFORMA') return res.status(404).json({ success: false, code: 'POS_PROFORMA_NOT_FOUND', message: 'Proforma was not found for this register.' });
    if (document.status === 'converted' && document.convertedInvoiceId) {
      const invoice = await dbClient().invoice.findFirst({ where: { id: document.convertedInvoiceId, companyId } });
      if (invoice) return res.json({ success: true, replayed: true, data: invoice });
    }
    if (document.status !== 'open') return res.status(409).json({ success: false, code: 'POS_PROFORMA_NOT_OPEN', message: 'This proforma cannot be converted.' });
    const saved = document.documentData || {};
    const saleBody = {
      ...(req.body || {}),
      proformaDocumentId: document.id,
      items: Array.isArray(saved.items) ? saved.items.map((item) => ({
        productId: item.productId, quantity: item.salesQuantity ?? item.quantity,
        unitPrice: item.saleUnitPrice ?? (Number(item.unitPrice) * Number(item.baseUnitsPerSale || 1)),
        catalogUnitPrice: item.catalogSaleUnitPrice ?? undefined,
        salesUnitCode: item.salesUnitCode || undefined,
        discountPct: item.discountPct, discountReason: item.discountReason, serialNumbers: item.serialNumbers || [],
      })) : [],
      warehouseId: req.body?.warehouseId || saved.warehouseId,
      clientId: req.body?.clientId || saved.clientId || undefined,
      clientInfo: req.body?.clientInfo || saved.clientInfo || undefined,
      buyerTin: saved.buyerTin || undefined,
      salespersonId: saved.salespersonId || undefined,
      salespersonName: saved.salespersonName || undefined,
      cartDiscountPct: Number(saved.cartDiscountPct) || 0,
      cartDiscountReason: saved.cartDiscountReason || '',
      registerId: req.posRegister?.code || req.body?.registerId,
    };
    req.body = saleBody;
    let status = 200;
    const wrappedResponse = {
      status(code) { status = code; return this; },
      json(body) { return res.status(status).json(body); },
    };
    return createDirectSale(req, wrappedResponse, next);
  } catch (error) {
    return next(error);
  }
};

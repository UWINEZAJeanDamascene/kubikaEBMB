'use strict';

const { createHash, randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { prisma } = require('../lib/prisma');
const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const { generateObjectId } = require('../utils/objectId');
const { buildPosReceiptDocument } = require('./posReceiptDocumentService');
const { resolveReceiptSettings } = require('./posReceiptSettingsService');
const { requestIp, writePosAuditLog } = require('./posAuditService');
const { lineTaxDetails, extractPayloadTotals, formatRwf, taxTypeLabel, generateQrPng } = require('../utils/pdfUtils');
const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
const environment = require('../src/config/environment');

const config = environment.getConfig();
const PUBLIC_RECEIPT_NOT_FOUND = Object.assign(new Error('Receipt not found.'), { statusCode: 404, code: 'POS_PUBLIC_RECEIPT_NOT_FOUND' });
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function cleanText(value, max = 300) {
  return String(value || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

function receiptImageBuffer(value) {
  const raw = String(value || '');
  const match = raw.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
  if (match) return Buffer.from(match[2], 'base64');
  if (!raw.startsWith('/uploads/')) return null;
  let relative;
  try { relative = decodeURIComponent(raw.slice('/uploads/'.length)); } catch { return null; }
  const uploadRoot = path.resolve(__dirname, '..', 'uploads');
  const imagePath = path.resolve(uploadRoot, relative);
  if (!imagePath.startsWith(`${uploadRoot}${path.sep}`) || !fs.existsSync(imagePath)) return null;
  const stat = fs.statSync(imagePath);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
  return fs.readFileSync(imagePath);
}

function expiryDays(settings) {
  const parsed = Number(settings?.digitalReceiptExpiryDays);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_EXPIRY_DAYS;
  return Math.min(MAX_EXPIRY_DAYS, Math.floor(parsed));
}

function maskTin(value) {
  const tin = String(value || '').trim();
  if (!tin) return null;
  const digits = tin.replace(/\D/g, '');
  return digits.length <= 3 ? '***' : `${'*'.repeat(Math.min(8, digits.length - 3))}${digits.slice(-3)}`;
}

function requireCompanyId(companyId) {
  const value = String(companyId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(value)) throw PUBLIC_RECEIPT_NOT_FOUND;
  return value;
}

async function loadSavedReceipt(companyIdValue, invoiceIdValue) {
  const companyId = requireCompanyId(companyIdValue);
  const invoiceId = String(invoiceIdValue || '').trim();
  if (!/^[a-f\d]{24}$/i.test(invoiceId)) throw PUBLIC_RECEIPT_NOT_FOUND;
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate('client', 'name taxId digitalReceiptConsent')
    .populate('createdBy', 'name')
    .populate('lines.product', 'name sku barcode unit ebm');
  if (!invoice || ['draft', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) throw PUBLIC_RECEIPT_NOT_FOUND;
  if (invoice.client?.digitalReceiptConsent !== true) {
    throw Object.assign(new Error('This customer has not agreed to receive digital receipts.'), {
      code: 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED', statusCode: 403,
    });
  }

  const plain = invoice.toObject({ virtuals: true });
  const [company, settings, submission] = await Promise.all([
    Company.findById(companyId).lean(),
    prisma.systemSettings.findUnique({ where: { companyId }, select: { posReceiptSettings: true } }),
    prisma.ebmSubmissionQueue.findFirst({
      where: { companyId, documentType: 'pos', documentId: invoiceId, salesTyCd: 'N', rcptTyCd: 'S' },
      orderBy: [{ signedAt: 'desc' }, { createdAt: 'desc' }],
    }),
  ]);
  const registerId = submission?.registerId || plain.posRegisterId || null;
  const register = registerId ? await prisma.posRegister.findFirst({ where: { id: registerId, companyId }, select: { name: true, branchId: true } }) : null;
  const receiptSettings = resolveReceiptSettings(settings?.posReceiptSettings, register?.branchId || plain.warehouseId || null);
  receiptSettings.logoUrl ||= company?.logo_url || '';
  if (receiptSettings.digitalReceiptsEnabled === false) throw PUBLIC_RECEIPT_NOT_FOUND;

  const signedSubmission = Boolean(submission && submission.ebmStatus === 'submitted' && submission.signedAt);
  const legacyFiscalStatus = String(plain.ebm?.ebmStatus || '').toLowerCase();
  const useLegacyFiscalData = !submission && ['submitted', 'success'].includes(legacyFiscalStatus);
  const ebm = signedSubmission ? (() => {
    const signed = extractSaveSalesFiscalData(submission.fiscalResponse);
    return {
      ...(plain.ebm || {}), ebmStatus: 'submitted', fiscalDataSource: submission.fiscalDataSource,
      v2SubmissionId: submission.id, environment: submission.environment, fiscalEnvironment: submission.environment,
      rcptNo: signed.rcptNo, rcptDt: signed.rcptDt, rcptSign: signed.rcptSign, intrlData: signed.intrlData,
      sdcId: signed.sdcId, mrcNo: signed.mrcNo, curRcptNo: signed.curRcptNo, totRcptNo: signed.totRcptNo,
    };
  })() : useLegacyFiscalData ? (plain.ebm || {}) : {};

  const lines = plain.items || plain.lines || [];
  const payloadLines = ebm.salesPayload?.itemList || (signedSubmission ? submission.payload?.itemList : null) || [];
  const receiptLines = lines.map((line, index) => {
    const fiscalLine = payloadLines[index] || {};
    const tax = lineTaxDetails(line);
    const itemName = line.product?.name || line.productName || line.description || 'Item';
    return {
      itemName: (signedSubmission && fiscalLine.itemNm) || itemName,
      itemCode: fiscalLine.itemCd || line.productCode || line.product?.sku || null,
      taxClassCode: fiscalLine.itemClsCd || line.product?.ebm?.itemClsCd || null,
      quantity: signedSubmission && fiscalLine.qty != null ? fiscalLine.qty : (line.quantity ?? line.qty ?? 0),
      unit: line.unit || line.product?.unit || null,
      unitPriceRwf: signedSubmission && fiscalLine.prc != null ? fiscalLine.prc : line.unitPrice,
      discountAmountRwf: fiscalLine.dcAmt ?? line.discountAmount ?? null,
      lineTotalRwf: signedSubmission && fiscalLine.totAmt != null ? fiscalLine.totAmt : tax.lineTotal,
      taxableAmountRwf: signedSubmission && fiscalLine.taxblAmt != null ? fiscalLine.taxblAmt : tax.taxableAmount,
      vatAmountRwf: signedSubmission && fiscalLine.taxAmt != null ? fiscalLine.taxAmt : tax.vatAmount,
      taxTypeCode: fiscalLine.taxTyCd || tax.taxTyCd,
      taxTypeLabel: tax.taxTypeLabel,
      taxRate: fiscalLine.taxRt ?? tax.taxRate,
      barcode: fiscalLine.bcd || line.product?.barcode || null,
    };
  });

  const totals = extractPayloadTotals(ebm, plain);
  const rraTotals = Object.keys(totals || {}).length ? {
    taxableByType: ['A', 'B', 'C', 'D']
      .map((code) => ({
        code, rate: totals[`taxRt${code}`], label: taxTypeLabel(code, totals[`taxRt${code}`]),
        amount: totals[`taxblAmt${code}`], amountRwf: formatRwf(totals[`taxblAmt${code}`]),
        taxAmount: totals[`taxAmt${code}`], taxAmountRwf: formatRwf(totals[`taxAmt${code}`]),
      }))
      .filter((row) => Math.round(Math.abs(Number(row.amount) || 0)) !== 0),
    totalVatRwf: formatRwf(totals.totTaxAmt),
    grandTotalRwf: formatRwf(totals.totAmt),
  } : undefined;
  if (rraTotals && !rraTotals.taxableByType.length) delete rraTotals.taxableByType;
  let qrDataUrl = null;
  if (ebm.rcptSign && ebm.intrlData) {
    const qr = await generateQrPng(ebm, { width: 180 });
    if (qr) qrDataUrl = `data:image/png;base64,${qr.toString('base64')}`;
  }
  const companyAddress = typeof company?.address === 'string'
    ? company.address
    : [company?.address?.street, company?.address?.city, company?.address?.country].filter(Boolean).join(', ');
  const methods = Array.isArray(plain.payments) ? plain.payments.map((payment) => ({
    method: String(payment.paymentMethod || 'cash').replace(/_/g, ' '),
    amountRwf: payment.amount,
    reference: payment.reference || null,
  })) : [];
  const sale = {
    ...plain,
    ebm: { ...ebm, qrCodeDataUrl: qrDataUrl },
    companyReceipt: {
      name: company?.name || 'Company', tin: company?.tax_identification_number || null,
      address: companyAddress, phone: company?.phone || null, logo: receiptSettings.logoUrl || null,
    },
    customerTin: plain.customerTin || plain.client?.taxId || null,
    receiptLines,
    receiptSettings: receiptSettings,
    rraTotals,
    paymentReceipt: {
      methods,
      amountPaidRwf: plain.amountPaid,
      changeGivenRwf: plain.changeGiven ?? (Array.isArray(plain.payments)
        ? plain.payments.reduce((sum, payment) => sum + (Number(payment.changeGiven) || 0), 0)
        : null),
    },
    cashier: null,
    cashierName: null,
  };
  sale.registerName = register?.name || null;
  const receiptDocument = buildPosReceiptDocument(sale, { registerName: sale.registerName, tillType: sale.tillType || 'retail' });
  if (receiptDocument.customer?.tin) receiptDocument.customer.tin = maskTin(receiptDocument.customer.tin);
  // Public pages omit transaction references, cashier identity and internal warehouse details.
  receiptDocument.payments = (receiptDocument.payments || []).map(({ method, amountRwf, kind }) => ({ method, amountRwf, kind }));
  receiptDocument.receipt.cashier = null;
  receiptDocument.extension = { template: receiptDocument.extension?.template || 'retail', data: {} };
  return { receiptDocument, settings: receiptSettings, invoiceId, companyId, registerId };
}

function publicUrl(token) {
  const base = new URL(config.server.frontendUrl || 'http://localhost:5173');
  const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !localHost) throw new Error('Public receipt links require HTTPS.');
  base.search = '';
  base.hash = '';
  return `${base.toString().replace(/\/$/, '')}/public/receipt/${token}`;
}

async function createPublicReceiptLink({ companyId: companyIdValue, invoiceId, userId, registerId, req }) {
  const companyId = requireCompanyId(companyIdValue);
  const receipt = await loadSavedReceipt(companyId, invoiceId);
  const days = expiryDays(receipt.settings);
  const token = randomBytes(32).toString('base64url');
  const tokenDigest = tokenHash(token);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.posPublicReceiptToken.create({ data: {
      id: generateObjectId(), companyId, invoiceId: receipt.invoiceId,
      tokenHash: tokenDigest, expiresAt,
    } });
    await writePosAuditLog({
      companyId, registerId: registerId || receipt.registerId, userId,
      ip: requestIp(req), event: 'POS_RECEIPT_LINK_CREATED',
      metadata: { invoiceId: receipt.invoiceId, linkId: created.id, expiresAt },
    }, tx);
    return created;
  });
  const url = publicUrl(token);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  return { id: row.id, url, qrDataUrl, expiresAt: row.expiresAt };
}

async function listPublicReceiptLinks({ companyId: companyIdValue, invoiceId: invoiceIdValue }) {
  const companyId = requireCompanyId(companyIdValue);
  const invoiceId = String(invoiceIdValue || '');
  const rows = await prisma.posPublicReceiptToken.findMany({
    where: { companyId, invoiceId }, orderBy: { createdAt: 'desc' }, take: 50,
    select: { id: true, expiresAt: true, revokedAt: true, firstViewedAt: true, lastViewedAt: true, viewCount: true, createdAt: true },
  });
  return rows.map((row) => ({ ...row, status: row.revokedAt ? 'revoked' : row.expiresAt <= new Date() ? 'expired' : 'active' }));
}

async function revokePublicReceiptLink({ companyId: companyIdValue, invoiceId: invoiceIdValue, linkId, userId, registerId, req }) {
  const companyId = requireCompanyId(companyIdValue);
  const invoiceId = String(invoiceIdValue || '');
  return prisma.$transaction(async (tx) => {
    const row = await tx.posPublicReceiptToken.findFirst({ where: { id: String(linkId), companyId, invoiceId, revokedAt: null } });
    if (!row) throw PUBLIC_RECEIPT_NOT_FOUND;
    const now = new Date();
    const updated = await tx.posPublicReceiptToken.updateMany({ where: { id: row.id, companyId, invoiceId, revokedAt: null }, data: { revokedAt: now } });
    if (updated.count !== 1) throw PUBLIC_RECEIPT_NOT_FOUND;
    await writePosAuditLog({
      companyId, registerId, userId, ip: requestIp(req), event: 'POS_RECEIPT_LINK_REVOKED',
      metadata: { invoiceId, linkId: row.id, revokedAt: now },
    }, tx);
    return { id: row.id, revokedAt: now };
  });
}

async function publicReceiptDocument(token) {
  const raw = String(token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw PUBLIC_RECEIPT_NOT_FOUND;
  const digest = tokenHash(raw);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`SELECT "id", "company_id" AS "companyId", "invoice_id" AS "invoiceId" FROM "pos_public_receipt_tokens" WHERE "token_hash" = ${digest} AND "revoked_at" IS NULL AND "expires_at" > NOW() FOR UPDATE`;
    const link = rows[0];
    if (!link) throw PUBLIC_RECEIPT_NOT_FOUND;
    let receipt;
    try {
      receipt = await loadSavedReceipt(link.companyId, link.invoiceId);
    } catch (error) {
      if (error?.code === 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED') throw PUBLIC_RECEIPT_NOT_FOUND;
      throw error;
    }
    const viewed = await tx.$executeRaw`UPDATE "pos_public_receipt_tokens" SET "view_count" = "view_count" + 1, "first_viewed_at" = COALESCE("first_viewed_at", NOW()), "last_viewed_at" = NOW() WHERE "id" = ${link.id} AND "company_id" = ${link.companyId} AND "revoked_at" IS NULL AND "expires_at" > NOW()`;
    if (viewed !== 1) throw PUBLIC_RECEIPT_NOT_FOUND;
    const url = publicUrl(raw);
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    receipt.receiptDocument.digital = { qrDataUrl, label: 'Digital receipt' };
    return receipt;
  });
}

async function receiptPdfBuffer(receiptDocument) {
  const chunks = [];
  const document = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Receipt ${receiptDocument.receipt.number || ''}`, Author: receiptDocument.business.name || 'POS' } });
  document.on('data', (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  const width = document.page.width - document.page.margins.left - document.page.margins.right;
  const left = document.page.margins.left;
  // PDFKit keeps its text cursor after positioned column writes. Anchor every
  // normal receipt line to the page margin so a right-aligned amount cannot
  // indent the following item or section.
  const text = (value, options = {}) => document.text(cleanText(value, 500), { x: left, width, ...options });
  const currency = cleanText(receiptDocument.totals?.currency || 'RWF', 8);
  const money = (value) => value == null || !Number.isFinite(Number(value))
    ? '' : `${currency} ${Number(value).toLocaleString('en-RW', { maximumFractionDigits: 0 })}`;
  const amountRow = (label, amount, { bold = false } = {}) => {
    const y = document.y;
    document.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(cleanText(label, 120), left, y, { width: width * 0.62 });
    const labelBottom = document.y;
    document.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(money(amount), left + width * 0.62, y, { width: width * 0.38, align: 'right' });
    document.y = Math.max(labelBottom, document.y, y + 12);
    document.x = left;
  };
  const heading = (label) => document.moveDown(0.45).font('Helvetica-Bold').fontSize(10).text(cleanText(label, 120), { x: left, width });
  const drawQr = async (imageData, payload) => {
    let buffer = receiptImageBuffer(imageData);
    if (!buffer && payload) {
      try { buffer = await QRCode.toBuffer(String(payload), { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' }); } catch { return false; }
    }
    if (!buffer) return false;
    document.moveDown(0.3).image(buffer, (document.page.width - 96) / 2, document.y, { fit: [96, 96], align: 'center' });
    document.y += 102;
    document.x = left;
    return true;
  };

  if (receiptDocument.flags?.isCopy) {
    document.font('Helvetica-Bold').fontSize(13).text(`COPY${receiptDocument.flags.copyNumber ? ` #${receiptDocument.flags.copyNumber}` : ''}`, { width, align: 'center' });
  }
  if (receiptDocument.flags?.receiptType && receiptDocument.flags.receiptType !== 'SALE') {
    document.font('Helvetica-Bold').fontSize(11).text(cleanText(receiptDocument.flags.receiptType.replace(/_/g, ' '), 60), { width, align: 'center' });
  }
  const logo = receiptImageBuffer(receiptDocument.business.logo);
  if (logo) {
    document.image(logo, (document.page.width - 100) / 2, document.y, { fit: [100, 54], align: 'center' });
    document.moveDown(4);
  }
  document.font('Helvetica-Bold').fontSize(18).text(cleanText(receiptDocument.business.name, 120), { width, align: 'center' });
  document.font('Helvetica').fontSize(9);
  [receiptDocument.business.branch, receiptDocument.business.address, receiptDocument.business.phone, receiptDocument.business.tin ? `TIN: ${receiptDocument.business.tin}` : null]
    .filter(Boolean).forEach((value) => text(value, { align: 'center' }));
  if (receiptDocument.header?.note) text(receiptDocument.header.note, { align: 'center' });
  document.moveDown(0.6).font('Helvetica-Bold').fontSize(13).text(`Receipt ${cleanText(receiptDocument.receipt.number)}`, { width });
  document.font('Helvetica').fontSize(9);
  text(receiptDocument.receipt.localDateTime || receiptDocument.receipt.dateTime || '');
  if (receiptDocument.receipt.timeZone) text(`Time zone: ${receiptDocument.receipt.timeZone}`);
  if (receiptDocument.receipt.cashier) text(`Cashier: ${receiptDocument.receipt.cashier}`);
  if (receiptDocument.receipt.register) text(`Register: ${receiptDocument.receipt.register}`);
  if (receiptDocument.receipt.tillType) text(`Till: ${receiptDocument.receipt.tillType}`);
  if (receiptDocument.customer?.name) text(`Customer: ${receiptDocument.customer.name}`);
  if (receiptDocument.customer?.tin) text(`Customer TIN: ${receiptDocument.customer.tin}`);
  heading('Items');
  (receiptDocument.lines || []).forEach((line) => {
    document.font('Helvetica-Bold').fontSize(9).text(cleanText(line.name, 200), { x: left, width });
    document.font('Helvetica').fontSize(8);
    if (line.sku) text(`SKU: ${line.sku}`);
    if (line.barcode) text(`Barcode: ${line.barcode}`);
    if (line.taxClass) text(`Tax class: ${line.taxClass}`);
    text(`${line.quantity ?? ''}${line.unit ? ` ${cleanText(line.unit, 20)}` : ''} x ${money(line.unitPriceRwf)}`);
    if (line.discountRwf) amountRow('Line discount', -Number(line.discountRwf));
    amountRow('Amount', line.totalRwf);
    document.moveDown(0.2);
  });
  heading('Totals');
  amountRow('Subtotal', receiptDocument.totals.subtotalRwf);
  if (receiptDocument.totals.discountRwf) amountRow('Discount', -Number(receiptDocument.totals.discountRwf));
  (receiptDocument.totals.taxes || []).forEach((tax) => {
    amountRow(`${tax.label || tax.code || 'Tax'}${tax.taxableRwf != null ? ` taxable ${money(tax.taxableRwf)}` : ''}`, tax.taxRwf);
  });
  amountRow('Tax total', receiptDocument.totals.taxTotalRwf);
  document.moveDown(0.2).fontSize(13);
  amountRow('TOTAL', receiptDocument.totals.grandTotalRwf, { bold: true });
  document.font('Helvetica').fontSize(9);
  if (receiptDocument.payments?.length) {
    heading('Payments');
    receiptDocument.payments.forEach((payment) => {
      amountRow(`${payment.method}${payment.kind ? ` (${payment.kind})` : ''}`, payment.amountRwf);
      if (payment.reference) text(`Reference: ${payment.reference}`);
    });
  }
  if (receiptDocument.paymentSummary?.amountPaidRwf != null) amountRow('Paid', receiptDocument.paymentSummary.amountPaidRwf);
  if (receiptDocument.paymentSummary?.changeGivenRwf != null) amountRow('Change', receiptDocument.paymentSummary.changeGivenRwf);
  if (receiptDocument.fiscal) {
    heading('Fiscal details');
    for (const [label, value] of [
      ['Fiscal receipt', receiptDocument.fiscal.receiptNumber], ['Fiscal date', receiptDocument.fiscal.receiptDate],
      ['SDC', receiptDocument.fiscal.sdc], ['MRC', receiptDocument.fiscal.mrc], ['Environment', receiptDocument.fiscal.environment],
      ['Status', receiptDocument.fiscal.status], ['Internal data', receiptDocument.fiscal.internalData], ['Signature', receiptDocument.fiscal.signature],
    ]) if (value != null && value !== '') text(`${label}: ${value}`);
    await drawQr(receiptDocument.fiscal.qrData, receiptDocument.fiscal.qrPayload || (String(receiptDocument.fiscal.qrData || '').startsWith('data:image/') ? null : receiptDocument.fiscal.qrData));
  }
  if (receiptDocument.digital) {
    heading(receiptDocument.digital.label || 'Digital receipt');
    await drawQr(receiptDocument.digital.qrDataUrl, receiptDocument.digital.url);
  }
  for (const section of receiptDocument.extension?.sections || []) {
    heading(section.title);
    (section.lines || []).forEach((line) => text(line));
  }
  for (const [key, value] of Object.entries(receiptDocument.extension?.data || {})) {
    if (value == null || typeof value === 'object') continue;
    text(`${key}: ${value}`);
  }
  if (receiptDocument.footer?.note) text(receiptDocument.footer.note, { align: 'center' });
  if (receiptDocument.footer?.returnPolicy) text(receiptDocument.footer.returnPolicy, { align: 'center' });
  document.end();
  return completed;
}

async function auditShare({ companyId, invoiceId, linkId, channel, userId, registerId, req }) {
  await writePosAuditLog({
    companyId, registerId, userId, ip: requestIp(req), event: 'POS_RECEIPT_LINK_SHARED',
    metadata: { invoiceId, linkId, channel },
  });
}

module.exports = {
  PUBLIC_RECEIPT_NOT_FOUND,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  tokenHash,
  loadSavedReceipt,
  createPublicReceiptLink,
  listPublicReceiptLinks,
  revokePublicReceiptLink,
  publicReceiptDocument,
  publicUrl,
  receiptPdfBuffer,
  auditShare,
};

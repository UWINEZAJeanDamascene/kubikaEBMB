const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const ebmService = require('../services/ebmService');
const { prisma } = require('../lib/prisma');
const slowQueryMonitor = require('../utils/slowQueryMonitor');
const { requestIp } = require('../services/posAuditService');
const { createReceiptCopy } = require('../services/posReceiptReprintService');
const { buildPosReceiptDocument } = require('../services/posReceiptDocumentService');
const { resolveReceiptSettings } = require('../services/posReceiptSettingsService');
const {
  extractPayloadTotals,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
  taxTypeLabel,
} = require('../utils/pdfUtils');

async function timedQuery(label, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    slowQueryMonitor.record(label, Date.now() - start);
  }
}

const SUCCESSOR_CHECKOUT = '/api/sales-legacy/direct-sale';
const SUCCESSOR_TILL_OPEN = '/api/tills/open';
const SUCCESSOR_TILL_CLOSE = '/api/tills/close';
const SUCCESSOR_TILL_ACTIVE = '/api/tills/active';
const SUCCESSOR_RECEIPT = '/api/sales-legacy/receipt/:invoiceId';

function setDeprecatedHeaders(res, successorPath) {
  res.set({
    Deprecation: 'true',
    Sunset: 'Sat, 01 Aug 2026 00:00:00 GMT',
    Link: `<${successorPath}>; rel="successor-version"`,
  });
}

function getReceiptUnit(itemName, unit) {
  const normalizedUnit = String(unit || '').trim();
  if (!normalizedUnit) return '';

  const escapedUnit = normalizedUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packageSize = new RegExp(`(?:^|\\s)\\d+(?:\\.\\d+)?\\s*${escapedUnit}(?=$|\\s|[^a-z])`, 'i');
  return packageSize.test(String(itemName || '')) ? '' : normalizedUnit;
}

function gone(res, { code, message, use, successorPath }) {
  setDeprecatedHeaders(res, successorPath);
  return res.status(410).json({
    success: false,
    code,
    message,
    use,
  });
}

/**
 * Legacy checkout is retired. The only supported POS sale path is
 * POST /api/sales-legacy/direct-sale (till session + warehouse + idempotency).
 */
exports.createSale = async (req, res) => gone(res, {
  code: 'POS_CHECKOUT_PATH_RETIRED',
  message: 'POST /api/pos/sale is retired. Complete POS checkouts with POST /api/sales-legacy/direct-sale.',
  use: SUCCESSOR_CHECKOUT,
  successorPath: SUCCESSOR_CHECKOUT,
});

/**
 * Follow-on payments against the retired POS sale API are not supported.
 * Record additional tender through AR receipts or a new sales-legacy checkout.
 */
exports.addPayment = async (req, res) => gone(res, {
  code: 'POS_PAYMENT_PATH_RETIRED',
  message: 'POST /api/pos/sale/:id/pay is retired. Use sales-legacy checkout for POS tender, or AR receipts for invoice collections.',
  use: SUCCESSOR_CHECKOUT,
  successorPath: SUCCESSOR_CHECKOUT,
});

/** Cash drawers are replaced by till sessions (/api/tills). */
exports.openDrawer = async (req, res) => gone(res, {
  code: 'POS_DRAWER_PATH_RETIRED',
  message: 'POST /api/pos/drawer/open is retired. Open a cashier shift with POST /api/tills/open.',
  use: SUCCESSOR_TILL_OPEN,
  successorPath: SUCCESSOR_TILL_OPEN,
});

exports.closeDrawer = async (req, res) => gone(res, {
  code: 'POS_DRAWER_PATH_RETIRED',
  message: 'POST /api/pos/drawer/close is retired. Close the cashier shift with POST /api/tills/close.',
  use: SUCCESSOR_TILL_CLOSE,
  successorPath: SUCCESSOR_TILL_CLOSE,
});

exports.getDrawer = async (req, res) => gone(res, {
  code: 'POS_DRAWER_PATH_RETIRED',
  message: 'GET /api/pos/drawer/:drawerId is retired. Read the active till with GET /api/tills/active.',
  use: SUCCESSOR_TILL_ACTIVE,
  successorPath: SUCCESSOR_TILL_ACTIVE,
});

/**
 * Printable POS receipt (shared by /api/pos/sale/:id/receipt and
 * /api/sales-legacy/receipt/:invoiceId). Accepts either :id or :invoiceId.
 */
exports.getReceipt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoiceId = req.params.invoiceId || req.params.id;
    if (!invoiceId) {
      return res.status(400).json({ success: false, message: 'Invoice id is required' });
    }

    // Thin alias kept for older clients; prefer sales-legacy receipt URL.
    if (req.params.id && !req.params.invoiceId) {
      setDeprecatedHeaders(res, SUCCESSOR_RECEIPT.replace(':invoiceId', invoiceId));
    }

    const invoice = await timedQuery('pos_getReceipt_invoice', () => Invoice.findOne({ _id: invoiceId, company: companyId })
      .populate('client', 'name contact code taxId type digitalReceiptConsent')
      .populate('createdBy', 'name email')
      .populate('lines.product', 'name sku unit ebm'));

    if (!invoice) return res.status(404).json({ success: false, message: 'Sale not found' });

    const [company, tillSettings] = await Promise.all([
      timedQuery('pos_getReceipt_company', () => Company.findById(companyId).lean()),
      timedQuery('pos_getReceipt_settings', () => prisma.$queryRaw`SELECT "pos_receipt_settings" AS settings FROM "system_settings" WHERE "company_id" = ${String(companyId)} LIMIT 1`),
    ]);
    // V2 queue status is the source of truth for what the cashier should see
    // while a signature is pending or held for review. Legacy invoice.ebm
    // remains the fallback for LEGACY registers.
    const v2Submission = req.receiptSubmission || await prisma.ebmSubmissionQueue.findFirst({
      where: {
        companyId: String(companyId), documentType: 'pos', documentId: String(invoiceId),
        salesTyCd: 'N', rcptTyCd: 'S', registerId: { not: null },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const reprintSubmission = v2Submission?.signedAt && v2Submission?.fiscalDataSource && v2Submission?.ebmStatus === 'submitted'
      ? v2Submission : null;
    const register = v2Submission?.registerId
      ? await prisma.posRegister.findFirst({
        where: { id: String(v2Submission.registerId), companyId: String(companyId) },
        select: { name: true, branchId: true },
      })
      : null;
    const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
    const signedFiscalData = reprintSubmission ? extractSaveSalesFiscalData(reprintSubmission.fiscalResponse) : null;
    const storedSignedEbm = reprintSubmission ? {
      ...(invoice.ebm || {}),
      ebmStatus: 'submitted',
      salesPayload: reprintSubmission.payload,
      fiscalDataSource: reprintSubmission.fiscalDataSource,
      v2SubmissionId: reprintSubmission.id,
      environment: reprintSubmission.environment,
      fiscalEnvironment: reprintSubmission.environment,
      rcptNo: signedFiscalData.rcptNo,
      curRcptNo: signedFiscalData.curRcptNo,
      totRcptNo: signedFiscalData.totRcptNo,
      rptNo: signedFiscalData.rptNo,
      rcptDt: signedFiscalData.rcptDt,
      rcptSign: signedFiscalData.rcptSign,
      intrlData: signedFiscalData.intrlData,
      sdcId: signedFiscalData.sdcId,
      mrcNo: signedFiscalData.mrcNo,
    } : v2Submission ? {
      ...(invoice.ebm || {}),
      ebmStatus: v2Submission.ebmStatus,
      environment: v2Submission.environment,
      fiscalEnvironment: v2Submission.environment,
      fiscalDataSource: v2Submission.fiscalDataSource || null,
      v2SubmissionId: v2Submission.id,
      salesPayload: v2Submission.payload,
      fiscalError: v2Submission.lastError || null,
    } : invoice.ebm;
    const fiscalMode = String(storedSignedEbm?.fiscalEnvironment || storedSignedEbm?.environment || storedSignedEbm?.mode || ebmService.getConfig().mode || '').toLowerCase();
    const qrPng = fiscalMode === 'production' && storedSignedEbm?.ebmStatus === 'submitted'
      ? await generateQrPng(storedSignedEbm, { width: 110 })
      : null;
    const data = invoice.toObject({ virtuals: true });
    data.ebm = storedSignedEbm || {};
    data.ebm.environment = data.ebm.fiscalEnvironment || data.ebm.environment || fiscalMode || null;
    data.ebm.fiscalEnvironment = data.ebm.fiscalEnvironment || fiscalMode || null;
    const ebmStatus = data.ebm.ebmStatus || 'not_submitted';
    data.companyReceipt = {
      name: company?.name || 'Company',
      // A company registration number is not a taxpayer identification number.
      // Never print it under the TIN label when the actual TIN is missing.
      tin: company?.tax_identification_number || '',
      address: typeof company?.address === 'string'
        ? company.address
        : [company?.address?.street, company?.address?.city, company?.address?.country].filter(Boolean).join(', '),
      phone: company?.phone || '',
      logo: company?.logo_url || '',
    };
    data.receiptSettings = resolveReceiptSettings(
      tillSettings?.[0]?.settings,
      register?.branchId || invoice.warehouseId || null,
    );
    data.receiptSettings.logoUrl ||= data.companyReceipt.logo;
    data.receiptPrintedAt = new Date();
    data.copyAvailable = Boolean(reprintSubmission?.signedAt && reprintSubmission?.fiscalDataSource && signedFiscalData?.rcptSign && signedFiscalData?.rcptNo);
    data.receiptCopy = req.receiptCopy ? {
      isCopy: true,
      label: 'COPY',
      copyNumber: Number(req.receiptCopy.copyNumber),
      printedAt: req.receiptCopy.createdAt,
      replayed: Boolean(req.receiptCopyReplay),
    } : null;
    data.discountAmount = Number(data.totalDiscount) || 0;
    data.discountAmountRwf = formatRwf(data.discountAmount);
    data.promotionLabel = data.posPromotion?.name || data.posPromotion?.code || null;
    data.receiptLines = (data.items || data.lines || []).map((line, index) => {
      const tax = lineTaxDetails(line);
      const pricingLine = data.posPricingSnapshot?.lines?.[index];
      const fiscalLine = data.ebm?.salesPayload?.itemList?.[index] || {};
      const itemName = line.product?.name || line.productName || line.description || 'Item';
      return {
        itemName: (reprintSubmission && fiscalLine.itemNm) || itemName,
        itemCode: fiscalLine.itemCd || line.productCode || line.product?.sku || null,
        taxClassCode: fiscalLine.itemClsCd || line.product?.ebm?.itemClsCd || null,
        barcode: fiscalLine.bcd || line.product?.barcode || null,
        packageUnitCode: fiscalLine.pkgUnitCd || null,
        packageQuantity: fiscalLine.pkg ?? null,
        quantityUnitCode: fiscalLine.qtyUnitCd || null,
        taxTypeCode: fiscalLine.taxTyCd || tax.taxTyCd || null,
        supplyAmount: fiscalLine.splyAmt ?? null,
        discountRate: fiscalLine.dcRt ?? null,
        discountAmount: fiscalLine.dcAmt ?? null,
        insuranceCode: fiscalLine.isrccCd || null,
        insuranceName: fiscalLine.isrccNm || null,
        insuranceRate: fiscalLine.isrccRt ?? null,
        insuranceAmount: fiscalLine.isrccAmt ?? null,
        quantity: reprintSubmission && fiscalLine.qty != null ? fiscalLine.qty : (line.quantity || line.qty || 0),
        unit: getReceiptUnit(itemName, line.unit || line.product?.unit),
        unitPriceRwf: formatRwf(reprintSubmission && fiscalLine.prc != null ? fiscalLine.prc : line.unitPrice),
        discountPercent: Number(line.discountPct) || 0,
        discountReason: line.discountReason || null,
        discountAmountRwf: formatRwf(reprintSubmission && fiscalLine.dcAmt != null
          ? fiscalLine.dcAmt
          : pricingLine?.totalDiscountRwf ?? (Number(line.lineSubtotal) || 0) * (Number(line.discountPct) || 0) / 100),
        taxType: tax.taxTyCd,
        taxRate: fiscalLine.taxRt ?? line.taxRate ?? null,
        taxTypeLabel: tax.taxTypeLabel,
        taxableAmountRwf: reprintSubmission && fiscalLine.taxblAmt != null ? formatRwf(fiscalLine.taxblAmt) : (tax.taxableAmount == null ? 'Not recorded' : formatRwf(tax.taxableAmount)),
        vatAmountRwf: reprintSubmission && fiscalLine.taxAmt != null ? formatRwf(fiscalLine.taxAmt) : (tax.vatAmount == null ? 'Not recorded' : formatRwf(tax.vatAmount)),
        lineTotalRwf: reprintSubmission && fiscalLine.totAmt != null ? formatRwf(fiscalLine.totAmt) : (tax.lineTotal == null ? 'Not recorded' : formatRwf(tax.lineTotal)),
      };
    });
    const salesPayload = data.ebm.salesPayload || {};
    data.rraBranchId = salesPayload.bhfId || null;
    data.rraInvoiceNo = salesPayload.invcNo == null ? null : String(salesPayload.invcNo);
    data.rraOriginalInvoiceNo = salesPayload.orgInvcNo == null ? null : String(salesPayload.orgInvcNo);
    data.rraPurchaseCode = salesPayload.prcOrdCd || null;
    data.rraSalesTypeCode = salesPayload.salesTyCd || null;
    data.rraReceiptTypeCode = salesPayload.rcptTyCd || null;
    data.rraPaymentTypeCode = salesPayload.pmtTyCd || null;
    data.rraInvoiceStatusCode = salesPayload.salesSttsCd || null;
    data.rraPurchaseAccepted = salesPayload.prchrAcptcYn || null;
    data.rraValidatedAt = salesPayload.cfmDt || null;
    data.rraSaleDate = salesPayload.salesDt || null;
    data.rraCustomerPhone = salesPayload.receipt?.custMblNo || data.client?.contact?.phone || null;
    const totals = extractPayloadTotals(data.ebm, data);
    data.rraTotals = {
      taxableByType: ['A', 'B', 'C', 'D']
        .map((code) => ({ code, rate: totals[`taxRt${code}`], label: taxTypeLabel(code, totals[`taxRt${code}`]), amount: totals[`taxblAmt${code}`], amountRwf: formatRwf(totals[`taxblAmt${code}`]), taxAmount: totals[`taxAmt${code}`], taxAmountRwf: formatRwf(totals[`taxAmt${code}`]) }))
        .filter((row) => Math.round(Math.abs(row.amount)) !== 0),
      totalTaxableAmountRwf: formatRwf(totals.totTaxblAmt),
      totalVatRwf: formatRwf(totals.totTaxAmt),
      grandTotalRwf: formatRwf(totals.totAmt),
    };
    const recordedChangePayments = (data.payments || []).filter((payment) => payment.changeGiven != null);
    const recordedChange = recordedChangePayments.length
      ? recordedChangePayments.reduce((sum, payment) => sum + (Number(payment.changeGiven) || 0), 0)
      : null;
    data.paymentReceipt = {
      methods: (data.payments || []).filter((payment) => Number(payment.amount) > 0).map((payment) => ({
        method: String(payment.paymentMethod || 'cash').replace(/_/g, ' '),
        amountRwf: formatRwf(payment.amount),
        reference: payment.reference || null,
      })),
      amountPaidRwf: formatRwf(data.amountPaid),
      changeGivenRwf: recordedChange == null ? null : formatRwf(recordedChange),
    };
    data.ebm.rcptNoDisplay = data.ebm.rcptNo == null ? null : String(data.ebm.rcptNo);
    data.ebm.rcptDtDisplay = data.ebm.rcptDt ? formatReceiptDate(data.ebm.rcptDt) : null;
    data.ebm.intrlDataDisplay = data.ebm.intrlData || null;
    data.ebm.rcptSignDisplay = data.ebm.rcptSign || null;
    data.ebm.qrCodeDataUrl = qrPng ? `data:image/png;base64,${qrPng.toString('base64')}` : null;
    data.ebm.qrPlaceholder = qrPng || ebmStatus === 'submitted' ? null : 'No RRA QR response';
    data.customerTinDisplay = data.customerTin || data.client?.taxId || null;
    data.registerName = register?.name || data.registerName || null;
    data.receiptDocument = buildPosReceiptDocument(data, {
      registerName: data.registerName || null,
      tillType: data.tillType || 'retail',
    });

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.reprintReceipt = async (req, res, next) => {
  try {
    const companyId = req.user?.company?._id || req.user?.companyId;
    const actorUserId = req.posAuthContext?.user?.id || req.user?._id || req.user?.id;
    const invoiceId = req.params.invoiceId;
    const sessionCompanyId = req.posAuthContext?.company?.id;
    const sessionRegisterId = req.posAuthContext?.session?.registerId;
    if (sessionCompanyId && String(sessionCompanyId) !== String(companyId)) {
      return res.status(403).json({ success: false, code: 'POS_RECEIPT_COMPANY_MISMATCH', message: 'This POS session cannot reprint receipts for another company.' });
    }
    if (req.body?.registerId && sessionRegisterId && String(req.body.registerId) !== String(sessionRegisterId)) {
      return res.status(403).json({ success: false, code: 'POS_RECEIPT_REGISTER_MISMATCH', message: 'This POS session cannot reprint receipts for another register.' });
    }
    const idempotencyKey = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
    const result = await createReceiptCopy({
      companyId, invoiceId, actorUserId, idempotencyKey,
      reason: req.body?.reason,
      registerId: sessionRegisterId || req.body?.registerId || null,
      reqIp: requestIp(req),
    });
    req.receiptSubmission = result.submission;
    req.receiptCopy = result.reprint;
    req.receiptCopyReplay = result.replayed;
    return exports.getReceipt(req, res, next);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

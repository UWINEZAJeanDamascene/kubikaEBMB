const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const ebmService = require('../services/ebmService');
const slowQueryMonitor = require('../utils/slowQueryMonitor');
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
      .populate('client', 'name contact code taxId type')
      .populate('createdBy', 'name email')
      .populate('lines.product', 'name sku unit ebm'));

    if (!invoice) return res.status(404).json({ success: false, message: 'Sale not found' });

    const company = await timedQuery('pos_getReceipt_company', () => Company.findById(companyId).lean());
    const fiscalMode = String(invoice.ebm?.fiscalEnvironment || invoice.ebm?.environment || invoice.ebm?.mode || ebmService.getConfig().mode || '').toLowerCase();
    const qrPng = fiscalMode === 'production' && invoice.ebm?.ebmStatus === 'submitted'
      ? await generateQrPng(invoice.ebm, { width: 110 })
      : null;
    const data = invoice.toObject({ virtuals: true });
    data.ebm = data.ebm || {};
    data.ebm.environment = data.ebm.fiscalEnvironment || data.ebm.environment || fiscalMode || null;
    data.ebm.fiscalEnvironment = data.ebm.fiscalEnvironment || fiscalMode || null;
    const ebmStatus = data.ebm.ebmStatus || 'not_submitted';
    data.companyReceipt = {
      name: company?.name || 'Company',
      tin: company?.tax_identification_number || company?.registration_number || '',
      address: typeof company?.address === 'string'
        ? company.address
        : [company?.address?.street, company?.address?.city, company?.address?.country].filter(Boolean).join(', '),
      phone: company?.phone || '',
    };
    data.receiptPrintedAt = new Date();
    data.discountAmount = Number(data.totalDiscount) || 0;
    data.discountAmountRwf = formatRwf(data.discountAmount);
    data.promotionLabel = data.posPromotion?.name || data.posPromotion?.code || null;
    data.receiptLines = (data.items || data.lines || []).map((line, index) => {
      const tax = lineTaxDetails(line);
      const fiscalLine = data.ebm?.salesPayload?.itemList?.[index] || {};
      const itemName = line.product?.name || line.productName || line.description || 'Item';
      return {
        itemName,
        itemCode: fiscalLine.itemCd || line.productCode || line.product?.sku || null,
        taxClassCode: fiscalLine.itemClsCd || line.product?.ebm?.itemClsCd || null,
        quantity: line.quantity || line.qty || 0,
        unit: getReceiptUnit(itemName, line.unit || line.product?.unit),
        unitPriceRwf: formatRwf(line.unitPrice),
        taxType: tax.taxTyCd,
        taxRate: fiscalLine.taxRt ?? line.taxRate ?? null,
        taxTypeLabel: tax.taxTypeLabel,
        taxableAmountRwf: tax.taxableAmount == null ? 'Not recorded' : formatRwf(tax.taxableAmount),
        vatAmountRwf: tax.vatAmount == null ? 'Not recorded' : formatRwf(tax.vatAmount),
        lineTotalRwf: tax.lineTotal == null ? 'Not recorded' : formatRwf(tax.lineTotal),
      };
    });
    const salesPayload = data.ebm.salesPayload || {};
    data.rraBranchId = salesPayload.bhfId || null;
    data.rraInvoiceNo = salesPayload.invcNo == null ? null : String(salesPayload.invcNo);
    data.rraOriginalInvoiceNo = salesPayload.orgInvcNo == null ? null : String(salesPayload.orgInvcNo);
    data.rraPurchaseCode = salesPayload.prcOrdCd || null;
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
    data.paymentReceipt = {
      methods: (data.payments || []).filter((payment) => Number(payment.amount) > 0).map((payment) => ({
        method: String(payment.paymentMethod || 'cash').replace(/_/g, ' '),
        amountRwf: formatRwf(payment.amount),
        reference: payment.reference || null,
      })),
      amountPaidRwf: formatRwf(data.amountPaid),
      changeGivenRwf: formatRwf((data.payments || []).reduce((sum, payment) => sum + (Number(payment.changeGiven) || 0), 0)
        || Math.max(0, Number(data.amountPaid || 0) - Number(data.grandTotal || data.totalAmount || 0))),
    };
    data.ebm.rcptNoDisplay = data.ebm.rcptNo == null ? null : String(data.ebm.rcptNo);
    data.ebm.rcptDtDisplay = data.ebm.rcptDt ? formatReceiptDate(data.ebm.rcptDt) : null;
    data.ebm.intrlDataDisplay = data.ebm.intrlData || null;
    data.ebm.rcptSignDisplay = data.ebm.rcptSign || null;
    data.ebm.qrCodeDataUrl = qrPng ? `data:image/png;base64,${qrPng.toString('base64')}` : null;
    data.ebm.qrPlaceholder = qrPng || ebmStatus === 'submitted' ? null : 'No RRA QR response';
    data.customerTinDisplay = data.customerTin || data.client?.taxId || null;

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

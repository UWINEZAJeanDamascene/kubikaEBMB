'use strict';

const VERSION = 1;
const TIME_ZONE = 'Africa/Kigali';

function valueOf(value) {
  if (value == null) return null;
  if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
  return value;
}

function currencyFractionDigits(currencyCode = 'RWF') {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: String(currencyCode || 'RWF').toUpperCase() })
      .resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

function savedMoney(value, currencyCode = 'RWF') {
  if (value == null || value === '') return null;
  const raw = valueOf(value);
  const match = typeof raw === 'number' ? null : String(raw).match(/-?(?:\d[\d,]*)(?:\.\d+)?/);
  if (typeof raw !== 'number' && !match) return null;
  const number = typeof raw === 'number' ? raw : Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** currencyFractionDigits(currencyCode);
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function printableDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function selectTemplate(tillType) {
  const key = String(tillType || 'retail').trim().toLowerCase();
  // Other till templates can provide their own extension without changing the core receipt shape.
  return key === 'retail' ? 'retail' : key;
}

function buildRetailExtension(sale) {
  return {
    template: 'retail',
    data: {
      warehouseName: sale.warehouseName || null,
    },
  };
}

function buildRestaurantExtension(sale) {
  const details = [
    sale.tableNumber ? `Table: ${sale.tableNumber}` : null,
    sale.guestCount != null ? `Guests: ${sale.guestCount}` : null,
    sale.serviceType ? `Service: ${sale.serviceType}` : null,
  ].filter(Boolean);
  return {
    template: 'restaurant',
    data: {
      tableNumber: sale.tableNumber || null,
      guestCount: sale.guestCount == null ? null : Number(sale.guestCount),
      serviceType: sale.serviceType || null,
    },
    sections: details.length ? [{ title: 'Order details', lines: details }] : [],
  };
}

const tillTemplates = new Map([
  ['retail', buildRetailExtension],
  ['restaurant', buildRestaurantExtension],
]);

function registerPosReceiptTemplate(tillType, extensionBuilder) {
  const key = String(tillType || '').trim().toLowerCase();
  if (!key || key === 'retail' || typeof extensionBuilder !== 'function') {
    throw new TypeError('Provide a non-retail till type and an extension builder.');
  }
  const previousBuilder = tillTemplates.get(key);
  tillTemplates.set(key, extensionBuilder);
  return () => {
    if (previousBuilder) tillTemplates.set(key, previousBuilder);
    else tillTemplates.delete(key);
  };
}

/**
 * Build the versioned receipt contract from a server-side saved-sale snapshot.
 * It is a projection only: monetary values are copied from saved sale/tax/payment
 * fields and are never calculated from the receipt lines.
 */
function buildPosReceiptDocument(sale, context = {}) {
  if (!sale || typeof sale !== 'object') throw new TypeError('A saved sale snapshot is required.');
  const settings = sale.receiptSettings && typeof sale.receiptSettings === 'object' ? sale.receiptSettings : {};
  const lines = Array.isArray(sale.receiptLines) ? sale.receiptLines : [];
  const savedTaxes = Array.isArray(sale.rraTotals?.taxableByType)
    ? sale.rraTotals.taxableByType
    : Array.isArray(sale.taxSummary) ? sale.taxSummary : [];
  const payments = Array.isArray(sale.paymentReceipt?.methods)
    ? sale.paymentReceipt.methods
    : Array.isArray(sale.payments) ? sale.payments.map((payment) => ({
      method: payment.paymentMethod || payment.method || 'cash',
      amountRwf: payment.amount,
      reference: payment.reference || null,
    })) : [];
  const ebm = sale.ebm && typeof sale.ebm === 'object' ? sale.ebm : {};
  const currency = sale.currencyCode || sale.currency || 'RWF';
  const voucherRedemptions = Array.isArray(sale.posPricingSnapshot?.voucherRedemptions)
    ? sale.posPricingSnapshot.voucherRedemptions
    : [];
  const fiscal = {};
  const fiscalFields = {
    receiptNumber: ebm.rcptNoDisplay ?? ebm.rcptNo,
    receiptDate: ebm.rcptDtDisplay ?? ebm.rcptDt,
    signature: ebm.rcptSignDisplay ?? ebm.rcptSign,
    qrData: ebm.qrCodeDataUrl ?? ebm.qrCodeData ?? null,
    qrPayload: ebm.qrPayload ?? null,
    qrRaster: ebm.qrRaster ?? null,
    internalData: ebm.intrlDataDisplay ?? ebm.intrlData,
    mrc: ebm.mrcNo,
    sdc: ebm.sdcId,
    environment: ebm.environment ?? ebm.fiscalEnvironment,
    status: ebm.ebmStatus,
  };
  for (const [key, value] of Object.entries(fiscalFields)) if (value != null && value !== '') fiscal[key] = value;

  const customerAllowed = settings.showCustomer !== false;
  const customerName = sale.client?.name || sale.clientInfo?.name || sale.customerName || null;
  const customerTin = sale.customerTin || sale.client?.taxId || null;
  const isCopy = Boolean(sale.receiptCopy?.isCopy);
  const rawReceiptType = String(sale.receiptType || sale.documentType || '').toUpperCase();
  const receiptType = ['SALE', 'REFUND', 'CREDIT_PAYMENT', 'GIFT_CARD'].includes(rawReceiptType)
    ? rawReceiptType : (sale.isRefund ? 'REFUND' : 'SALE');
  const createdAt = sale.createdAt || sale.date || sale.invoiceDate || null;
  const business = sale.companyReceipt || {};
  const cashier = sale.cashier || sale.createdBy || {};
  const selectedTillType = selectTemplate(context.tillType || sale.tillType);

  return {
    version: VERSION,
    business: {
      name: business.name || 'Company',
      branch: business.branch || sale.branchName || null,
      address: business.address || null,
      phone: business.phone || null,
      tin: business.tin || null,
      logo: settings.logoUrl || business.logo || null,
    },
    receipt: {
      number: sale.invoiceNumber || sale.referenceNo || sale._id || sale.id || null,
      dateTime: isoDate(createdAt),
      localDateTime: printableDateTime(createdAt),
      timeZone: TIME_ZONE,
      cashier: settings.showCashier === false ? null : (cashier.name || sale.cashierName || null),
      register: context.registerName || sale.registerName || null,
      tillType: selectedTillType,
    },
    lines: lines.map((line) => ({
      name: String(line.itemName || line.name || 'Item'),
      quantity: line.quantity == null ? null : Number(valueOf(line.quantity)),
      unit: line.unit || null,
      unitPriceRwf: savedMoney(line.unitPriceRwf ?? line.unitPrice, currency),
      discountRwf: savedMoney(line.discountAmountRwf ?? line.discountAmount ?? line.discountRwf, currency),
      discountPercent: line.discountPercent == null ? null : Number(line.discountPercent),
      discountReason: line.discountReason || null,
      totalRwf: savedMoney(line.lineTotalRwf ?? line.lineTotal ?? line.totalRwf, currency),
      sku: settings.showSku === true ? (line.itemCode || line.sku || null) : null,
      barcode: settings.showBarcode === true ? (line.barcode || null) : null,
      taxClass: line.taxClassCode || line.taxTypeCode || line.taxType || null,
    })),
    totals: {
      currency,
      subtotalRwf: savedMoney(sale.subtotal, currency),
      discountRwf: savedMoney(sale.discountAmountRwf ?? sale.discountAmount ?? sale.totalDiscount, currency),
      totalSavedRwf: savedMoney(sale.discountAmountRwf ?? sale.discountAmount ?? sale.totalDiscount, currency),
      voucherDiscountRwf: savedMoney(
        voucherRedemptions.reduce((sum, voucher) => sum + (Number(voucher.amountRwf) || 0), 0),
        currency,
      ),
      vouchers: voucherRedemptions.map((voucher) => ({
        name: String(voucher.name || 'Voucher'),
        code: String(voucher.maskedCode || 'Voucher'),
        discountRwf: savedMoney(voucher.amountRwf, currency),
      })),
      taxes: savedTaxes.map((tax) => ({
        code: tax.code || tax.taxClass || null,
        label: tax.label || tax.taxTypeLabel || null,
        taxableRwf: savedMoney(tax.amountRwf ?? tax.amount ?? tax.taxableAmount, currency),
        taxRwf: savedMoney(tax.taxAmountRwf ?? tax.taxAmount, currency),
      })),
      taxTotalRwf: savedMoney(sale.totalTax ?? sale.taxAmount ?? sale.rraTotals?.totalVatRwf, currency),
      grandTotalRwf: savedMoney(sale.grandTotal ?? sale.totalAmount ?? sale.rraTotals?.grandTotalRwf, currency),
    },
    payments: payments.map((payment) => ({
      method: String(payment.method || payment.paymentMethod || 'cash'),
      amountRwf: savedMoney(payment.amountRwf ?? payment.amount, currency),
      reference: payment.reference || null,
      kind: payment.kind || null,
    })),
    paymentSummary: {
      amountPaidRwf: savedMoney(sale.amountPaid ?? sale.paymentReceipt?.amountPaidRwf, currency),
      changeGivenRwf: savedMoney(sale.changeGiven ?? sale.changeGivenRwf ?? sale.paymentReceipt?.changeGivenRwf, currency),
    },
    customer: customerAllowed && (customerName || customerTin) ? {
      name: customerName,
      tin: customerTin,
    } : null,
    fiscal: Object.keys(fiscal).length ? fiscal : null,
    header: { note: settings.headerNote || null },
    footer: {
      note: settings.footerNote || null,
      returnPolicy: settings.returnPolicy || null,
    },
    flags: {
      isCopy,
      copyNumber: isCopy ? Number(sale.receiptCopy.copyNumber) || null : null,
      receiptType,
    },
    extension: tillTemplates.has(selectedTillType)
      ? tillTemplates.get(selectedTillType)(sale)
      : { template: selectedTillType, data: {} },
  };
}

module.exports = { VERSION, TIME_ZONE, buildPosReceiptDocument, registerPosReceiptTemplate };

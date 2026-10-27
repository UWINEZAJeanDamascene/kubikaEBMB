const QRCode = require("qrcode");

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatRwf(value) {
  return formatMoney(value, "RWF");
}

function formatMoney(value, currency = "RWF") {
  const currencyCode = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase())
    ? String(currency).toUpperCase()
    : "RWF";
  return `${currencyCode} ${toNumber(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatReceiptDate(value) {
  if (!value) return "N/A";
  const raw = String(value).trim();
  const vsdc = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (vsdc) {
    const [, year, month, day, hour, minute] = vsdc;
    return `${day}/${month}/${year} ${hour}:${minute}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function taxTypeLabel(code, rate = null) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return "Tax class not recorded";
  const parsedRate = rate == null || rate === "" ? null : toNumber(rate, null);
  return `Tax class ${normalized}${parsedRate == null ? "" : ` (${parsedRate.toFixed(2)}%)`}`;
}

function buildQrContent(ebm = {}) {
  return ebm.qrCode || [ebm.rcptSign, ebm.intrlData, ebm.rcptNo, ebm.rcptDt].filter(Boolean).join("|");
}

async function generateQrPng(ebm = {}, options = {}) {
  const content = buildQrContent(ebm);
  if (!content || !ebm.rcptSign || !ebm.intrlData) return null;
  return QRCode.toBuffer(content, { margin: 1, width: options.width || 100 });
}

function certificationValue(ebm = {}, field, pendingText = "Pending", failedText = "Not Certified") {
  const status = ebm.ebmStatus || "not_submitted";
  if (status === "submitted") return ebm[field] || "N/A";
  if (status === "failed") return failedText;
  if (status === "pending") return pendingText;
  return "Not submitted";
}

function drawQrPlaceholder(doc, x, y, size, label) {
  doc.rect(x, y, size, size).fillAndStroke("#f1f5f9", "#cbd5e1");
  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(7);
  doc.text(label, x + 4, y + size / 2 - 4, { width: size - 8, align: "center" });
}

function drawEbmCertificationBlock(doc, {
  x = 50,
  y,
  width = doc.page.width - 100,
  ebm = {},
  qrPng = null,
  title = "FISCAL RECEIPT DETAILS",
  receiptDateFormatter = (value) => value || "N/A",
  originalReceiptNo = null,
} = {}) {
  const status = ebm.ebmStatus || "not_submitted";
  const qrSize = 78;
  const height = originalReceiptNo ? 184 : 166;
  const textWidth = width - qrSize - 132;
  const receiptNo = certificationValue(ebm, "rcptNo", "Pending RRA Certification");
  const receiptDate = status === "submitted" ? receiptDateFormatter(ebm.rcptDt) : certificationValue(ebm, "rcptDt");
  const intrlData = certificationValue(ebm, "intrlData");
  const rcptSign = certificationValue(ebm, "rcptSign");

  doc.roundedRect(x, y, width, height, 8).fillAndStroke("#ffffff", "#dbe4ee");
  doc.roundedRect(x, y, width, 32, 8).fill("#eef5f8");
  doc.rect(x, y + 22, width, 10).fill("#eef5f8");
  const mode = String(ebm.mode || ebm.environment || ebm.fiscalEnvironment || "").toLowerCase();
  const fiscalLabel = mode === "mock"
    ? "MOCK RESPONSE - NOT RRA CERTIFIED"
    : mode === "sandbox"
      ? "SANDBOX RESPONSE - NOT PRODUCTION CERTIFIED"
      : mode === "production" && status === "submitted"
        ? "RRA FISCAL RESPONSE ACCEPTED"
        : status === "submitted"
          ? "FISCAL RESPONSE - ENVIRONMENT UNVERIFIED"
          : status === "failed"
            ? "RRA FISCAL SUBMISSION FAILED"
            : "RRA FISCAL SUBMISSION PENDING";
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9.5).text(title, x + 12, y + 10);
  const badgeColor = mode === "mock" || mode === "sandbox" ? "#a16207" : status === "failed" ? "#b91c1c" : mode === "production" && status === "submitted" ? "#0f766e" : "#475569";
  doc.font("Helvetica-Bold").fontSize(7).fillColor(badgeColor);
  doc.text(fiscalLabel, x + width / 2, y + 11, { width: width / 2 - 14, align: "right" });

  const fiscalRows = [
    ["Receipt no", receiptNo],
    ["Receipt date", receiptDate],
    ["SDC ID", certificationValue(ebm, "sdcId")],
    ["MRC no", certificationValue(ebm, "mrcNo")],
    ["Receipt counter", `${certificationValue(ebm, "curRcptNo")} / ${certificationValue(ebm, "totRcptNo")}`],
    ["Report no", certificationValue(ebm, "rptNo")],
  ];
  fiscalRows.forEach(([label, value], index) => {
    const rowY = y + 40 + index * 13;
    doc.font("Helvetica").fontSize(7.5).fillColor("#64748b").text(`${label}:`, x + 12, rowY, { width: 76 });
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#1e293b").text(String(value), x + 88, rowY, { width: textWidth - 76 });
  });
  doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text("Internal data", x + 12, y + 122, { width: 72 });
  doc.font("Helvetica").fontSize(6.5).fillColor("#334155").text(intrlData, x + 88, y + 122, { width: textWidth - 76, height: 10, ellipsis: true });
  doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text("Receipt signature", x + 12, y + 136, { width: 76 });
  doc.font("Courier").fontSize(6).fillColor("#334155").text(rcptSign, x + 88, y + 136, { width: textWidth - 76, height: 10, ellipsis: true });
  if (originalReceiptNo) {
    doc.font("Helvetica").fontSize(6.5).fillColor("#64748b").text(`Original receipt no: ${originalReceiptNo}`, x + 12, y + 154, { width: textWidth });
  }

  const qrX = x + width - qrSize - 14;
  const qrY = y + 47;
  if (qrPng && status === "submitted" && mode === "production") {
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  } else {
    const placeholder = mode === "mock" ? "MOCK ONLY" : mode === "sandbox" ? "SANDBOX ONLY" : status === "failed" ? "Not Certified" : "QR Pending";
    drawQrPlaceholder(doc, qrX, qrY, qrSize, placeholder);
  }
  return y + height;
}

function extractPayloadTotals(ebm = {}, fallback = {}) {
  const payload = ebm.salesPayload || ebm.rraPayload || {};
  return {
    taxblAmtA: toNumber(payload.taxblAmtA, fallback.taxblAmtA),
    taxblAmtB: toNumber(payload.taxblAmtB, fallback.taxblAmtB),
    taxblAmtC: toNumber(payload.taxblAmtC, fallback.taxblAmtC),
    taxblAmtD: toNumber(payload.taxblAmtD, fallback.taxblAmtD),
    taxAmtA: toNumber(payload.taxAmtA, fallback.taxAmtA),
    taxAmtB: toNumber(payload.taxAmtB, fallback.taxAmtB),
    taxAmtC: toNumber(payload.taxAmtC, fallback.taxAmtC),
    taxAmtD: toNumber(payload.taxAmtD, fallback.taxAmtD),
    taxRtA: toNumber(payload.taxRtA, fallback.taxRtA),
    taxRtB: toNumber(payload.taxRtB, fallback.taxRtB),
    taxRtC: toNumber(payload.taxRtC, fallback.taxRtC),
    taxRtD: toNumber(payload.taxRtD, fallback.taxRtD),
    totTaxblAmt: toNumber(payload.totTaxblAmt, fallback.subtotal),
    totTaxAmt: toNumber(payload.totTaxAmt, fallback.taxAmount || fallback.totalTax),
    totAmt: toNumber(payload.totAmt, fallback.totalAmount || fallback.grandTotal || fallback.total),
  };
}

function drawTaxBreakdown(doc, { x, y, width = 250, ebm = {}, fallback = {}, title = "INVOICE TOTALS", negative = false, discountAmount = 0, discountLabel = "Discount", currency = "RWF", border = true, background = "#ffffff" } = {}) {
  const totals = extractPayloadTotals(ebm, fallback);
  const sign = negative ? -1 : 1;
  const rows = [
    ["A", totals.taxblAmtA, totals.taxAmtA, totals.taxRtA],
    ["B", totals.taxblAmtB, totals.taxAmtB, totals.taxRtB],
    ["C", totals.taxblAmtC, totals.taxAmtC, totals.taxRtC],
    ["D", totals.taxblAmtD, totals.taxAmtD, totals.taxRtD],
  ].filter(([, taxable, tax]) => Math.round(Math.abs(taxable)) !== 0 || Math.round(Math.abs(tax)) !== 0);

  const rowHeight = 18;
  const hasDiscount = toNumber(discountAmount) > 0;
  const height = 72 + rows.length * rowHeight + 48 + (hasDiscount ? rowHeight : 0);
  const wide = width >= 400;
  const classWidth = wide ? 200 : 92;
  const taxableX = wide ? x + 235 : x + 103;
  const taxableWidth = wide ? 115 : 67;
  const taxX = wide ? x + width - 115 : x + width - 65;
  const taxWidth = wide ? 100 : 55;
  const totalValueWidth = wide ? 130 : 100;
  const totalValueX = x + width - totalValueWidth - 10;
  if (border) doc.rect(x, y, width, height).fillAndStroke(background, "#e5e7eb");
  else if (background) doc.rect(x, y, width, height).fill(background);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(title, x + 10, y + 9);
  let cy = y + 29;
  doc.font("Helvetica").fontSize(7).fillColor("#374151");
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#64748b");
  doc.text("TAX CLASS / RATE", x + 10, cy, { width: classWidth });
  doc.text("TAXABLE", taxableX, cy, { width: taxableWidth, align: "right" });
  doc.text("TAX", taxX, cy, { width: taxWidth, align: "right" });
  cy += 13;
  doc.font("Helvetica").fontSize(7).fillColor("#374151");
  rows.forEach(([code, taxable, tax, rate]) => {
    doc.text(taxTypeLabel(code, rate), x + 10, cy, { width: classWidth });
    doc.text(formatMoney(sign * taxable, currency), taxableX, cy, { width: taxableWidth, align: "right" });
    doc.text(formatMoney(sign * tax, currency), taxX, cy, { width: taxWidth, align: "right" });
    cy += rowHeight;
  });
  doc.moveTo(x + 10, cy).lineTo(x + width - 10, cy).strokeColor("#e5e7eb").stroke();
  cy += 8;
  doc.text("Total Taxable Amount:", x + 10, cy, { width: totalValueX - x - 20 });
  doc.text(formatMoney(sign * totals.totTaxblAmt, currency), totalValueX, cy, { width: totalValueWidth, align: "right" });
  cy += rowHeight;
  if (hasDiscount) {
    doc.fillColor("#047857").font("Helvetica-Bold");
    doc.text(discountLabel, x + 10, cy, { width: totalValueX - x - 20 });
    doc.text(formatMoney(-Math.abs(toNumber(discountAmount)), currency), totalValueX, cy, { width: totalValueWidth, align: "right" });
    doc.fillColor("#374151").font("Helvetica");
    cy += rowHeight;
  }
  doc.text("Total Tax:", x + 10, cy, { width: totalValueX - x - 20 });
  doc.text(formatMoney(sign * totals.totTaxAmt, currency), totalValueX, cy, { width: totalValueWidth, align: "right" });
  cy += rowHeight + 2;
  doc.rect(x, cy - 4, width, 28).fill("#111827");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11);
  doc.text(negative ? "AMOUNT REFUNDED" : "GRAND TOTAL", x + 10, cy + 3, { width: totalValueX - x - 20 });
  doc.text(formatMoney(sign * totals.totAmt, currency), totalValueX, cy + 3, { width: totalValueWidth, align: "right" });
  return y + height;
}

function lineTaxDetails(line = {}) {
  const product = line.product || {};
  const ebm = product.ebm || {};
  const rawTaxType = line.taxTyCd || line.taxCode || ebm.taxTyCd || ebm.taxTypeCode || null;
  const taxTyCd = rawTaxType == null ? null : String(rawTaxType).trim().toUpperCase();
  const taxRate = line.taxRt ?? line.taxRate ?? ebm.taxRt ?? ebm.taxRate ?? null;
  const rawLineTotal = line.totAmt ?? line.lineTotal ?? line.totalWithTax;
  const rawVatAmount = line.totTaxAmt ?? line.taxAmt ?? line.lineTax ?? line.taxAmount;
  const rawTaxableAmount = line.taxblAmt ?? line.splyAmt ?? line.lineSubtotal ?? line.subtotal;
  const lineTotal = rawLineTotal == null ? null : toNumber(rawLineTotal);
  const vatAmount = rawVatAmount == null ? null : toNumber(rawVatAmount);
  const taxableAmount = rawTaxableAmount != null
    ? toNumber(rawTaxableAmount)
    : lineTotal != null && vatAmount != null
      ? Math.max(0, lineTotal - vatAmount)
      : null;
  return {
    itemCode: line.itemCd || line.itemCode || line.productCode || product.sku || null,
    itemClassCd: line.itemClsCd || line.itemClassCd || ebm.itemClassCd || ebm.itemClassCode || "N/A",
    taxTyCd,
    taxRate: taxRate == null || taxRate === "" ? null : toNumber(taxRate, null),
    taxTypeLabel: taxTypeLabel(taxTyCd, taxRate),
    taxableAmount,
    vatAmount,
    lineTotal,
    quantityUnitCode: line.qtyUnitCd || line.quantityUnitCode || null,
    packageUnitCode: line.pkgUnitCd || line.packageUnitCode || null,
    packageQuantity: line.pkg ?? null,
    discountAmount: toNumber(line.dcAmt ?? line.discountAmount),
  };
}

module.exports = {
  buildQrContent,
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  extractPayloadTotals,
  formatReceiptDate,
  formatMoney,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
  taxTypeLabel,
  toNumber,
};

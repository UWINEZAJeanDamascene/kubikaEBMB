"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultReceiptLabels = void 0;
exports.renderReceiptMarkup = renderReceiptMarkup;
exports.renderReceiptHtml = renderReceiptHtml;
exports.estimateReceiptPageHeightMm = estimateReceiptPageHeightMm;
exports.transliterateReceiptText = transliterateReceiptText;
exports.wrapReceiptText = wrapReceiptText;
exports.renderReceiptEscPos = renderReceiptEscPos;
exports.renderThermalDocument = renderThermalDocument;
const cp858Characters = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u20ac\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0';
const cp858Bytes = new Map(Array.from(cp858Characters, (character, index) => [character, index + 0x80]));
const cp1252Bytes = new Map(Array.from('\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178', (character, index) => [character, index + 0x80]));
const transliterationMap = {
    '·': '-', '•': '*', '–': '-', '—': '-', '…': '...', '’': "'", '‘': "'",
    '“': '"', '”': '"', 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss', '€': 'EUR',
};
exports.defaultReceiptLabels = {
    copy: 'COPY', customer: 'Customer', taxClass: 'Tax class', discount: 'Discount', totalSaved: 'Total saved', tax: 'Tax', taxable: 'taxable',
    fiscalReceipt: 'Fiscal receipt', receipt: 'Receipt', date: 'Date', cashier: 'Cashier', register: 'Register', tin: 'TIN',
    item: 'Item', amount: 'Amount', subtotal: 'Subtotal', taxTotal: 'Tax total', total: 'Total', payments: 'Payments',
    paid: 'Paid', change: 'Change', signature: 'Signature', digitalReceipt: 'Digital receipt', fiscalQrAlt: 'Fiscal QR code', digitalQrAlt: 'Digital receipt QR code',
};
const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function money(value, currency) {
    if (value == null || !Number.isFinite(Number(value)))
        return '';
    let maximumFractionDigits = 2;
    try {
        maximumFractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency: String(currency || 'RWF').toUpperCase() })
            .resolvedOptions().maximumFractionDigits ?? 2;
    }
    catch {
        // Unknown currency codes retain two decimal places instead of losing cents.
    }
    return `${currency} ${new Intl.NumberFormat('en-RW', { minimumFractionDigits: 0, maximumFractionDigits }).format(Number(value))}`;
}
function renderReceiptMarkup(receipt, labels = exports.defaultReceiptLabels) {
    const currency = receipt.totals.currency || 'RWF';
    const logo = receipt.business.logo ? `<img class="logo" src="${esc(receipt.business.logo)}" alt="" />` : '';
    const copy = receipt.flags.isCopy ? `<div class="copy">${esc(labels.copy)}${receipt.flags.copyNumber ? ` #${esc(receipt.flags.copyNumber)}` : ''}</div>` : '';
    const typeLabel = receipt.flags.receiptType === 'SALE' ? '' : `<p class="document-type">${esc(receipt.flags.receiptType.replace(/_/g, ' '))}</p>`;
    const customer = receipt.customer ? `<section class="meta"><strong>${esc(labels.customer)}</strong>${receipt.customer.name ? `<span>${esc(receipt.customer.name)}</span>` : ''}${receipt.customer.tin ? `<span>${esc(labels.tin)}: ${esc(receipt.customer.tin)}</span>` : ''}</section>` : '';
    const lines = receipt.lines.map((line) => `<tr class="line"><td><strong>${esc(line.name)}</strong>${line.sku ? `<small>${esc(line.sku)}</small>` : ''}${line.taxClass ? `<small>${esc(labels.taxClass)}: ${esc(line.taxClass)}</small>` : ''}${line.quantity != null ? `<small>${esc(line.quantity)}${line.unit ? ` ${esc(line.unit)}` : ''} × ${esc(money(line.unitPriceRwf, currency))}</small>` : ''}</td><td>${esc(money(line.totalRwf, currency))}</td></tr>${line.discountRwf ? `<tr class="detail"><td>${esc(labels.discount)}${line.discountPercent ? ` (${esc(line.discountPercent)}%)` : ''}${line.discountReason ? ` · ${esc(line.discountReason)}` : ''}</td><td>-${esc(money(line.discountRwf, currency))}</td></tr>` : ''}`).join('');
    const taxes = (receipt.totals.taxes || []).map((tax) => `<tr><td>${esc(tax.label || tax.code || labels.tax)}${tax.taxableRwf != null ? ` · ${esc(labels.taxable)} ${esc(money(tax.taxableRwf, currency))}` : ''}</td><td>${esc(money(tax.taxRwf, currency))}</td></tr>`).join('');
    const payments = (receipt.payments || []).map((payment) => `<tr><td>${esc(payment.method)}${payment.reference ? `<small>${esc(payment.reference)}</small>` : ''}</td><td>${esc(money(payment.amountRwf, currency))}</td></tr>`).join('');
    const fiscal = receipt.fiscal ? `<section class="fiscal"><strong>${esc(labels.fiscalReceipt)}</strong>${receipt.fiscal.receiptNumber ? `<span>${esc(labels.receipt)}: ${esc(receipt.fiscal.receiptNumber)}</span>` : ''}${receipt.fiscal.receiptDate ? `<span>${esc(labels.date)}: ${esc(receipt.fiscal.receiptDate)}</span>` : ''}${receipt.fiscal.sdc ? `<span>SDC: ${esc(receipt.fiscal.sdc)}</span>` : ''}${receipt.fiscal.mrc ? `<span>MRC: ${esc(receipt.fiscal.mrc)}</span>` : ''}${receipt.fiscal.environment ? `<span>${esc(receipt.fiscal.environment)}</span>` : ''}${receipt.fiscal.signature ? `<small>${esc(labels.signature)}: ${esc(receipt.fiscal.signature)}</small>` : ''}${receipt.fiscal.qrData?.startsWith('data:image/') ? `<img class="qr" src="${esc(receipt.fiscal.qrData)}" alt="${esc(labels.fiscalQrAlt)}" />` : ''}</section>` : '';
    const extensions = (receipt.extension?.sections || []).map((section) => `<section class="extension"><strong>${esc(section.title)}</strong>${section.lines.map((line) => `<span>${esc(line)}</span>`).join('')}</section>`).join('');
    const digital = receipt.digital ? `<section class="digital"><strong>${esc(receipt.digital.label || labels.digitalReceipt)}</strong>${receipt.digital.qrDataUrl?.startsWith('data:image/') ? `<img class="qr" src="${esc(receipt.digital.qrDataUrl)}" alt="${esc(labels.digitalQrAlt)}" />` : ''}</section>` : '';
    const totalSavedRwf = receipt.totals.totalSavedRwf ?? receipt.totals.discountRwf;
    const voucherBreakdown = (receipt.totals.vouchers || []).map((voucher) => `<tr><td>Voucher ${esc(voucher.name || 'Voucher')} · ${esc(voucher.code)}</td><td>-${esc(money(voucher.discountRwf, currency))}</td></tr>`).join('');
    return `<article class="receipt" data-version="${receipt.version}">${copy}<header>${logo}<h1>${esc(receipt.business.name)}</h1>${typeLabel}${receipt.business.branch ? `<p>${esc(receipt.business.branch)}</p>` : ''}${receipt.business.address ? `<p>${esc(receipt.business.address)}</p>` : ''}${receipt.business.phone ? `<p>${esc(receipt.business.phone)}</p>` : ''}${receipt.business.tin ? `<p>${esc(labels.tin)}: ${esc(receipt.business.tin)}</p>` : ''}${receipt.header?.note ? `<p class="header-note">${esc(receipt.header.note)}</p>` : ''}</header><section class="meta"><span>${esc(labels.receipt)}: ${esc(receipt.receipt.number || '')}</span>${receipt.receipt.localDateTime ? `<span>${esc(receipt.receipt.localDateTime)}${receipt.receipt.timeZone ? ` (${esc(receipt.receipt.timeZone)})` : ''}</span>` : ''}${receipt.receipt.cashier ? `<span>${esc(labels.cashier)}: ${esc(receipt.receipt.cashier)}</span>` : ''}${receipt.receipt.register ? `<span>${esc(labels.register)}: ${esc(receipt.receipt.register)}</span>` : ''}</section>${customer}<table><thead><tr><th>${esc(labels.item)}</th><th>${esc(labels.amount)}</th></tr></thead><tbody>${lines}</tbody></table><table class="totals"><tbody><tr><td>${esc(labels.subtotal)}</td><td>${esc(money(receipt.totals.subtotalRwf, currency))}</td></tr>${voucherBreakdown}${totalSavedRwf ? `<tr><td>${esc(labels.totalSaved || labels.discount)}</td><td>-${esc(money(totalSavedRwf, currency))}</td></tr>` : ''}${taxes}<tr><td>${esc(labels.taxTotal)}</td><td>${esc(money(receipt.totals.taxTotalRwf, currency))}</td></tr><tr class="grand"><td>${esc(labels.total)}</td><td>${esc(money(receipt.totals.grandTotalRwf, currency))}</td></tr></tbody></table>${payments ? `<section><strong>${esc(labels.payments)}</strong><table><tbody>${payments}</tbody></table></section>` : ''}${receipt.paymentSummary?.amountPaidRwf != null ? `<p class="paid">${esc(labels.paid)}: ${esc(money(receipt.paymentSummary.amountPaidRwf, currency))}</p>` : ''}${receipt.paymentSummary?.changeGivenRwf ? `<p class="paid">${esc(labels.change)}: ${esc(money(receipt.paymentSummary.changeGivenRwf, currency))}</p>` : ''}${fiscal}${digital}${extensions}<footer>${receipt.footer?.note ? `<p>${esc(receipt.footer.note)}</p>` : ''}${receipt.footer?.returnPolicy ? `<p>${esc(receipt.footer.returnPolicy)}</p>` : ''}</footer></article>`;
}
function renderReceiptHtml(receipt, paper = 80, labels = exports.defaultReceiptLabels, locale = 'en') {
    const pageSize = paper === 'A4' ? 'A4' : `${paper}mm ${estimateReceiptPageHeightMm(receipt, paper)}mm`;
    const width = paper === 'A4' ? '180mm' : `${paper}mm`;
    const markup = renderReceiptMarkup(receipt, labels);
    return `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Receipt ${esc(receipt.receipt.number || '')}</title><style>@page{size:${pageSize};margin:${paper === 'A4' ? '12mm' : '3mm'}}*{box-sizing:border-box}body{margin:0;color:#111;background:#fff;font:12px/1.45 Arial,sans-serif}.receipt{width:${width};max-width:100%;margin:0 auto;padding:3mm}.receipt header{text-align:center;border-bottom:1px dashed #555;padding-bottom:3mm;margin-bottom:3mm}.receipt h1{font-size:16px;margin:2mm 0}.receipt header p,.meta span,.meta strong,.fiscal span{display:block;margin:1mm 0}.logo{max-width:30mm;max-height:18mm;object-fit:contain}.copy{text-align:center;border:2px solid #111;font-weight:bold;letter-spacing:.2em;padding:2mm;margin-bottom:3mm}.meta,.fiscal,footer{margin:3mm 0}.meta{font-size:11px}table{width:100%;border-collapse:collapse;margin:2mm 0}th,td{text-align:left;padding:1.5mm 0;vertical-align:top}th:last-child,td:last-child{text-align:right;white-space:nowrap}.line td{border-top:1px solid #bbb}.line small,.detail{display:block;color:#444;font-size:10px}.receipt section small{display:block}.detail td{border:0;padding-top:0}.detail td:first-child{padding-right:3mm}.totals{border-top:1px dashed #555}.grand{font-size:14px;font-weight:bold;border-top:1px solid #111}.paid{text-align:right;margin:1mm 0}.fiscal{border-top:1px dashed #555;padding-top:2mm;font-size:10px;overflow-wrap:anywhere}.qr{display:block;width:28mm;height:28mm;object-fit:contain;margin:2mm auto}.receipt footer{text-align:center;border-top:1px dashed #555;padding-top:2mm;font-size:10px} @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.receipt{margin:0 auto}}</style></head><body>${markup}</body></html>`;
}
/**
 * Chromium ignores `@page size: <roll-width> auto` and silently prints on its
 * default paper. Give thermal receipts a content-based page height so browser
 * print and print-to-PDF honor the configured roll width without a fixed long
 * blank tail.
 */
function estimateReceiptPageHeightMm(receipt, paper) {
    const columns = paper === 58 ? 32 : 48;
    const textRows = (value) => {
        const normalized = transliterateReceiptText(value).trim();
        return normalized ? wrapReceiptText(normalized, columns).length : 0;
    };
    let rows = 8; // section headings and minimum vertical spacing
    let sections = 4; // header, item table, totals, footer
    let qrImages = 0;
    const header = [receipt.business.name, receipt.business.branch, receipt.business.address, receipt.business.phone,
        receipt.business.tin ? `${exports.defaultReceiptLabels.tin}: ${receipt.business.tin}` : '', receipt.header?.note];
    rows += header.reduce((sum, value) => sum + textRows(value), 0);
    rows += [receipt.receipt.number, receipt.receipt.localDateTime, receipt.receipt.cashier, receipt.receipt.register]
        .reduce((sum, value) => sum + textRows(value), 0);
    if (receipt.customer) {
        sections += 1;
        rows += 1 + textRows(receipt.customer.name) + textRows(receipt.customer.tin ? `TIN: ${receipt.customer.tin}` : '');
    }
    for (const line of receipt.lines) {
        rows += Math.max(1, textRows(line.name)) + textRows(line.sku) + textRows(line.taxClass ? `Tax class: ${line.taxClass}` : '');
        if (line.quantity != null)
            rows += textRows(`${line.quantity} ${line.unit || ''} x ${money(line.unitPriceRwf, receipt.totals.currency || 'RWF')}`);
        rows += 1; // amount and line total
        if (line.discountRwf)
            rows += 1;
    }
    rows += 2; // subtotal and total tax
    if (receipt.totals.discountRwf)
        rows += 1;
    for (const tax of receipt.totals.taxes || [])
        rows += Math.max(1, textRows(tax.label || tax.code || exports.defaultReceiptLabels.tax)) + 1;
    rows += 1; // grand total
    if (receipt.payments?.length) {
        sections += 1;
        rows += 1 + receipt.payments.reduce((sum, payment) => sum + Math.max(1, textRows(`${payment.method} ${payment.reference || ''}`)), 0);
    }
    if (receipt.paymentSummary?.amountPaidRwf != null)
        rows += 1;
    if (receipt.paymentSummary?.changeGivenRwf)
        rows += 1;
    if (receipt.fiscal) {
        sections += 1;
        rows += 1 + [receipt.fiscal.receiptNumber, receipt.fiscal.receiptDate, receipt.fiscal.sdc, receipt.fiscal.mrc,
            receipt.fiscal.environment, receipt.fiscal.signature].reduce((sum, value) => sum + textRows(value), 0);
        if (receipt.fiscal.qrData?.startsWith('data:image/') || receipt.fiscal.qrRaster)
            qrImages += 1;
    }
    if (receipt.digital) {
        sections += 1;
        rows += 1 + textRows(receipt.digital.label || exports.defaultReceiptLabels.digitalReceipt);
        if (receipt.digital.qrDataUrl?.startsWith('data:image/'))
            qrImages += 1;
    }
    for (const section of receipt.extension?.sections || []) {
        sections += 1;
        rows += textRows(section.title) + section.lines.reduce((sum, line) => sum + textRows(line), 0);
    }
    rows += textRows(receipt.footer?.note) + textRows(receipt.footer?.returnPolicy);
    // Add room for real-world font metrics, browser print margins, and printer
    // scaling differences so a normal receipt does not spill onto a second page.
    return Math.max(120, Math.ceil(62 + rows * 4.2 + sections * 2.5 + qrImages * 31));
}
function transliterateReceiptText(value) {
    return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[·•–—…’‘“”œŒæÆß€]/g, (character) => transliterationMap[character] || '')
        .replace(/[^\x20-\x7e]/g, '');
}
function wrapReceiptText(value, columns) {
    const width = Math.max(1, Math.floor(columns));
    const words = transliterateReceiptText(value).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        if (word.length > width) {
            if (line)
                lines.push(line);
            line = '';
            for (let index = 0; index < word.length; index += width)
                lines.push(word.slice(index, index + width));
        }
        else if (line && `${line} ${word}`.length > width) {
            lines.push(line);
            line = word;
        }
        else
            line = line ? `${line} ${word}` : word;
    }
    if (line)
        lines.push(line);
    return lines;
}
function codePageByte(character, codeTable) {
    const codePoint = character.codePointAt(0) || 0;
    if (codePoint >= 0x20 && codePoint <= 0x7e)
        return codePoint;
    if (codeTable === 19)
        return cp858Bytes.get(character);
    return cp1252Bytes.get(character) ?? (codePoint >= 0xa0 && codePoint <= 0xff ? codePoint : undefined);
}
function normalizeForCodePage(value, codeTable) {
    return Array.from(String(value ?? '').normalize('NFC').replace(/[\r\n\t]+/g, ' '), (character) => {
        if (codePageByte(character, codeTable) != null)
            return character;
        return transliterationMap[character] ?? transliterateReceiptText(character);
    }).join('');
}
function encodeCodePageText(value, codeTable) {
    const bytes = [];
    for (const character of value) {
        const encoded = codePageByte(character, codeTable);
        if (encoded != null)
            bytes.push(encoded);
        else
            bytes.push(...encodeCodePageText(transliterateReceiptText(character), codeTable));
    }
    return new Uint8Array(bytes);
}
function wrapCodePageText(value, columns, codeTable) {
    const width = Math.max(1, Math.floor(columns));
    const words = normalizeForCodePage(value, codeTable).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        if (word.length > width) {
            if (line)
                lines.push(line);
            line = '';
            for (let index = 0; index < word.length; index += width)
                lines.push(word.slice(index, index + width));
        }
        else if (line && `${line} ${word}`.length > width) {
            lines.push(line);
            line = word;
        }
        else
            line = line ? `${line} ${word}` : word;
    }
    if (line)
        lines.push(line);
    return lines;
}
function command(...bytes) { return new Uint8Array(bytes); }
function append(chunks, bytes) { chunks.push(bytes); }
function concatBytes(chunks) {
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}
function amountText(value, currency) { return value == null ? '' : money(value, currency); }
function appendNativeQr(chunks, payload) {
    const data = new TextEncoder().encode(payload);
    const length = data.length + 3;
    append(chunks, command(0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0));
    append(chunks, command(0x1d, 0x28, 0x6b, 3, 0, 49, 67, 6));
    append(chunks, command(0x1d, 0x28, 0x6b, 3, 0, 49, 69, 48));
    append(chunks, command(0x1d, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 49, 80, 48));
    append(chunks, data);
    append(chunks, command(0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48));
}
function appendRasterQr(chunks, raster) {
    const width = Math.floor(raster.width);
    const height = Math.floor(raster.height);
    if (width < 1 || height < 1 || raster.data.length < Math.ceil(width / 8) * height)
        return;
    const rowBytes = Math.ceil(width / 8);
    append(chunks, command(0x1d, 0x76, 0x30, 0, rowBytes & 0xff, (rowBytes >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff));
    append(chunks, raster.data.slice(0, rowBytes * height));
}
function renderReceiptEscPos(receipt, options = {}) {
    const columns = options.columns || (options.paperWidthMm === 58 ? 32 : 42);
    if (!Number.isInteger(columns) || columns < 20 || columns > 80)
        throw new RangeError('Receipt columns must be between 20 and 80.');
    const currency = receipt.totals.currency || 'RWF';
    const labels = options.labels || exports.defaultReceiptLabels;
    const codeTable = Math.max(0, Math.min(255, Math.floor(options.codeTable ?? 16)));
    if (![16, 19].includes(codeTable))
        throw new RangeError('Receipt code page must be Windows-1252 (16) or PC858 (19).');
    const chunks = [];
    const writeLine = (value) => {
        append(chunks, encodeCodePageText(value, codeTable));
        append(chunks, command(0x0a));
    };
    const text = (value) => wrapCodePageText(value, columns, codeTable).forEach(writeLine);
    const pair = (left, right) => {
        const lhs = normalizeForCodePage(left, codeTable);
        const rhs = normalizeForCodePage(right, codeTable);
        if (rhs.length >= columns) {
            text(lhs);
            text(rhs);
            return;
        }
        const leftWidth = Math.max(1, columns - rhs.length - 1);
        const leftLines = wrapReceiptText(lhs, leftWidth);
        const first = (leftLines.shift() || '').padEnd(leftWidth).slice(0, leftWidth);
        // Preserve the deliberate padding. Passing this through `text` would wrap
        // and trim the spaces, shifting amounts away from the printer's right edge.
        writeLine(`${first} ${rhs}`.slice(0, columns));
        leftLines.forEach(writeLine);
    };
    append(chunks, command(0x1b, 0x40));
    append(chunks, command(0x1b, 0x74, codeTable));
    append(chunks, command(0x1b, 0x61, 1));
    if (receipt.business.logoRaster)
        appendRasterQr(chunks, receipt.business.logoRaster);
    if (receipt.flags.isCopy) {
        append(chunks, command(0x1b, 0x45, 1));
        text(`${labels.copy}${receipt.flags.copyNumber ? ` #${receipt.flags.copyNumber}` : ''}`);
        append(chunks, command(0x1b, 0x45, 0));
    }
    if (receipt.flags.receiptType !== 'SALE') {
        append(chunks, command(0x1b, 0x45, 1));
        text(receipt.flags.receiptType.replace(/_/g, ' '));
        append(chunks, command(0x1b, 0x45, 0));
    }
    append(chunks, command(0x1b, 0x45, 1));
    text(receipt.business.name);
    append(chunks, command(0x1b, 0x45, 0));
    [receipt.business.branch, receipt.business.address, receipt.business.phone, receipt.business.tin ? `${labels.tin}: ${receipt.business.tin}` : null].filter(Boolean).forEach(text);
    if (receipt.header?.note)
        text(receipt.header.note);
    append(chunks, command(0x1b, 0x61, 0));
    text(`${labels.receipt}: ${receipt.receipt.number || ''}`);
    [receipt.receipt.localDateTime, receipt.receipt.cashier ? `${labels.cashier}: ${receipt.receipt.cashier}` : null, receipt.receipt.register ? `${labels.register}: ${receipt.receipt.register}` : null].filter(Boolean).forEach(text);
    if (receipt.customer) {
        text(labels.customer.toLocaleUpperCase());
        [receipt.customer.name, receipt.customer.tin ? `${labels.tin}: ${receipt.customer.tin}` : null].filter(Boolean).forEach(text);
    }
    append(chunks, command(0x1b, 0x45, 1));
    receipt.lines.forEach((line) => {
        text(line.name);
        if (line.taxClass)
            text(`${labels.taxClass}: ${line.taxClass}`);
        if (line.quantity != null)
            text(`${line.quantity}${line.unit ? ` ${line.unit}` : ''} x ${amountText(line.unitPriceRwf, currency)}`);
        pair(labels.amount, amountText(line.totalRwf, currency));
        if (line.discountRwf) {
            const discountLabel = `${labels.discount}${line.discountPercent ? ` (${line.discountPercent}%)` : ''}${line.discountReason ? ` · ${line.discountReason}` : ''}`;
            pair(discountLabel, `-${amountText(line.discountRwf, currency)}`);
        }
    });
    append(chunks, command(0x1b, 0x45, 0));
    pair(labels.subtotal, amountText(receipt.totals.subtotalRwf, currency));
    (receipt.totals.vouchers || []).forEach((voucher) => pair(`Voucher ${voucher.name || 'Voucher'} ${voucher.code}`, `-${amountText(voucher.discountRwf, currency)}`));
    const totalSavedRwf = receipt.totals.totalSavedRwf ?? receipt.totals.discountRwf;
    if (totalSavedRwf)
        pair(labels.totalSaved || labels.discount, `-${amountText(totalSavedRwf, currency)}`);
    (receipt.totals.taxes || []).forEach((tax) => pair(tax.label || tax.code || labels.tax, amountText(tax.taxRwf, currency)));
    pair(labels.taxTotal, amountText(receipt.totals.taxTotalRwf, currency));
    append(chunks, command(0x1b, 0x45, 1));
    pair(labels.total.toLocaleUpperCase(), amountText(receipt.totals.grandTotalRwf, currency));
    append(chunks, command(0x1b, 0x45, 0));
    if (receipt.payments?.length) {
        text(labels.payments.toLocaleUpperCase());
        receipt.payments.forEach((payment) => pair(`${payment.method}${payment.reference ? ` ${payment.reference}` : ''}`, amountText(payment.amountRwf, currency)));
    }
    if (receipt.paymentSummary?.amountPaidRwf != null)
        pair(labels.paid, amountText(receipt.paymentSummary.amountPaidRwf, currency));
    if (receipt.paymentSummary?.changeGivenRwf)
        pair(labels.change, amountText(receipt.paymentSummary.changeGivenRwf, currency));
    if (receipt.fiscal) {
        text(labels.fiscalReceipt.toLocaleUpperCase());
        [receipt.fiscal.receiptNumber ? `${labels.receipt}: ${receipt.fiscal.receiptNumber}` : null, receipt.fiscal.receiptDate, receipt.fiscal.sdc ? `SDC: ${receipt.fiscal.sdc}` : null, receipt.fiscal.mrc ? `MRC: ${receipt.fiscal.mrc}` : null, receipt.fiscal.environment].filter(Boolean).forEach(text);
        append(chunks, command(0x1b, 0x61, 1));
        const qrPayload = receipt.fiscal.qrPayload || (receipt.fiscal.qrData?.startsWith('data:') ? null : receipt.fiscal.qrData);
        if (options.qrMode === 'native' && qrPayload)
            appendNativeQr(chunks, qrPayload);
        else if (options.qrMode !== 'none' && receipt.fiscal.qrRaster)
            appendRasterQr(chunks, receipt.fiscal.qrRaster);
        append(chunks, command(0x1b, 0x61, 0));
        if (receipt.fiscal.signature)
            text(`${labels.signature}: ${receipt.fiscal.signature}`);
    }
    if (receipt.digital?.url) {
        text(receipt.digital.label || labels.digitalReceipt);
        append(chunks, command(0x1b, 0x61, 1));
        appendNativeQr(chunks, receipt.digital.url);
        append(chunks, command(0x1b, 0x61, 0));
    }
    (receipt.extension?.sections || []).forEach((section) => {
        text(section.title);
        section.lines.forEach(text);
    });
    if (receipt.footer?.note) {
        append(chunks, command(0x1b, 0x61, 1));
        text(receipt.footer.note);
    }
    if (receipt.footer?.returnPolicy)
        text(receipt.footer.returnPolicy);
    append(chunks, command(0x1b, 0x64, 4));
    if (options.drawer?.enabled) {
        const pin = options.drawer.pin === 5 ? 1 : 0;
        const on = Math.max(0, Math.min(255, Math.round((options.drawer.onMs ?? 50) / 2)));
        const off = Math.max(0, Math.min(255, Math.round((options.drawer.offMs ?? 500) / 2)));
        append(chunks, command(0x1b, 0x70, pin, on, off));
    }
    if (options.cut !== false)
        append(chunks, command(0x1d, 0x56, 0));
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
    return output;
}
function firstValue(...values) {
    return values.find((value) => value != null && value !== '');
}
function asThermalDocument(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function thermalText(value, columns, codeTable) {
    return wrapCodePageText(value, columns, codeTable);
}
function thermalPair(left, right, columns, codeTable) {
    const lhs = normalizeForCodePage(left, codeTable);
    const rhs = normalizeForCodePage(right, codeTable);
    if (!rhs || rhs.length >= columns)
        return [...thermalText(lhs, columns, codeTable), ...thermalText(rhs, columns, codeTable)];
    const leftWidth = Math.max(1, columns - rhs.length - 1);
    const leftLines = thermalText(lhs, leftWidth, codeTable);
    const first = (leftLines.shift() || '').padEnd(leftWidth).slice(0, leftWidth);
    return [`${first} ${rhs}`.slice(0, columns), ...leftLines];
}
/**
 * Renders simple POS slips and reports using the same bytes in browser and agent.
 * Fiscal receipts should use renderReceiptEscPos with their canonical document.
 */
function renderThermalDocument(payload, options = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('Thermal document payload must be an object.');
    }
    const columns = options.columns || (options.paperWidthMm === 58 ? 32 : 42);
    if (!Number.isInteger(columns) || columns < 20 || columns > 80)
        throw new RangeError('Receipt columns must be between 20 and 80.');
    const codeTable = Math.floor(options.codeTable ?? 16);
    if (![16, 19].includes(codeTable))
        throw new RangeError('Receipt code page must be Windows-1252 (16) or PC858 (19).');
    const canonical = payload.receiptDocument || payload.receipt || (payload.version === 1 && payload.flags ? payload : null);
    if (canonical && typeof canonical === 'object' && canonical.version === 1) {
        return renderReceiptEscPos(canonical, options);
    }
    const data = asThermalDocument(payload.data || payload);
    const jobType = String(options.jobType || payload.jobType || '').toLowerCase();
    const copy = Boolean(payload.copyRequired || payload.isCopy || Number(payload.copyNumber) > 0);
    const titleByType = {
        receipt: 'SALES INVOICE / RECEIPT',
        'refund-receipt': 'REFUND RECEIPT',
        'gift-card-slip': 'GIFT CARD',
        'x-report': 'X REPORT',
        'z-report': 'Z REPORT',
        'cash-movement-slip': 'CASH MOVEMENT',
        'test-print': 'PRINTER TEST',
        'report-pdf': 'REPORT',
    };
    const title = String(firstValue(data.title, data.documentTitle, titleByType[jobType], data.receiptNumber && 'RECEIPT', 'POS DOCUMENT'));
    const chunks = [];
    const writeLine = (value) => {
        append(chunks, encodeCodePageText(value, codeTable));
        append(chunks, command(0x0a));
    };
    const text = (value) => thermalText(value, columns, codeTable).forEach(writeLine);
    const pair = (left, right) => thermalPair(left, right, columns, codeTable).forEach(writeLine);
    append(chunks, command(0x1b, 0x40, 0x1b, 0x74, codeTable, 0x1b, 0x61, 1));
    if (copy) {
        append(chunks, command(0x1b, 0x45, 1));
        text(`COPY${Number(payload.copyNumber) > 0 ? ` #${Number(payload.copyNumber)}` : ''}`);
        append(chunks, command(0x1b, 0x45, 0));
    }
    const companyReceipt = asThermalDocument(data.companyReceipt);
    const paymentReceipt = asThermalDocument(data.paymentReceipt);
    text(firstValue(data.shopName, data.shop, data.businessName, companyReceipt.name, 'KUBIKA'));
    text(firstValue(data.branchName, data.branch));
    append(chunks, command(0x1b, 0x61, 0, 0x1b, 0x45, 1));
    text(title);
    append(chunks, command(0x1b, 0x45, 0));
    const reference = firstValue(data.receiptNumber, data.invoiceNumber, data.referenceNo, data.reportNumber, data.movementNumber);
    if (reference)
        pair('Reference', reference);
    const date = firstValue(data.dateTime, data.createdAt, data.generatedAt);
    if (date)
        pair('Date', date);
    if (data.cashier)
        pair('Cashier', data.cashier);
    text('-'.repeat(columns));
    if (jobType === 'test-print') {
        text(`${'0123456789'.repeat(6)}0123`);
        text('Mélanie Crème');
    }
    if (jobType === 'gift-card-slip') {
        const giftCard = asThermalDocument(data.giftCard || data);
        const code = String(firstValue(giftCard.code, giftCard.cardCode, giftCard.number, ''));
        pair('Value', firstValue(giftCard.value, giftCard.amount, data.amount, ''));
        pair('Code', copy ? `****${code.slice(-4)}` : code);
        if (giftCard.expiryDate)
            pair('Expires', giftCard.expiryDate);
    }
    const rows = Array.isArray(data.lines)
        ? data.lines
        : Array.isArray(data.items) ? data.items
            : Array.isArray(data.receiptLines) ? data.receiptLines : [];
    for (const value of rows) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const row = value;
        text(firstValue(row.description, row.name, row.itemName, 'Item'));
        const quantity = row.quantity == null ? '' : `x${row.quantity}`;
        const amount = firstValue(row.total, row.totalRwf, row.amount, row.lineTotalRwf, '');
        if (quantity || amount !== '')
            pair(quantity, amount);
    }
    text('-'.repeat(columns));
    const totals = [
        ['Subtotal', [data.subtotal, data.subtotalRwf]],
        ['Discount', [data.discount, data.discountRwf]],
        ['Tax', [data.tax, data.taxTotal, data.taxTotalRwf, data.totalTax]],
        ['Total', [data.total, data.grandTotal, data.grandTotalRwf, data.amount, data.totalAmount]],
        ['Paid', [data.paid, data.amountPaid, paymentReceipt.amountPaidRwf]],
        ['Change', [data.change, data.changeGiven, paymentReceipt.changeGivenRwf]],
    ];
    for (const [label, values] of totals) {
        const amount = firstValue(...values);
        if (amount != null)
            pair(label.toUpperCase(), amount);
    }
    const payments = Array.isArray(data.payments)
        ? data.payments
        : Array.isArray(paymentReceipt.methods) ? paymentReceipt.methods : [];
    for (const value of payments) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const payment = value;
        pair(payment.method || 'Payment', firstValue(payment.amount, payment.amountRwf, ''));
    }
    if (data.fiscalNumber)
        pair('Fiscal', data.fiscalNumber);
    if (data.sdcId)
        pair('SDC', data.sdcId);
    const qrPayload = String(firstValue(data.qrPayload, data.qrData, ''));
    if (options.qrMode === 'native' && qrPayload && !qrPayload.startsWith('data:')) {
        append(chunks, command(0x1b, 0x61, 1));
        appendNativeQr(chunks, qrPayload);
    }
    if (data.footer || data.footerNote) {
        append(chunks, command(0x1b, 0x61, 1));
        text(data.footer || data.footerNote);
    }
    append(chunks, command(0x1b, 0x64, 3));
    if (options.cut !== false)
        append(chunks, command(0x1d, 0x56, 0));
    return concatBytes(chunks);
}

const crypto = require('crypto');

function esc(bytes) {
  return Buffer.from(bytes);
}

function text(value, columns = 42) {
  const normalized = String(value ?? '').replace(/\r/g, '').replace(/[^\x20-\x7E]/g, '?');
  const max = Math.max(20, Number(columns) || 42);
  return normalized.length <= max ? normalized : normalized.slice(0, max);
}

function line(columns = 42, char = '-') {
  return char.repeat(Math.max(20, Number(columns) || 42));
}

function pair(left, right, columns = 42) {
  const width = Math.max(20, Number(columns) || 42);
  const a = text(left, width);
  const b = text(right, width);
  const spaces = Math.max(1, width - a.length - b.length);
  return a + ' '.repeat(spaces) + b;
}

function renderThermal(payload, options = {}) {
  const columns = Number(options.columns || (
    payload.paperWidthMm === 58 ? 32 :
    payload.paperWidthMm === 80 ? 48 :
    42
  ));
  const copy = Boolean(options.copy);
  const data = payload.data || payload;
  const chunks = [
    esc([0x1b, 0x40]),
    esc([0x1b, 0x61, 0x01]),
    Buffer.from(copy ? `*** COPY / DUPLICATE ***\n` : ''),
    Buffer.from(`${text(data.shopName || data.shop || 'KUBIKA', columns)}\n`),
    Buffer.from(`${text(data.branchName || data.branch || '', columns)}\n`),
    esc([0x1b, 0x61, 0x00]),
  ];

  if (data.title || data.receiptNumber || data.invoiceNumber) {
    chunks.push(Buffer.from(`${text(data.title || 'RECEIPT', columns)}\n`));
    chunks.push(Buffer.from(`${text(data.receiptNumber || data.invoiceNumber || '', columns)}\n`));
  }
  if (data.cashier) chunks.push(Buffer.from(pair('Cashier', data.cashier, columns) + '\n'));
  if (data.dateTime || data.createdAt) chunks.push(Buffer.from(pair('Date', data.dateTime || data.createdAt, columns) + '\n'));
  chunks.push(Buffer.from(line(columns) + '\n'));

  for (const item of Array.isArray(data.lines) ? data.lines : []) {
    const description = text(item.description || item.name || '', columns);
    const quantity = item.quantity == null ? '' : `x${item.quantity}`;
    const amount = item.total == null ? '' : String(item.total);
    chunks.push(Buffer.from(`${description}\n`));
    chunks.push(Buffer.from(pair(quantity, amount, columns) + '\n'));
  }
  chunks.push(Buffer.from(line(columns) + '\n'));

  for (const key of ['subtotal', 'discount', 'tax', 'total', 'paid', 'change']) {
    if (data[key] != null) chunks.push(Buffer.from(pair(key.toUpperCase(), String(data[key]), columns) + '\n'));
  }

  for (const payment of Array.isArray(data.payments) ? data.payments : []) {
    chunks.push(Buffer.from(pair(payment.method || 'Payment', String(payment.amount ?? ''), columns) + '\n'));
  }
  if (data.fiscalNumber) chunks.push(Buffer.from(`Fiscal: ${text(data.fiscalNumber, columns)}\n`));
  if (data.sdcId) chunks.push(Buffer.from(`SDC: ${text(data.sdcId, columns)}\n`));
  if (data.footer) chunks.push(Buffer.from(`${text(data.footer, columns)}\n`));
  chunks.push(esc([0x1b, 0x64, 0x03]));
  chunks.push(esc([0x1b, 0x69]));
  chunks.push(esc([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}

function drawerCommand(pin = 2, onMs = 25, offMs = 500) {
  return Buffer.from([0x1b, 0x70, pin === 5 ? 0x01 : 0x00,
    Math.max(1, Math.min(255, Math.round(onMs / 2))),
    Math.max(1, Math.min(255, Math.round(offMs / 2)))]);
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(typeof payload === 'string' ? payload : JSON.stringify(payload)).digest('hex');
}

module.exports = { renderThermal, drawerCommand, payloadHash };

'use strict';

const { prisma } = require('../lib/prisma');
const { getReadContext } = require('../lib/readContext');

const MAX_INDEX_ROWS = 10000;
const MAX_INDEX_PAGE_SIZE = 500;
const HASH_PATTERN = /^[a-f\d]{64}$/i;

function boundedRows(rows, kind) {
  if (rows.length > MAX_INDEX_ROWS) {
    throw Object.assign(new Error(`The ${kind} offline scanner index exceeds the safe limit. Reconnect and reduce the indexed data before using offline scan lookup.`), {
      status: 413,
      code: 'POS_SCANNER_OFFLINE_INDEX_TOO_LARGE',
    });
  }
  return rows;
}

function loyaltyCardCodes(customFields) {
  const values = customFields && typeof customFields === 'object'
    ? customFields.loyaltyCardCodes
    : null;
  const entries = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
  return [...new Set(entries
    .map((value) => String(value || '').trim().slice(0, 128))
    .filter(Boolean))].slice(0, 32);
}

function validHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

async function readIndexRows(model, query, kind) {
  const pageSize = Math.min(MAX_INDEX_PAGE_SIZE, getReadContext().maxRows);
  const rows = [];
  while (rows.length <= MAX_INDEX_ROWS) {
    const take = Math.min(pageSize, MAX_INDEX_ROWS + 1 - rows.length);
    const page = await model.findMany({ ...query, skip: rows.length, take });
    rows.push(...page);
    if (rows.length > MAX_INDEX_ROWS) return boundedRows(rows, kind);
    if (page.length < take) return rows;
  }
  return boundedRows(rows, kind);
}

async function getPosScannerOfflineIndex(companyId, now = new Date()) {
  const scope = String(companyId || '').trim();
  if (!scope) throw new TypeError('A company is required to build the POS scanner index.');

  const [customers, vouchers, giftCards, receipts] = await Promise.all([
    readIndexRows(prisma.client, {
      where: { companyId: scope, isActive: true, mergedIntoClientId: null, isWalkIn: false },
      select: { id: true, name: true, code: true, customFields: true },
      orderBy: { id: 'asc' },
    }, 'customer'),
    readIndexRows(prisma.posVoucher, {
      where: { companyId: scope, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
      select: { codeHash: true },
      orderBy: { id: 'asc' },
    }, 'voucher'),
    readIndexRows(prisma.posStoredValueAccount, {
      where: {
        companyId: scope,
        kind: 'gift_card',
        isActive: true,
        codeHash: { not: null },
        replacedByAccountId: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { codeHash: true },
      orderBy: { id: 'asc' },
    }, 'gift-card'),
    readIndexRows(prisma.posPublicReceiptToken, {
      where: {
        companyId: scope,
        revokedAt: null,
        expiresAt: { gt: now },
        invoice: { is: { posOrigin: true } },
      },
      select: {
        tokenHash: true,
        expiresAt: true,
        invoice: { select: { id: true, referenceNo: true, invoiceDate: true } },
      },
      orderBy: { id: 'asc' },
    }, 'receipt'),
  ]);

  return {
    generatedAt: now.toISOString(),
    customers: boundedRows(customers, 'customer').map((customer) => ({
      id: String(customer.id),
      name: String(customer.name || '').slice(0, 160),
      code: String(customer.code || '').slice(0, 80),
      cardCodes: loyaltyCardCodes(customer.customFields),
    })),
    voucherCodeHashes: boundedRows(vouchers, 'voucher')
      .map((voucher) => voucher.codeHash)
      .filter(validHash),
    giftCardCodeHashes: boundedRows(giftCards, 'gift-card')
      .map((account) => account.codeHash)
      .filter(validHash),
    receipts: boundedRows(receipts, 'receipt').filter((receipt) => (
      validHash(receipt.tokenHash) && receipt.invoice
    )).map((receipt) => ({
      tokenHash: receipt.tokenHash,
      expiresAt: receipt.expiresAt.toISOString(),
      invoiceId: String(receipt.invoice.id),
      receiptNumber: String(receipt.invoice.referenceNo || '').slice(0, 80),
      invoiceDate: receipt.invoice.invoiceDate.toISOString(),
    })),
  };
}

module.exports = {
  MAX_INDEX_ROWS,
  getPosScannerOfflineIndex,
  readIndexRows,
};

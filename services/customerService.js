'use strict';

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog } = require('./posAuditService');
const JournalService = require('./journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

async function getLoyaltyPointValueRwf(tx, companyId) {
  // The settings migration may not yet be installed on older databases. Detect
  // the column before selecting it so point adjustments can continue at the
  // documented RWF 1 default without failing the whole ledger transaction.
  const column = await tx.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'system_settings'
        AND column_name = 'pos_loyalty_settings' LIMIT 1`,
  );
  if (!column.length) return 1;
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE((pos_loyalty_settings ->> 'pointValueRwf')::numeric, 1)::float8 AS value
       FROM system_settings WHERE company_id = $1 LIMIT 1`,
    companyId,
  );
  const value = Number(rows[0]?.value ?? 1);
  return Number.isFinite(value) && value >= 0.01 && value <= 1000000 ? value : 1;
}

const CUSTOMER_TYPES = new Set(['individual', 'business']);
const LOYALTY_ENTRY_TYPES = new Set(['EARN', 'REDEEM', 'ADJUST', 'EXPIRE', 'REVERSE']);
const CREDIT_ENTRY_TYPES = new Set(['CHARGE', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF', 'REFUND_CREDIT']);

function customerError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function requireCompanyId(value) {
  const id = String(value || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw customerError('CUSTOMER_COMPANY_REQUIRED', 'A valid company is required.', 401);
  return id;
}

function requireUserId(value) {
  const id = String(value || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw customerError('CUSTOMER_ACTOR_REQUIRED', 'A signed-in user is required.', 401);
  return id;
}

function normalizeRwandaPhone(value, { optional = true } = {}) {
  if (value == null || String(value).trim() === '') {
    if (optional) return null;
    throw customerError('CUSTOMER_PHONE_REQUIRED', 'Enter a phone number.');
  }
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  let normalized;
  if (/^0\d{9}$/.test(digits)) normalized = `+250${digits.slice(1)}`;
  else if (/^250\d{9}$/.test(digits)) normalized = `+${digits}`;
  else if (/^\d{9}$/.test(digits)) normalized = `+250${digits}`;
  else throw customerError('CUSTOMER_PHONE_INVALID', 'Enter a valid Rwanda phone number, such as 078 123 4567.');
  if (raw.startsWith('+') && !normalized.startsWith('+250')) {
    throw customerError('CUSTOMER_PHONE_INVALID', 'Enter a Rwanda phone number beginning with +250.');
  }
  return normalized;
}

function maskPhone(value) {
  const phone = String(value || '');
  return phone.length >= 7 ? `${phone.slice(0, 5)}••••${phone.slice(-2)}` : '';
}

function maskTin(value) {
  const tin = String(value || '');
  return tin.length >= 4 ? `${'•'.repeat(Math.max(0, tin.length - 3))}${tin.slice(-3)}` : '';
}

function normalizeEmail(value) {
  if (value == null || String(value).trim() === '') return null;
  const email = String(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw customerError('CUSTOMER_EMAIL_INVALID', 'Enter a valid email address.');
  return email;
}

function normalizeTin(value) {
  if (value == null || String(value).trim() === '') return null;
  const tin = String(value).trim();
  if (!/^\d{9}$/.test(tin)) throw customerError('CUSTOMER_TIN_INVALID', 'TIN must contain 9 digits.');
  return tin;
}

function clientCode() {
  return `CUS-${generateObjectId().slice(-10).toUpperCase()}`;
}

function makeCustomerData(input, { quick = false } = {}) {
  const name = String(input?.name || '').trim();
  if (!name || name.length > 160) throw customerError('CUSTOMER_NAME_INVALID', 'Enter a customer name up to 160 characters.');
  const phoneInput = input?.phone ?? input?.contact?.phone;
  const phoneNormalized = normalizeRwandaPhone(phoneInput);
  const email = quick ? null : normalizeEmail(input?.email ?? input?.contact?.email);
  const tin = quick ? null : normalizeTin(input?.tin ?? input?.taxId);
  const type = quick ? 'individual' : String(input?.type || 'individual').toLowerCase();
  if (!CUSTOMER_TYPES.has(type)) throw customerError('CUSTOMER_TYPE_INVALID', 'Choose individual or business.');
  const existingContact = input?.contact && typeof input.contact === 'object' && !Array.isArray(input.contact)
    ? input.contact
    : {};
  return {
    name,
    type,
    contact: {
      ...existingContact,
      ...(phoneNormalized ? { phone: phoneNormalized } : { phone: null }),
      ...(email ? { email } : {}),
    },
    phoneNormalized,
    phoneNeedsReview: false,
    address: quick ? null : (String(input?.address ?? existingContact.address ?? '').trim() || null),
    groupTag: quick ? null : (String(input?.groupTag ?? input?.tag ?? '').trim().slice(0, 80) || null),
    taxId: tin,
    notes: quick ? null : (String(input?.notes || '').trim() || null),
    marketingConsent: quick ? false : input?.marketingConsent === true,
    digitalReceiptConsent: quick ? false : input?.digitalReceiptConsent === true,
  };
}

function customerView(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    code: row.code,
    type: row.type,
    phone: row.phoneNormalized || row.contact?.phone || null,
    phoneNeedsReview: Boolean(row.phoneNeedsReview),
    email: row.contact?.email || null,
    address: row.address || row.contact?.address || null,
    tin: row.taxId || null,
    groupTag: row.groupTag || null,
    notes: row.notes || null,
    status: row.isActive ? 'active' : 'inactive',
    isWalkIn: Boolean(row.isWalkIn),
    marketingConsent: Boolean(row.marketingConsent),
    digitalReceiptConsent: Boolean(row.digitalReceiptConsent),
    creditLimit: row.creditLimit == null ? 0 : Number(row.creditLimit),
    outstandingBalance: row.outstandingBalance == null ? 0 : Number(row.outstandingBalance),
    mergedIntoClientId: row.mergedIntoClientId || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureWalkInCustomer(companyIdValue, createdById = null, client = prisma) {
  const companyId = requireCompanyId(companyIdValue);
  const userId = createdById ? requireUserId(createdById) : null;
  const existing = await client.client.findFirst({ where: { companyId, isWalkIn: true, mergedIntoClientId: null } });
  if (existing) return existing;
  try {
    return await client.client.create({
      data: {
        id: generateObjectId(), companyId, name: 'Walk-in customer',
        code: `WALKIN-${companyId.toUpperCase()}`, type: 'individual', contact: {},
        phoneNormalized: null, marketingConsent: false, digitalReceiptConsent: false,
        isWalkIn: true, isActive: true, createdById: userId,
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      const raced = await client.client.findFirst({ where: { companyId, isWalkIn: true, mergedIntoClientId: null } });
      if (raced) return raced;
    }
    throw error;
  }
}

async function findDuplicateCustomers(client, companyId, data, excludeId = null) {
  const alternatives = [];
  if (data.phoneNormalized) alternatives.push({
    OR: [{ phoneNormalized: data.phoneNormalized }, { phoneNeedsReview: true }],
  });
  if (data.name) alternatives.push({ name: { equals: data.name, mode: 'insensitive' } });
  if (!alternatives.length) return [];
  const rows = await client.client.findMany({
    where: {
      companyId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: alternatives,
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  return rows
    .filter((row) => {
      const phoneMatch = data.phoneNormalized && (
        row.phoneNormalized === data.phoneNormalized
        || (row.phoneNeedsReview && (() => {
          try { return normalizeRwandaPhone(row.contact?.phone) === data.phoneNormalized; } catch { return false; }
        })())
      );
      const nameMatch = data.name && String(row.name || '').toLocaleLowerCase() === String(data.name).toLocaleLowerCase();
      return Boolean(phoneMatch || nameMatch);
    })
    .map(customerView);
}

async function findCustomerDuplicates({ companyId: companyValue, name = '', phone = '', excludeId = null, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const normalizedName = String(name || '').trim();
  let phoneNormalized = null;
  if (String(phone || '').trim()) phoneNormalized = normalizeRwandaPhone(phone);
  return findDuplicateCustomers(client, companyId, { name: normalizedName, phoneNormalized }, excludeId || null);
}

async function createCustomer({ companyId: companyValue, userId: userValue, input, quick = false, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const data = makeCustomerData(input, { quick });
  const duplicates = await findDuplicateCustomers(client, companyId, data);
  if (data.phoneNormalized && duplicates.some((candidate) => candidate.phone === data.phoneNormalized)) {
    throw Object.assign(customerError('CUSTOMER_DUPLICATE', 'A matching customer already exists. Review the suggested customer before creating another.', 409), { duplicates });
  }
  try {
    const row = await client.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          id: generateObjectId(),
          companyId,
          code: clientCode(),
          ...data,
          createdById: userId,
        },
      });
      await writePosAuditLog({
        companyId, userId, event: 'CUSTOMER_CREATED',
        metadata: { customerId: created.id, customerCode: created.code, quickAdd: Boolean(quick) },
      }, tx);
      return created;
    });
    return customerView(row);
  } catch (error) {
    if (error?.code === 'P2002') throw customerError('CUSTOMER_PHONE_IN_USE', 'That phone number is already used by a customer in this company.', 409);
    throw error;
  }
}

async function quickAddCustomer(args) {
  return createCustomer({ ...args, quick: true });
}

async function searchCustomers({ companyId: companyValue, query = '', limit = 20, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const term = String(query || '').trim().slice(0, 100);
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
  const phoneDigits = term.replace(/\D/g, '');
  const phoneFragment = !phoneDigits
    ? null
    : phoneDigits.startsWith('0')
      ? `+250${phoneDigits.slice(1)}`
      : phoneDigits.startsWith('250')
        ? `+${phoneDigits}`
        : `+250${phoneDigits}`;
  const rows = await client.client.findMany({
    where: {
      companyId,
      isActive: true,
      mergedIntoClientId: null,
      ...(term ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { code: { contains: term, mode: 'insensitive' } },
          ...(phoneFragment ? [{ phoneNormalized: { contains: phoneFragment } }] : []),
          ...(phoneFragment ? [{ phoneNeedsReview: true }] : []),
        ],
      } : {}),
    },
    orderBy: [{ isWalkIn: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    take: safeLimit,
  });
  const customerIds = rows.map((row) => String(row.id));
  const [pointRows, walletRows] = customerIds.length && typeof client.$queryRawUnsafe === 'function' ? await Promise.all([
    client.$queryRawUnsafe(
      `SELECT COALESCE(c.merged_into_client_id, c.id) AS "clientId", COALESCE(SUM(l.points), 0)::int AS balance
         FROM pos_customer_loyalty_ledger l
         JOIN clients c ON c.id = l.client_id AND c.company_id = l.company_id
        WHERE l.company_id = $1 AND (c.id = ANY($2::char(24)[]) OR c.merged_into_client_id = ANY($2::char(24)[]))
        GROUP BY COALESCE(c.merged_into_client_id, c.id)`,
      companyId, customerIds,
    ),
    client.$queryRawUnsafe(
      `SELECT COALESCE(c.merged_into_client_id, c.id) AS "clientId", a.currency_code AS "currencyCode", COALESCE(SUM(a.balance), 0)::numeric AS balance
         FROM pos_stored_value_accounts a
         JOIN clients c ON c.id = a.client_id AND c.company_id = a.company_id
        WHERE a.company_id = $1 AND (c.id = ANY($2::char(24)[]) OR c.merged_into_client_id = ANY($2::char(24)[])) AND a.kind = 'loyalty' AND a.is_active = TRUE
        GROUP BY COALESCE(c.merged_into_client_id, c.id), a.currency_code`,
      companyId, customerIds,
    ),
  ]) : [[], []];
  const pointsByCustomer = new Map(pointRows.map((row) => [String(row.clientId), Number(row.balance || 0)]));
  const walletsByCustomer = new Map();
  for (const row of walletRows) {
    const id = String(row.clientId);
    if (!walletsByCustomer.has(id)) walletsByCustomer.set(id, []);
    walletsByCustomer.get(id).push({ currencyCode: row.currencyCode, balance: Number(row.balance || 0) });
  }
  return rows
    .filter((row) => {
      if (!phoneFragment || !row.phoneNeedsReview) return true;
      const digits = String(row.contact?.phone || '').replace(/\D/g, '');
      const searchDigits = phoneDigits.replace(/^250/, '').replace(/^0/, '');
      return digits.includes(phoneDigits) || digits.replace(/^250/, '').replace(/^0/, '').includes(searchDigits);
    })
    .map((row) => ({
      ...customerView(row),
      loyaltyPoints: pointsByCustomer.get(String(row.id)) || 0,
      loyaltyWallets: walletsByCustomer.get(String(row.id)) || [],
    }));
}

async function getWalkInCustomer({ companyId: companyValue, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const row = await client.client.findFirst({ where: { companyId, isWalkIn: true, mergedIntoClientId: null } });
  if (row) return customerView(row);
  return customerView(await ensureWalkInCustomer(companyId, null, client));
}

async function getCustomer({ companyId: companyValue, customerId, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const id = String(customerId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw customerError('CUSTOMER_ID_INVALID', 'Select a valid customer.');
  const row = await client.client.findFirst({ where: { id, companyId } });
  if (!row) throw customerError('CUSTOMER_NOT_FOUND', 'Customer not found in this company.', 404);
  return customerView(row);
}

async function getCustomerLedgers({ companyId: companyValue, customerId, limit = 100, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const id = String(customerId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw customerError('CUSTOMER_ID_INVALID', 'Select a valid customer.');
  const canonicalId = await canonicalCustomerId(client, companyId, id);
  const related = await client.client.findMany({
    where: { companyId, OR: [{ id: canonicalId }, { mergedIntoClientId: canonicalId }] },
    select: { id: true },
  });
  const clientIds = [...new Set(related.map((row) => row.id))];
  const safeLimit = Math.max(1, Math.min(250, Number.parseInt(limit, 10) || 100));
  const [creditEntries, loyaltyEntries, creditTotals, loyaltyTotals, loyaltyWallets] = await Promise.all([
    client.posCustomerCreditLedger.findMany({ where: { companyId, clientId: { in: clientIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: safeLimit }),
    client.posCustomerLoyaltyLedger.findMany({ where: { companyId, clientId: { in: clientIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: safeLimit }),
    client.$queryRawUnsafe(
      `SELECT COALESCE(SUM(CASE WHEN UPPER(direction) = 'INCREASE' THEN amount ELSE -amount END), 0)::numeric AS balance
         FROM pos_customer_credit_ledger WHERE company_id = $1 AND client_id = ANY($2::char(24)[])`,
      companyId, clientIds,
    ),
    client.$queryRawUnsafe(
      'SELECT COALESCE(SUM(points), 0)::int AS balance FROM pos_customer_loyalty_ledger WHERE company_id = $1 AND client_id = ANY($2::char(24)[])',
      companyId, clientIds,
    ),
    client.$queryRawUnsafe(
      `SELECT currency_code AS "currencyCode", COALESCE(SUM(balance), 0)::numeric AS balance
         FROM pos_stored_value_accounts
        WHERE company_id = $1 AND client_id = ANY($2::char(24)[]) AND kind = 'loyalty' AND is_active = TRUE
        GROUP BY currency_code ORDER BY currency_code`,
      companyId, clientIds,
    ),
  ]);
  return {
    customerId: canonicalId,
    creditBalance: Number(creditTotals[0]?.balance || 0),
    loyaltyPoints: Number(loyaltyTotals[0]?.balance || 0),
    loyaltyWallets: loyaltyWallets.map((wallet) => ({ currencyCode: wallet.currencyCode, balance: Number(wallet.balance || 0) })),
    creditEntries,
    loyaltyEntries,
  };
}

async function updateCustomer({ companyId: companyValue, customerId, userId: userValue, input, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const current = await client.client.findFirst({ where: { id: String(customerId), companyId } });
  if (!current) throw customerError('CUSTOMER_NOT_FOUND', 'Customer not found in this company.', 404);
  if (current.isWalkIn || current.mergedIntoClientId) throw customerError('CUSTOMER_PROTECTED', 'This customer record cannot be edited.', 409);
  const data = makeCustomerData({ ...input, contact: { ...(current.contact || {}), ...(input?.contact || {}) } });
  const duplicates = await findDuplicateCustomers(client, companyId, data, current.id);
  if (data.phoneNormalized && duplicates.some((candidate) => candidate.phone === data.phoneNormalized)) {
    throw Object.assign(customerError('CUSTOMER_DUPLICATE', 'A matching customer already exists. Review the suggested customer before saving.', 409), { duplicates });
  }
  try {
    const updated = await client.$transaction(async (tx) => {
      const next = await tx.client.update({
        where: { id: current.id },
        data: { ...data, isActive: input?.status === 'inactive' ? false : input?.status === 'active' ? true : current.isActive },
      });
      await writePosAuditLog({
        companyId, userId, event: 'CUSTOMER_UPDATED',
        metadata: { customerId: current.id, changedFields: Object.keys(data).filter((key) => key !== 'contact') },
      }, tx);
      const consentChanges = {};
      for (const field of ['marketingConsent', 'digitalReceiptConsent']) {
        if (Object.prototype.hasOwnProperty.call(input || {}, field)
          && Boolean(current[field]) !== Boolean(next[field])) {
          consentChanges[field] = { before: Boolean(current[field]), after: Boolean(next[field]) };
        }
      }
      if (Object.keys(consentChanges).length) {
        await writePosAuditLog({
          companyId, userId, event: 'CUSTOMER_CONSENT_UPDATED',
          metadata: { customerId: current.id, changes: consentChanges },
        }, tx);
      }
      if (consentChanges.digitalReceiptConsent?.before === true && consentChanges.digitalReceiptConsent.after === false) {
        const invoices = await tx.invoice.findMany({ where: { companyId, clientId: current.id }, select: { id: true } });
        const invoiceIds = invoices.map((invoice) => invoice.id);
        if (invoiceIds.length) {
          await tx.posPublicReceiptToken.updateMany({
            where: { companyId, invoiceId: { in: invoiceIds }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      }
      return next;
    });
    return customerView(updated);
  } catch (error) {
    if (error?.code === 'P2002') throw customerError('CUSTOMER_PHONE_IN_USE', 'That phone number is already used by a customer in this company.', 409);
    throw error;
  }
}

async function deactivateCustomer({ companyId: companyValue, customerId, userId: userValue, reason = '', client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const id = String(customerId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw customerError('CUSTOMER_ID_INVALID', 'Select a valid customer.');
  const result = await client.$transaction(async (tx) => {
    const row = await tx.client.findFirst({ where: { id, companyId } });
    if (!row) throw customerError('CUSTOMER_NOT_FOUND', 'Customer not found in this company.', 404);
    if (row.isWalkIn) throw customerError('CUSTOMER_WALK_IN_PROTECTED', 'The walk-in customer cannot be deactivated.', 409);
    if (row.mergedIntoClientId) throw customerError('CUSTOMER_MERGED', 'This customer has been merged into another record.', 409);
    const updated = await tx.client.update({ where: { id }, data: { isActive: false } });
    await writePosAuditLog({
      companyId, userId, event: 'CUSTOMER_DEACTIVATED',
      metadata: { customerId: id, reason: String(reason || '').trim().slice(0, 500) || null },
    }, tx);
    return updated;
  });
  return customerView(result);
}

async function canonicalCustomerId(client, companyId, clientId) {
  let currentId = String(clientId);
  const visited = new Set();
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(currentId)) throw customerError('CUSTOMER_MERGE_CYCLE', 'Customer merge links are invalid.', 409);
    visited.add(currentId);
    const row = await client.client.findFirst({
      where: { id: currentId, companyId },
      select: { id: true, mergedIntoClientId: true },
    });
    if (!row) throw customerError('CUSTOMER_NOT_FOUND', 'Customer not found in this company.', 404);
    if (!row.mergedIntoClientId) return row.id;
    currentId = row.mergedIntoClientId;
  }
  throw customerError('CUSTOMER_MERGE_DEPTH', 'Customer merge chain is too deep to resolve.', 409);
}

async function mergeCustomers({ companyId: companyValue, sourceId, survivorId, userId: userValue, reason, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const source = String(sourceId || '').trim();
  const survivor = String(survivorId || '').trim();
  const mergeReason = String(reason || '').trim();
  if (!/^[a-f\d]{24}$/i.test(source) || !/^[a-f\d]{24}$/i.test(survivor) || source === survivor) {
    throw customerError('CUSTOMER_MERGE_TARGET_INVALID', 'Choose two different customer records.');
  }
  if (mergeReason.length < 3 || mergeReason.length > 500) throw customerError('CUSTOMER_MERGE_REASON_REQUIRED', 'Enter a merge reason between 3 and 500 characters.');

  return client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM clients WHERE company_id = $1 AND id = ANY($2::char(24)[]) ORDER BY id FOR UPDATE',
      companyId, [source, survivor],
    );
    const [from, into] = await Promise.all([
      tx.client.findFirst({ where: { id: source, companyId } }),
      tx.client.findFirst({ where: { id: survivor, companyId } }),
    ]);
    if (!from || !into) throw customerError('CUSTOMER_NOT_FOUND', 'Both customer records must belong to this company.', 404);
    if (from.isWalkIn || into.isWalkIn) throw customerError('CUSTOMER_WALK_IN_PROTECTED', 'The walk-in customer cannot be merged.', 409);
    if (from.mergedIntoClientId || !into.isActive || into.mergedIntoClientId) throw customerError('CUSTOMER_MERGE_STATE_INVALID', 'Choose an active customer and an unmerged source record.', 409);
    const finalTarget = await canonicalCustomerId(tx, companyId, into.id);
    if (finalTarget !== into.id) throw customerError('CUSTOMER_MERGE_STATE_INVALID', 'Choose the surviving customer record.', 409);

    const now = new Date();
    await tx.client.update({
      where: { id: from.id },
      data: { isActive: false, mergedIntoClientId: into.id, mergedAt: now, mergedById: userId },
    });
    // Flatten earlier merge aliases so all historical ledger rows resolve to the survivor.
    await tx.client.updateMany({
      where: { companyId, mergedIntoClientId: from.id },
      data: { mergedIntoClientId: into.id },
    });
    await writePosAuditLog({
      companyId,
      userId,
      event: 'CUSTOMER_MERGED',
      metadata: { sourceCustomerId: from.id, survivingCustomerId: into.id, reason: mergeReason },
    }, tx);
    return customerView({ ...into, updatedAt: now });
  });
}

function hashRequest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ledgerCustomerIds(tx, companyId, clientId) {
  const canonicalId = await canonicalCustomerId(tx, companyId, clientId);
  const rows = await tx.client.findMany({
    where: { companyId, OR: [{ id: canonicalId }, { mergedIntoClientId: canonicalId }] },
    select: { id: true },
  });
  const ids = [...new Set(rows.map((row) => row.id))].sort();
  await tx.$queryRawUnsafe(
    'SELECT id FROM clients WHERE company_id = $1 AND id = ANY($2::char(24)[]) ORDER BY id FOR UPDATE',
    companyId, ids,
  );
  return { canonicalId, ids };
}

async function assertInvoiceTenant(tx, companyId, invoiceId) {
  if (!invoiceId) return null;
  const invoice = await tx.invoice.findFirst({ where: { id: String(invoiceId), companyId }, select: { id: true, clientId: true } });
  if (!invoice) throw customerError('CUSTOMER_LEDGER_INVOICE_TENANT_MISMATCH', 'The sale reference does not belong to this company.', 404);
  return invoice;
}

async function assertReceiptTenant(tx, companyId, receiptId, customerIds) {
  if (!receiptId) return;
  const receipt = await tx.aRReceipt.findFirst({
    where: { id: String(receiptId), companyId },
    select: { id: true, clientId: true },
  });
  if (!receipt || (customerIds && !customerIds.includes(receipt.clientId))) {
    throw customerError('CUSTOMER_LEDGER_RECEIPT_TENANT_MISMATCH', 'The receipt reference does not belong to this customer and company.', 404);
  }
}

async function appendLoyaltyEntry({ companyId: companyValue, customerId, userId: userValue, entryType, points, invoiceId = null, reason = null, idempotencyKey, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const type = String(entryType || '').toUpperCase();
  const delta = Number(points);
  const key = String(idempotencyKey || '').trim();
  if (!LOYALTY_ENTRY_TYPES.has(type) || !Number.isSafeInteger(delta) || delta === 0) throw customerError('CUSTOMER_LOYALTY_ENTRY_INVALID', 'Provide a valid points operation and non-zero whole-point amount.');
  if (!key || key.length > 120) throw customerError('CUSTOMER_LEDGER_IDEMPOTENCY_REQUIRED', 'A valid idempotency key is required.');
  if (['ADJUST', 'REVERSE', 'EXPIRE'].includes(type) && String(reason || '').trim().length < 3) throw customerError('CUSTOMER_LEDGER_REASON_REQUIRED', 'Enter a reason for this points entry.');
  if (type === 'EARN' && delta < 0 || ['REDEEM', 'EXPIRE'].includes(type) && delta > 0) throw customerError('CUSTOMER_LOYALTY_DIRECTION_INVALID', 'The points amount does not match the operation.');
  const payloadHash = hashRequest({ companyId, customerId: String(customerId), entryType: type, points: delta, invoiceId: invoiceId ? String(invoiceId) : null, reason: reason ? String(reason).trim() : null });

  return client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked', `${companyId}:loyalty:${key}`);
    const previous = await tx.posCustomerLoyaltyLedger.findFirst({ where: { companyId, idempotencyKey: key } });
    if (previous) {
      if (previous.requestHash !== payloadHash) throw customerError('CUSTOMER_LEDGER_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different points entry.', 409);
      return previous;
    }
    const invoice = await assertInvoiceTenant(tx, companyId, invoiceId);
    const { canonicalId, ids } = await ledgerCustomerIds(tx, companyId, customerId);
    if (invoice && !ids.includes(invoice.clientId)) throw customerError('CUSTOMER_LEDGER_INVOICE_CUSTOMER_MISMATCH', 'The sale belongs to a different customer.', 409);
    const totals = await tx.$queryRawUnsafe(
      'SELECT COALESCE(SUM(points), 0)::int AS balance FROM pos_customer_loyalty_ledger WHERE company_id = $1 AND client_id = ANY($2::char(24)[])',
      companyId, ids,
    );
    const balanceAfter = Number(totals[0]?.balance || 0) + delta;
    if (balanceAfter < 0) throw customerError('CUSTOMER_LOYALTY_BALANCE_NEGATIVE', 'This points entry would make the customer balance negative.', 409);
    const entry = await tx.posCustomerLoyaltyLedger.create({
      data: {
        id: generateObjectId(), companyId, clientId: canonicalId, entryType: type,
        points: delta, balanceAfter, invoiceId: invoiceId ? String(invoiceId) : null,
        reason: reason ? String(reason).trim().slice(0, 500) : null,
        createdById: userId, idempotencyKey: key, requestHash: payloadHash,
      },
    });
    if (type === 'ADJUST') {
      const pointValueRwf = await getLoyaltyPointValueRwf(tx, companyId);
      const valueRwf = Math.round((Math.abs(delta) * pointValueRwf + Number.EPSILON) * 100) / 100;
      const expenseAccount = await JournalService.getMappedAccountCode(companyId, 'sales', 'salesReturns', DEFAULT_ACCOUNTS.salesReturns || '4100');
      const liabilityAccount = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances || '2860');
      const issue = delta > 0;
      const journal = await JournalService.createEntriesAtomic(companyId, userId, [{
        date: new Date(),
        description: `Customer loyalty points ${issue ? 'issued' : 'removed'} - ${canonicalId}`,
        sourceType: 'pos_loyalty_points_adjustment', sourceId: entry.id, sourceReference: entry.id,
        lines: issue ? [
          JournalService.createDebitLine(expenseAccount, valueRwf, `Loyalty points issued to customer ${canonicalId}`),
          JournalService.createCreditLine(liabilityAccount, valueRwf, `Loyalty points liability for customer ${canonicalId}`),
        ] : [
          JournalService.createDebitLine(liabilityAccount, valueRwf, `Loyalty points removed from customer ${canonicalId}`),
          JournalService.createCreditLine(expenseAccount, valueRwf, `Loyalty points adjustment reversal for customer ${canonicalId}`),
        ],
        isAutoGenerated: true,
        notes: String(reason).trim().slice(0, 500),
      }], { session: tx });
      if (!journal?.[0]?._id) throw customerError('CUSTOMER_LOYALTY_JOURNAL_FAILED', 'The loyalty adjustment could not be posted to the accounts.');
      await writePosAuditLog({
        companyId, userId, event: 'CUSTOMER_LOYALTY_ADJUSTED',
        metadata: { customerId: canonicalId, entryId: entry.id, points: delta, pointValueRwf, valueRwf, journalId: journal[0]._id, reason: String(reason).trim().slice(0, 500), balanceAfter },
      }, tx);
    }
    return entry;
  });
}

async function appendCreditEntry({ companyId: companyValue, customerId, userId: userValue, entryType, direction, amount, invoiceId = null, receiptId = null, dueDate = null, reason = null, idempotencyKey, client = prisma }) {
  const companyId = requireCompanyId(companyValue);
  const userId = requireUserId(userValue);
  const type = String(entryType || '').toUpperCase();
  const movement = String(direction || '').toUpperCase();
  const value = Number(amount);
  const key = String(idempotencyKey || '').trim();
  if (!CREDIT_ENTRY_TYPES.has(type) || !['INCREASE', 'DECREASE'].includes(movement) || !Number.isFinite(value) || value <= 0) throw customerError('CUSTOMER_CREDIT_ENTRY_INVALID', 'Provide a valid account operation, direction, and positive amount.');
  if (!key || key.length > 120) throw customerError('CUSTOMER_LEDGER_IDEMPOTENCY_REQUIRED', 'A valid idempotency key is required.');
  if (['ADJUSTMENT', 'WRITE_OFF'].includes(type) && String(reason || '').trim().length < 3) throw customerError('CUSTOMER_LEDGER_REASON_REQUIRED', 'Enter a reason for this account entry.');
  if (type === 'CHARGE' && movement !== 'INCREASE' || ['PAYMENT', 'WRITE_OFF', 'REFUND_CREDIT'].includes(type) && movement !== 'DECREASE') throw customerError('CUSTOMER_CREDIT_DIRECTION_INVALID', 'The account direction does not match the operation.');
  const numericAmount = Math.round((value + Number.EPSILON) * 10000) / 10000;
  const payloadHash = hashRequest({ companyId, customerId: String(customerId), entryType: type, direction: movement, amount: numericAmount, invoiceId: invoiceId ? String(invoiceId) : null, receiptId: receiptId ? String(receiptId) : null, dueDate: dueDate ? new Date(dueDate).toISOString() : null, reason: reason ? String(reason).trim() : null });

  return client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked', `${companyId}:credit:${key}`);
    const previous = await tx.posCustomerCreditLedger.findFirst({ where: { companyId, idempotencyKey: key } });
    if (previous) {
      if (previous.requestHash !== payloadHash) throw customerError('CUSTOMER_LEDGER_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different account entry.', 409);
      return previous;
    }
    const invoice = await assertInvoiceTenant(tx, companyId, invoiceId);
    const { canonicalId, ids } = await ledgerCustomerIds(tx, companyId, customerId);
    if (invoice && !ids.includes(invoice.clientId)) throw customerError('CUSTOMER_LEDGER_INVOICE_CUSTOMER_MISMATCH', 'The sale belongs to a different customer.', 409);
    await assertReceiptTenant(tx, companyId, receiptId, ids);
    const totals = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END), 0)::numeric AS balance
         FROM pos_customer_credit_ledger WHERE company_id = $1 AND client_id = ANY($2::char(24)[])`,
      companyId, ids,
    );
    const currentBalance = Number(totals[0]?.balance || 0);
    const balanceAfter = Math.round((currentBalance + (movement === 'INCREASE' ? numericAmount : -numericAmount) + Number.EPSILON) * 10000) / 10000;
    if (balanceAfter < 0) throw customerError('CUSTOMER_CREDIT_BALANCE_NEGATIVE', 'This account entry would make the customer credit balance negative.', 409);
    return tx.posCustomerCreditLedger.create({
      data: {
        id: generateObjectId(), companyId, clientId: canonicalId, entryType: type,
        direction: movement, amount: numericAmount, balanceAfter,
        invoiceId: invoiceId ? String(invoiceId) : null,
        receiptId: receiptId ? String(receiptId) : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        reason: reason ? String(reason).trim().slice(0, 500) : null,
        createdById: userId, idempotencyKey: key, requestHash: payloadHash,
      },
    });
  });
}

module.exports = {
  CUSTOMER_TYPES,
  LOYALTY_ENTRY_TYPES,
  CREDIT_ENTRY_TYPES,
  customerError,
  requireCompanyId,
  requireUserId,
  normalizeRwandaPhone,
  normalizeEmail,
  normalizeTin,
  maskPhone,
  maskTin,
  customerView,
  ensureWalkInCustomer,
  findDuplicateCustomers,
  findCustomerDuplicates,
  createCustomer,
  quickAddCustomer,
  searchCustomers,
  getWalkInCustomer,
  getCustomer,
  getCustomerLedgers,
  updateCustomer,
  deactivateCustomer,
  canonicalCustomerId,
  mergeCustomers,
  ledgerCustomerIds,
  appendLoyaltyEntry,
  appendCreditEntry,
};

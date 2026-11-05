'use strict';

const { dbClient } = require('../lib/prisma');
const { getReadContext } = require('../lib/readContext');

const MAX_REPORT_ROWS = 5000;
const MAX_REPORT_READ_PAGE_SIZE = 500;
const MAX_REPORT_DAYS = 366;
const money = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

function parseDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw Object.assign(new Error(`${label} must use YYYY-MM-DD format.`), { statusCode: 400, code: 'POS_REPORT_FILTER_INVALID' });
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw Object.assign(new Error(`${label} is not a valid date.`), { statusCode: 400, code: 'POS_REPORT_FILTER_INVALID' });
  }
  return date;
}

function reportFilters(input = {}) {
  const today = new Date();
  const to = input.to ? parseDate(input.to, 'End date') : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = input.from
    ? parseDate(input.from, 'Start date')
    : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (from > to) {
    throw Object.assign(new Error('The end date must be on or after the start date.'), { statusCode: 400, code: 'POS_REPORT_FILTER_INVALID' });
  }
  const dayCount = Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (dayCount > MAX_REPORT_DAYS) {
    throw Object.assign(new Error(`Choose a date range of ${MAX_REPORT_DAYS} days or less.`), { statusCode: 400, code: 'POS_REPORT_RANGE_TOO_LARGE' });
  }
  const rate = (name) => {
    if (input[name] == null || input[name] === '') return null;
    const value = Number(input[name]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw Object.assign(new Error(`${name} must be between 0 and 100.`), { statusCode: 400, code: 'POS_REPORT_FILTER_INVALID' });
    }
    return value;
  };
  return {
    from,
    to,
    until: new Date(to.getTime() + 24 * 60 * 60 * 1000),
    cashierId: String(input.cashierId || '').trim() || null,
    registerId: String(input.registerId || '').trim() || null,
    reason: String(input.reason || '').trim().toLocaleLowerCase(),
    action: String(input.action || '').trim(),
    minDiscountRatePercent: rate('minDiscountRatePercent'),
    minOverrideRatePercent: rate('minOverrideRatePercent'),
  };
}

function cappedWhereResult(rows, label) {
  if (rows.length > MAX_REPORT_ROWS) {
    throw Object.assign(new Error(`The ${label} report is too large. Narrow the date range or add a filter.`), {
      statusCode: 413,
      code: 'POS_REPORT_RESULT_TOO_LARGE',
    });
  }
  return rows;
}

async function readReportRows(fetchPage, label) {
  const rows = [];
  while (rows.length <= MAX_REPORT_ROWS) {
    const pageSize = Math.min(MAX_REPORT_READ_PAGE_SIZE, getReadContext().maxRows);
    const take = Math.min(pageSize, MAX_REPORT_ROWS + 1 - rows.length);
    const page = await fetchPage({ skip: rows.length, take });
    if (!Array.isArray(page)) throw new TypeError(`The ${label} report query did not return rows.`);
    rows.push(...page);
    if (rows.length > MAX_REPORT_ROWS) return cappedWhereResult(rows, label);
    if (page.length < take) return rows;
  }
  return cappedWhereResult(rows, label);
}

async function readRowsForIds(findMany, where, field, ids, select) {
  const rows = [];
  const pageSize = Math.min(MAX_REPORT_READ_PAGE_SIZE, getReadContext().maxRows);
  for (let offset = 0; offset < ids.length; offset += pageSize) {
    const batch = ids.slice(offset, offset + pageSize);
    rows.push(...await findMany({
      where: { ...where, [field]: { in: batch } },
      take: batch.length,
      select,
    }));
  }
  return rows;
}

async function readRegistersForRefs(client, companyId, registerRefs) {
  const where = { companyId: String(companyId) };
  const [byId, byCode] = await Promise.all([
    readRowsForIds(client.posRegister.findMany.bind(client.posRegister), where, 'id', registerRefs, { id: true, code: true, name: true }),
    readRowsForIds(client.posRegister.findMany.bind(client.posRegister), where, 'code', registerRefs, { id: true, code: true, name: true }),
  ]);
  return [...new Map([...byId, ...byCode].map((register) => [String(register.id), register])).values()];
}

function isCompletedSale(status) {
  return !['draft', 'pending_payment', 'cancelled', 'canceled', 'void', 'rejected']
    .includes(String(status || '').toLocaleLowerCase());
}

function hasPriceOverride(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const price = Number(item.unitPrice);
    const catalogPrice = Number(item.catalogUnitPrice);
    return Number.isFinite(price) && Number.isFinite(catalogPrice) && Math.abs(price - catalogPrice) > 0.005;
  });
}

function addToGroup(groups, key, initial, update) {
  if (!groups.has(key)) groups.set(key, initial());
  update(groups.get(key));
}

function cleanGroupRows(groups) {
  return [...groups.values()];
}

function buildDiscountRows(sales, { reasonFilter, usersById, registersById, registerFilter }) {
  const byCashier = new Map();
  const byRegister = new Map();
  const byReason = new Map();
  let totalDiscountRwf = 0;
  let discountedSales = 0;

  const filteredSales = reasonFilter
    ? sales.filter((invoice) => (Array.isArray(invoice.lines) ? invoice.lines : []).some((line) => {
      const percent = Number(line.discountPct) || 0;
      const reason = String(line.discountReason || 'Unspecified').trim() || 'Unspecified';
      return percent > 0 && reason.toLocaleLowerCase() === reasonFilter;
    }))
    : sales;

  for (const invoice of filteredSales) {
    const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
    const matchingDiscount = lines.reduce((sum, line) => {
      const percent = Number(line.discountPct) || 0;
      const base = Number(line.lineSubtotal);
      const discount = money((Number.isFinite(base) ? base : Number(line.qty) * Number(line.unitPrice)) * percent / 100);
      const reason = String(line.discountReason || 'Unspecified').trim() || 'Unspecified';
      if (!discount || (reasonFilter && reason.toLocaleLowerCase() !== reasonFilter)) return sum;
      addToGroup(byReason, reason.toLocaleLowerCase(), () => ({ reason, discountRwf: 0, lineCount: 0 }), (row) => {
        row.discountRwf = money(row.discountRwf + discount);
        row.lineCount += 1;
      });
      return sum + discount;
    }, 0);
    const invoiceDiscount = reasonFilter ? money(matchingDiscount) : money(invoice.totalDiscount);
    if (invoiceDiscount > 0) discountedSales += 1;
    totalDiscountRwf = money(totalDiscountRwf + invoiceDiscount);

    const cashierId = String(invoice.cashierId || '');
    const rawRegisterId = String(invoice.registerId || '');
    const register = registersById.get(rawRegisterId);
    if (registerFilter && register?.id !== registerFilter) continue;
    const registerId = register?.id || rawRegisterId;
    const cashierName = usersById.get(cashierId)?.name || 'Unknown cashier';
    const registerName = register?.name || (rawRegisterId ? `Unknown register (${rawRegisterId})` : 'Unknown register');
    const overridden = hasPriceOverride(invoice.posCheckoutPayload);
    addToGroup(byCashier, cashierId || 'unknown', () => ({
      cashierId: cashierId || null, cashierName, salesCount: 0, discountedSales: 0, discountRwf: 0, overrideSales: 0,
    }), (row) => {
      row.salesCount += 1;
      row.discountedSales += invoiceDiscount > 0 ? 1 : 0;
      row.discountRwf = money(row.discountRwf + invoiceDiscount);
      row.overrideSales += overridden ? 1 : 0;
    });
    addToGroup(byRegister, registerId || 'unknown', () => ({
      registerId: registerId || null, registerName, salesCount: 0, discountedSales: 0, discountRwf: 0, overrideSales: 0,
    }), (row) => {
      row.salesCount += 1;
      row.discountedSales += invoiceDiscount > 0 ? 1 : 0;
      row.discountRwf = money(row.discountRwf + invoiceDiscount);
      row.overrideSales += overridden ? 1 : 0;
    });
  }

  const withRates = (rows) => rows.map((row) => ({
    ...row,
    discountRatePercent: row.salesCount ? money(row.discountedSales / row.salesCount * 100) : 0,
    overrideRatePercent: row.salesCount ? money(row.overrideSales / row.salesCount * 100) : 0,
  }));
  return {
    salesCount: filteredSales.length,
    totalDiscountRwf,
    discountedSales,
    byCashier: withRates(cleanGroupRows(byCashier)).sort((a, b) => b.discountRwf - a.discountRwf),
    byRegister: withRates(cleanGroupRows(byRegister)).sort((a, b) => b.discountRwf - a.discountRwf),
    byReason: cleanGroupRows(byReason).sort((a, b) => b.discountRwf - a.discountRwf),
  };
}

function buildVoucherRows(redemptions, invoiceRegisterById) {
  const groups = new Map();
  let totalCostRwf = 0;
  let usageCount = 0;
  let restoredCount = 0;
  for (const row of redemptions) {
    const name = String(row.voucher?.name || 'Voucher');
    const amount = Math.abs(Number(row.discountRwf) || 0);
    const redeemedAt = row.redeemedAt ? new Date(row.redeemedAt) : null;
    const restoredAt = row.restoredAt ? new Date(row.restoredAt) : null;
    const registerName = invoiceRegisterById.get(String(row.invoiceId)) || 'Unknown register';
    const key = `${row.voucherId}:${registerName}`;
    addToGroup(groups, key, () => ({
      voucherId: String(row.voucherId), voucherName: name, registerName, usageCount: 0, restoredCount: 0, redeemedCostRwf: 0, restoredCostRwf: 0, netCostRwf: 0,
    }), (group) => {
      if (redeemedAt && !Number.isNaN(redeemedAt.getTime())) {
        group.usageCount += 1;
        group.redeemedCostRwf = money(group.redeemedCostRwf + amount);
        usageCount += 1;
        totalCostRwf = money(totalCostRwf + amount);
      }
      if (restoredAt && !Number.isNaN(restoredAt.getTime())) {
        group.restoredCount += 1;
        group.restoredCostRwf = money(group.restoredCostRwf + amount);
        restoredCount += 1;
        totalCostRwf = money(totalCostRwf - amount);
      }
      group.netCostRwf = money(group.redeemedCostRwf - group.restoredCostRwf);
    });
  }
  return {
    usageCount,
    restoredCount,
    netCostRwf: totalCostRwf,
    byVoucher: cleanGroupRows(groups).sort((a, b) => b.netCostRwf - a.netCostRwf),
  };
}

function buildApprovalRows(requests, pinApprovals, filters) {
  const groups = new Map();
  const matchAction = (action) => !filters.action || String(action).toLocaleLowerCase() === filters.action.toLocaleLowerCase();
  for (const row of requests) {
    if (!matchAction(row.action)) continue;
    addToGroup(groups, String(row.action), () => ({
      action: String(row.action), requests: 0, approved: 0, rejected: 0, expired: 0, pending: 0, pinApprovals: 0,
    }), (group) => {
      group.requests += 1;
      const status = String(row.status || '').toLocaleLowerCase();
      if (status === 'approved') group.approved += 1;
      else if (status === 'rejected') group.rejected += 1;
      else if (status === 'expired') group.expired += 1;
      else if (status === 'pending') group.pending += 1;
    });
  }
  for (const row of pinApprovals) {
    if (!matchAction(row.action)) continue;
    addToGroup(groups, String(row.action), () => ({
      action: String(row.action), requests: 0, approved: 0, rejected: 0, expired: 0, pending: 0, pinApprovals: 0,
    }), (group) => { group.pinApprovals += 1; });
  }
  return cleanGroupRows(groups).map((row) => ({
    ...row,
    approved: row.approved + row.pinApprovals,
  })).sort((a, b) => a.action.localeCompare(b.action));
}

async function getPosDiscountReports(companyId, input = {}, client = dbClient()) {
  const filters = reportFilters(input);
  const selectedRegister = filters.registerId
    ? await client.posRegister.findFirst({
      where: { companyId: String(companyId), id: filters.registerId },
      select: { id: true, code: true, name: true },
    })
    : null;
  if (filters.registerId && !selectedRegister) {
    throw Object.assign(new Error('The selected POS register is not available for this company.'), {
      statusCode: 400,
      code: 'POS_REPORT_FILTER_INVALID',
    });
  }
  const invoiceWhere = {
    companyId: String(companyId),
    posOrigin: true,
    invoiceDate: { gte: filters.from, lt: filters.until },
    ...(filters.cashierId ? { cashierId: filters.cashierId } : {}),
    ...(selectedRegister ? { registerId: { in: [selectedRegister.id, selectedRegister.code] } } : {}),
  };
  const invoiceRows = await readReportRows(({ skip, take }) => client.invoice.findMany({
    where: invoiceWhere,
    skip,
    take,
    orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true, referenceNo: true, cashierId: true, registerId: true, invoiceDate: true, status: true,
      totalDiscount: true, totalAmount: true, posPricingSnapshot: true, posCheckoutPayload: true,
      lines: { select: { qty: true, unitPrice: true, lineSubtotal: true, discountPct: true, discountReason: true } },
    },
  }), 'sales');
  const sales = cappedWhereResult(invoiceRows, 'sales').filter((invoice) => isCompletedSale(invoice.status));
  const registerRefs = [...new Set(sales.map((row) => String(row.registerId || '')).filter(Boolean))];
  const cashierIds = [...new Set(sales.map((row) => String(row.cashierId || '')).filter(Boolean))];
  const [registers, users] = await Promise.all([
    readRegistersForRefs(client, companyId, registerRefs),
    readRowsForIds(client.user.findMany.bind(client.user), { companyId: String(companyId) }, 'id', cashierIds, { id: true, name: true }),
  ]);
  const registersById = new Map(registers.flatMap((row) => [
    [String(row.id), row],
    [String(row.code), row],
  ]));
  const usersById = new Map(users.map((row) => [String(row.id), row]));
  const discounts = buildDiscountRows(sales, {
    reasonFilter: filters.reason, usersById, registersById, registerFilter: selectedRegister?.id || null,
  });

  const redemptionWhere = {
    companyId: String(companyId),
    status: { in: ['REDEEMED', 'RESTORED'] },
    OR: [
      { redeemedAt: { gte: filters.from, lt: filters.until } },
      { restoredAt: { gte: filters.from, lt: filters.until } },
    ],
    ...(filters.cashierId ? { cashierId: filters.cashierId } : {}),
  };
  const redemptionRows = await readReportRows(({ skip, take }) => client.posVoucherRedemption.findMany({
      where: redemptionWhere,
      skip,
      take,
      orderBy: { id: 'asc' },
      select: {
        id: true, voucherId: true, invoiceId: true, cashierId: true, status: true, discountRwf: true, redeemedAt: true, restoredAt: true,
        voucher: { select: { name: true } },
      },
    }), 'voucher usage');
  const voucherInvoiceIds = [...new Set(redemptionRows.map((row) => String(row.invoiceId || '')).filter(Boolean))];
  const voucherInvoices = voucherInvoiceIds.length
    ? await readRowsForIds(client.invoice.findMany.bind(client.invoice), { companyId: String(companyId) }, 'id', voucherInvoiceIds, { id: true, registerId: true })
    : [];
  const voucherRegisterRefs = [...new Set(voucherInvoices.map((row) => String(row.registerId || '')).filter(Boolean))];
  const voucherRegisters = voucherRegisterRefs.length
    ? await readRegistersForRefs(client, companyId, voucherRegisterRefs)
    : [];
  const voucherRegistersById = new Map(voucherRegisters.flatMap((row) => [
    [String(row.id), row],
    [String(row.code), row],
  ]));
  const invoiceRegisterById = new Map(voucherInvoices.map((row) => {
    const register = voucherRegistersById.get(String(row.registerId || ''));
    return [String(row.id), register?.name || (row.registerId ? `Unknown register (${row.registerId})` : 'Unknown register')];
  }));
  const filteredRedemptions = redemptionRows.filter((row) => !selectedRegister
    || voucherInvoices.some((invoice) => String(invoice.id) === String(row.invoiceId)
      && voucherRegistersById.get(String(invoice.registerId || ''))?.id === selectedRegister.id));
  const vouchers = buildVoucherRows(filteredRedemptions, invoiceRegisterById);

  const approvalWhere = {
    companyId: String(companyId),
    createdAt: { gte: filters.from, lt: filters.until },
    ...(filters.cashierId ? { cashierId: filters.cashierId } : {}),
    ...(selectedRegister ? { registerId: selectedRegister.id } : {}),
    ...(filters.action ? { action: filters.action } : {}),
  };
  const pinWhere = {
    companyId: String(companyId),
    createdAt: { gte: filters.from, lt: filters.until },
    ...(filters.cashierId ? { requestedBy: filters.cashierId } : {}),
    ...(selectedRegister ? { registerId: selectedRegister.id } : {}),
    ...(filters.action ? { action: filters.action } : {}),
  };
  const [requests, pinApprovals] = await Promise.all([
    readReportRows(({ skip, take }) => client.posApprovalRequest.findMany({
      where: approvalWhere,
      skip,
      take,
      orderBy: { id: 'asc' },
      select: { id: true, action: true, status: true, cashierId: true, registerId: true },
    }), 'approval history'),
    readReportRows(({ skip, take }) => client.posApproval.findMany({
      where: pinWhere,
      skip,
      take,
      orderBy: { id: 'asc' },
      select: { id: true, action: true, requestedBy: true, registerId: true },
    }), 'PIN approvals'),
  ]);
  const approvalsByAction = buildApprovalRows(requests, pinApprovals, filters);
  const cashierRates = discounts.byCashier.map((row) => ({
    ...row,
    highDiscountRate: filters.minDiscountRatePercent != null && row.discountRatePercent >= filters.minDiscountRatePercent,
    highOverrideRate: filters.minOverrideRatePercent != null && row.overrideRatePercent >= filters.minOverrideRatePercent,
  })).filter((row) => (
    (filters.minDiscountRatePercent == null || row.discountRatePercent >= filters.minDiscountRatePercent)
    && (filters.minOverrideRatePercent == null || row.overrideRatePercent >= filters.minOverrideRatePercent)
  ));

  return {
    filters: {
      from: filters.from.toISOString().slice(0, 10),
      to: filters.to.toISOString().slice(0, 10),
      cashierId: filters.cashierId,
      registerId: filters.registerId,
      reason: filters.reason,
      action: filters.action,
      minDiscountRatePercent: filters.minDiscountRatePercent,
      minOverrideRatePercent: filters.minOverrideRatePercent,
    },
    summary: {
      salesCount: discounts.salesCount,
      discountedSales: discounts.discountedSales,
      totalDiscountRwf: discounts.totalDiscountRwf,
      voucherUsageCount: vouchers.usageCount,
      voucherRestoredCount: vouchers.restoredCount,
      voucherNetCostRwf: vouchers.netCostRwf,
    },
    discountsByCashier: cashierRates,
    discountsByRegister: discounts.byRegister,
    discountsByReason: discounts.byReason,
    vouchers,
    approvalsByAction,
  };
}

module.exports = { MAX_REPORT_DAYS, MAX_REPORT_ROWS, getPosDiscountReports, reportFilters };

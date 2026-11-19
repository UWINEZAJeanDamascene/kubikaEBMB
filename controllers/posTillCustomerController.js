'use strict';

const { dbClient } = require('../lib/prisma');
const ARService = require('../services/arService');

function scope(req) {
  return String(req.posAuthContext?.session?.companyId || req.posSession?.companyId || '');
}

exports.salespeople = async (req, res, next) => {
  try {
    const companyId = scope(req);
    const db = dbClient();
    const [directUsers, memberships] = await Promise.all([
      db.user.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, role: true, jobTitle: true }, orderBy: { name: 'asc' }, take: 250 }),
      db.companyUser.findMany({ where: { companyId, status: 'active', user: { isActive: true } }, select: { user: { select: { id: true, name: true, role: true, jobTitle: true } } }, take: 250 }),
    ]);
    const unique = new Map();
    for (const person of [...directUsers, ...memberships.map((row) => row.user).filter(Boolean)]) {
      unique.set(String(person.id), { id: String(person.id), name: person.name, role: person.role, jobTitle: person.jobTitle || null });
    }
    return res.json({ success: true, data: [...unique.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) });
  } catch (error) { return next(error); }
};

exports.repeatLastOrder = async (req, res, next) => {
  try {
    const companyId = scope(req);
    const clientId = String(req.params.clientId || '');
    if (!/^[a-f\d]{24}$/i.test(clientId)) return res.status(400).json({ success: false, code: 'POS_REPEAT_ORDER_CLIENT_INVALID', message: 'Select a valid customer before repeating an order.' });
    const invoice = await dbClient().invoice.findFirst({
      where: { companyId, clientId, posOrigin: true, status: { notIn: ['cancelled', 'voided', 'draft'] } },
      orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
      select: {
        id: true, referenceNo: true, invoiceDate: true,
        lines: { orderBy: { lineOrder: 'asc' }, select: { productId: true, qty: true, productName: true } },
      },
    });
    if (!invoice) return res.status(404).json({ success: false, code: 'POS_REPEAT_ORDER_NOT_FOUND', message: 'This customer has no completed POS order to repeat.' });
    const quantities = new Map();
    for (const line of invoice.lines) {
      const quantity = Number(line.qty);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const productId = String(line.productId);
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }
    return res.json({ success: true, data: {
      invoiceId: invoice.id,
      referenceNo: invoice.referenceNo,
      invoiceDate: invoice.invoiceDate,
      items: [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
    } });
  } catch (error) { return next(error); }
};

exports.customerStatement = async (req, res, next) => {
  try {
    const companyId = scope(req);
    const clientId = String(req.params.clientId || '');
    if (!/^[a-f\d]{24}$/i.test(clientId)) return res.status(400).json({ success: false, code: 'POS_STATEMENT_CLIENT_INVALID', message: 'Select a valid customer to view a statement.' });
    const statement = await ARService.getClientStatement(companyId, clientId, {});
    return res.json(statement);
  } catch (error) { return next(error); }
};

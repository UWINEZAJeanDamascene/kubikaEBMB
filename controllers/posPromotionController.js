const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');
const present = (row) => ({
  _id: row.id,
  name: row.name,
  code: row.code,
  discountType: row.discountType ?? row.discount_type,
  value: Number(row.value),
  startsAt: row.startsAt ?? row.starts_at,
  endsAt: row.endsAt ?? row.ends_at,
  isActive: row.isActive ?? row.is_active,
});

exports.list = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const now = new Date();
    const managerView = String(req.path || '').endsWith('/manage');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, name, code, discount_type, value, starts_at, ends_at, is_active
         FROM pos_promotions
        WHERE company_id = $1 ${managerView ? '' : 'AND is_active = TRUE AND starts_at <= $2 AND ends_at > $2'}
        ORDER BY is_active DESC, starts_at DESC, name ASC`,
      ...(managerView ? [companyId] : [companyId, now]),
    );
    return res.json({ success: true, data: rows.map(present) });
  } catch (error) { return next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim().toUpperCase();
    const discountType = String(req.body.discountType || '').toLowerCase();
    const value = Number(req.body.value);
    const startsAt = new Date(req.body.startsAt);
    const endsAt = new Date(req.body.endsAt);
    if (name.length < 2 || name.length > 120 || !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)
      || !['percent', 'fixed'].includes(discountType) || !Number.isFinite(value) || value <= 0
      || (discountType === 'percent' && value > 100)
      || value > Number.MAX_SAFE_INTEGER
      || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return res.status(400).json({
        success: false,
        code: 'POS_PROMOTION_INVALID',
        message: 'Enter a valid name, code, discount value, and date window.',
      });
    }
    const now = new Date();
    if (endsAt <= now) return res.status(400).json({ success: false, code: 'POS_PROMOTION_EXPIRED', message: 'Promotion end time must be in the future.' });
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pos_promotions (id, company_id, name, code, discount_type, value, starts_at, ends_at, is_active, created_by_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, code, discount_type, value, starts_at, ends_at, is_active`,
      generateObjectId(), companyId, name, code, discountType, value, startsAt, endsAt, String(req.user.id),
    );
    const row = rows[0];
    return res.status(201).json({ success: true, data: present(row) });
  } catch (error) {
    if (error?.code === 'P2002' || error?.code === '23505' || error?.meta?.code === '23505') return res.status(409).json({ success: false, code: 'POS_PROMOTION_CODE_EXISTS', message: 'That promotion code already exists in this workspace.' });
    return next(error);
  }
};

exports.setActive = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const id = String(req.params.promotionId || '');
    const isActive = req.body.isActive;
    if (typeof isActive !== 'boolean') return res.status(400).json({ success: false, code: 'POS_PROMOTION_ACTIVE_REQUIRED', message: 'isActive must be true or false.' });
    const rows = await prisma.$queryRawUnsafe(
      'UPDATE pos_promotions SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 RETURNING id, name, code, discount_type, value, starts_at, ends_at, is_active',
      isActive, id, companyId,
    );
    if (!rows.length) return res.status(404).json({ success: false, code: 'POS_PROMOTION_NOT_FOUND', message: 'Promotion was not found.' });
    const row = rows[0];
    return res.json({ success: true, data: present(row) });
  } catch (error) { return next(error); }
};

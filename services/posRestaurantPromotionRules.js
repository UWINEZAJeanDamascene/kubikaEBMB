'use strict';

function promotionError(message) {
  return Object.assign(new Error(message), { code: 'RESTAURANT_PROMOTION_INVALID', statusCode: 400 });
}

function normalizePromotion(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = String(source.name || '').normalize('NFKC').trim();
  const kind = String(source.kind || '').trim().toLowerCase();
  const amount = Number(source.value);
  const weekdays = Array.isArray(source.weekdays) ? [...new Set(source.weekdays.map(Number))] : [];
  const startMinute = Number(source.startMinute);
  const endMinute = Number(source.endMinute);
  const startsAt = source.startsAt ? new Date(source.startsAt) : null;
  const endsAt = source.endsAt ? new Date(source.endsAt) : null;

  if (!name || name.length > 120) throw promotionError('Promotion name must be between 1 and 120 characters.');
  if (!['fixed_price', 'percent'].includes(kind)) throw promotionError('Choose a fixed price or percentage discount.');
  if (!Number.isFinite(amount) || amount < 0 || (kind === 'percent' && amount > 100)) {
    throw promotionError(kind === 'percent' ? 'Percentage discount must be between 0 and 100.' : 'Promotion price must be zero or more.');
  }
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw promotionError('Choose at least one valid weekday for this promotion.');
  }
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439
    || !Number.isInteger(endMinute) || endMinute < 1 || endMinute > 1440
    || startMinute >= endMinute) {
    throw promotionError('Promotion end time must be after its start time on the same day.');
  }
  if ((startsAt && !Number.isFinite(startsAt.getTime())) || (endsAt && !Number.isFinite(endsAt.getTime()))
    || (startsAt && endsAt && startsAt >= endsAt)) {
    throw promotionError('Promotion dates must be valid and the end date must be after the start date.');
  }

  return {
    ...(source.id ? { id: String(source.id) } : {}),
    name,
    kind,
    value: amount,
    weekdays: weekdays.sort((left, right) => left - right),
    startMinute,
    endMinute,
    startsAt,
    endsAt,
    isEnabled: source.isEnabled !== false,
  };
}

function localScheduleParts(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch (error) {
    throw promotionError('The company timezone is invalid. Set a valid timezone before enabling promotions.');
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[values.weekday],
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function activePromotion(promotions, basePriceValue, nowValue, timeZone) {
  const basePrice = Number(basePriceValue);
  if (!Number.isFinite(basePrice) || basePrice < 0) throw promotionError('The menu price is invalid.');
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw promotionError('The current time is invalid.');
  const schedule = localScheduleParts(now, timeZone || 'Africa/Kigali');
  const eligible = (Array.isArray(promotions) ? promotions : [])
    .filter((promotion) => promotion.isEnabled
      && promotion.weekdays.includes(schedule.weekday)
      && schedule.minute >= promotion.startMinute
      && schedule.minute < promotion.endMinute
      && (!promotion.startsAt || new Date(promotion.startsAt) <= now)
      && (!promotion.endsAt || new Date(promotion.endsAt) > now))
    .map((promotion) => {
      const rawPrice = promotion.kind === 'fixed_price'
        ? Number(promotion.value)
        : basePrice * (1 - Number(promotion.value) / 100);
      return {
        promotion,
        unitPrice: Math.min(basePrice, Math.max(0, rawPrice)),
      };
    })
    .filter((entry) => entry.unitPrice < basePrice)
    .sort((left, right) => left.unitPrice - right.unitPrice
      || String(left.promotion.id || '').localeCompare(String(right.promotion.id || '')));

  if (!eligible.length) return { unitPrice: basePrice, promotion: null };
  const { promotion, unitPrice } = eligible[0];
  return {
    unitPrice,
    promotion: {
      id: promotion.id || null,
      name: promotion.name,
      kind: promotion.kind,
      value: Number(promotion.value),
      baseUnitPrice: basePrice,
      unitPrice,
      discountAmount: basePrice - unitPrice,
      appliedAt: now.toISOString(),
    },
  };
}

module.exports = {
  activePromotion,
  normalizePromotion,
};

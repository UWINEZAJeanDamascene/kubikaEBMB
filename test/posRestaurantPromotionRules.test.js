'use strict';

const {
  activePromotion,
  normalizePromotion,
} = require('../services/posRestaurantPromotionRules');

describe('Restaurant promotion rules', () => {
  const mondayAfternoon = new Date('2026-11-23T15:00:00.000Z');

  test('applies one eligible scheduled promotion using the company timezone', () => {
    const promotions = [
      normalizePromotion({
        id: 'later',
        name: 'Ten percent',
        kind: 'percent',
        value: 10,
        weekdays: [1],
        startMinute: 16 * 60,
        endMinute: 18 * 60,
      }),
      normalizePromotion({
        id: 'best',
        name: 'Happy hour price',
        kind: 'fixed_price',
        value: 850,
        weekdays: [1],
        startMinute: 16 * 60,
        endMinute: 18 * 60,
      }),
    ];

    expect(activePromotion(promotions, 1000, mondayAfternoon, 'Africa/Kigali')).toMatchObject({
      unitPrice: 850,
      promotion: {
        id: 'best',
        baseUnitPrice: 1000,
        discountAmount: 150,
      },
    });
  });

  test('does not apply outside the schedule and never increases the menu price', () => {
    const promotion = normalizePromotion({
      name: 'Morning price',
      kind: 'fixed_price',
      value: 1200,
      weekdays: [1],
      startMinute: 8 * 60,
      endMinute: 9 * 60,
    });

    expect(activePromotion([promotion], 1000, mondayAfternoon, 'Africa/Kigali')).toEqual({
      unitPrice: 1000,
      promotion: null,
    });
  });

  test('rejects invalid weekday/time and percentage values', () => {
    expect(() => normalizePromotion({
      name: 'Invalid',
      kind: 'percent',
      value: 101,
      weekdays: [1],
      startMinute: 10,
      endMinute: 20,
    })).toThrow('Percentage discount must be between 0 and 100.');
    expect(() => normalizePromotion({
      name: 'Invalid',
      kind: 'fixed_price',
      value: 100,
      weekdays: [1],
      startMinute: 20,
      endMinute: 20,
    })).toThrow('Promotion end time must be after its start time on the same day.');
  });
});

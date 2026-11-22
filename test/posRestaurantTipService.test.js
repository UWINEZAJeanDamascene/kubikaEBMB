'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));

const { normalizeCaptureInput } = require('../services/posRestaurantTipService');

describe('Restaurant cash-tip capture input', () => {
  test('keeps only the cash tender excess separate from the bill payment', () => {
    expect(normalizeCaptureInput({
      captureMode: 'keep_change',
      cashTendered: 1000,
      tipMethod: 'CASH',
    }, 850)).toEqual({
      amount: 150,
      captureMode: 'keep_change',
      tenderedAmount: 1000,
    });
  });

  test.each(['CARD', 'MTN_MOMO', 'AIRTEL_MONEY'])(
    'rejects %s tips instead of adding them to the bill tender',
    (tipMethod) => {
      expect(() => normalizeCaptureInput({
        amount: 100,
        tipMethod,
      }, 850)).toThrow(expect.objectContaining({
        code: 'RESTAURANT_TIP_CASH_ONLY',
      }));
    },
  );

  test('rejects zero, fractional, and over-range cash tips', () => {
    for (const amount of [0, 1.5, 2147483648]) {
      expect(() => normalizeCaptureInput({ amount }, 850)).toThrow(
        expect.objectContaining({ code: 'RESTAURANT_TIP_AMOUNT_INVALID' }),
      );
    }
  });

  test('rejects keep-change amounts that do not exceed the bill total', () => {
    expect(() => normalizeCaptureInput({
      captureMode: 'keep_change',
      cashTendered: 850,
    }, 850)).toThrow(expect.objectContaining({
      code: 'RESTAURANT_TIP_AMOUNT_INVALID',
    }));
  });
});

'use strict';

const {
  generateStoredValueCode,
  hashStoredValueCode,
  normalizeStoredValueCode,
} = require('../services/posStoredValueCodeService');

describe('stored value codes', () => {
  test('generates short readable gift-card codes without look-alike characters', () => {
    const codes = Array.from({ length: 100 }, generateStoredValueCode);
    expect(codes.every((code) => /^KB-[2-9A-HJ-KM-NP-Z]{4}-[2-9A-HJ-KM-NP-Z]{4}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('continues normalizing and hashing legacy long codes', () => {
    const legacyCode = 'KB-ABCDEF0123456789ABCDEF01';
    expect(normalizeStoredValueCode(` ${legacyCode.toLowerCase()} `)).toBe(legacyCode);
    expect(hashStoredValueCode(legacyCode)).toBe(hashStoredValueCode(` ${legacyCode.toLowerCase()} `));
  });
});

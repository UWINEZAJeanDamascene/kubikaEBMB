'use strict';

const crypto = require('crypto');
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function normalizeStoredValueCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function hashStoredValueCode(value) {
  return crypto.createHash('sha256').update(normalizeStoredValueCode(value)).digest('hex');
}

function generateStoredValueCode() {
  const segment = () => Array.from(
    { length: 4 },
    () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)],
  ).join('');
  return `KB-${segment()}-${segment()}`;
}

module.exports = {
  normalizeStoredValueCode,
  hashStoredValueCode,
  generateStoredValueCode,
};

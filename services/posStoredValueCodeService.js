'use strict';

const crypto = require('crypto');

function normalizeStoredValueCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function hashStoredValueCode(value) {
  return crypto.createHash('sha256').update(normalizeStoredValueCode(value)).digest('hex');
}

function generateStoredValueCode() {
  return `KB-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

module.exports = {
  normalizeStoredValueCode,
  hashStoredValueCode,
  generateStoredValueCode,
};

const crypto = require('crypto');

function drawerCommand(pin = 2, onMs = 25, offMs = 500) {
  return Buffer.from([0x1b, 0x70, pin === 5 ? 0x01 : 0x00,
    Math.max(1, Math.min(255, Math.round(onMs / 2))),
    Math.max(1, Math.min(255, Math.round(offMs / 2)))]);
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(typeof payload === 'string' ? payload : JSON.stringify(payload)).digest('hex');
}

module.exports = { drawerCommand, payloadHash };

'use strict';

const { pbkdf2, randomBytes } = require('crypto');
const { issueCapability } = require('./posOfflineCapabilityService');

const OFFLINE_PIN_HASH_ITERATIONS = 210000;
const OFFLINE_PIN_HASH_BYTES = 32;

function pbkdf2Async(pin, salt, iterations) {
  return new Promise((resolve, reject) => {
    pbkdf2(pin, salt, iterations, OFFLINE_PIN_HASH_BYTES, 'sha256', (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function contextBoundPin({ companyId, deviceId, registerId, userId, pin }) {
  return [
    String(companyId),
    String(deviceId),
    String(registerId),
    String(userId),
    String(pin),
  ].join(':');
}

async function createOfflinePinVerifier({ companyId, deviceId, registerId, userId, pin, expiresAt }) {
  const salt = randomBytes(16);
  const issuedAt = Date.now();
  const hash = await pbkdf2Async(
    contextBoundPin({ companyId, deviceId, registerId, userId, pin }),
    salt,
    OFFLINE_PIN_HASH_ITERATIONS,
  );
  return {
    version: 1,
    companyId: String(companyId),
    deviceId: String(deviceId),
    registerId: String(registerId),
    userId: String(userId),
    algorithm: 'PBKDF2-SHA-256',
    iterations: OFFLINE_PIN_HASH_ITERATIONS,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
    expiresAt: new Date(expiresAt).toISOString(),
    authCapability: issueCapability({
      companyId: String(companyId),
      deviceId: String(deviceId),
      registerId: String(registerId),
      userId: String(userId),
      issuedAt,
      expiresAt: new Date(expiresAt).getTime(),
    }),
  };
}

module.exports = {
  OFFLINE_PIN_HASH_ITERATIONS,
  createOfflinePinVerifier,
};

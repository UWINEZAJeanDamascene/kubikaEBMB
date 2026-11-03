'use strict';

const crypto = require('crypto');

const ENCRYPTED_MARKER = '__posProviderEncryptedV1';

function getEncryptionKey() {
  const configured = String(process.env.POS_PROVIDER_ENCRYPTION_KEY || '').trim();
  if (!configured) {
    throw Object.assign(new Error('Configure POS_PROVIDER_ENCRYPTION_KEY before saving mobile money credentials.'), {
      code: 'POS_PROVIDER_ENCRYPTION_KEY_REQUIRED',
      statusCode: 503,
    });
  }

  const key = /^[a-f\d]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw Object.assign(new Error('POS_PROVIDER_ENCRYPTION_KEY must encode exactly 32 bytes.'), {
      code: 'POS_PROVIDER_ENCRYPTION_KEY_INVALID',
      statusCode: 503,
    });
  }
  return key;
}

function encryptProviderConfig(value) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    [ENCRYPTED_MARKER]: true,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
  };
}

function decryptProviderConfig(value) {
  if (!value || value[ENCRYPTED_MARKER] !== true) return {};
  const key = getEncryptionKey();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(value.value, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const config = JSON.parse(decrypted);
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch (error) {
    throw Object.assign(new Error('Stored POS provider credentials could not be decrypted.'), {
      code: 'POS_PROVIDER_CONFIG_DECRYPT_FAILED',
      statusCode: 503,
      cause: error,
    });
  }
}

module.exports = {
  ENCRYPTED_MARKER,
  encryptProviderConfig,
  decryptProviderConfig,
};

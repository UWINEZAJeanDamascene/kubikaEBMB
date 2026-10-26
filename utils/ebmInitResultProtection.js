const crypto = require('crypto');

const ENCRYPTED_MARKER = '__ebmEncryptedV1';
const SECRET_FIELD = /^(intrlKey|signKey|cmcKey)$/i;

function getEncryptionKey() {
  const configured = String(process.env.EBM_INIT_ENCRYPTION_KEY || '').trim();
  if (!configured) return null;

  let key;
  if (/^[a-f\d]{64}$/i.test(configured)) key = Buffer.from(configured, 'hex');
  else key = Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    const error = new Error('EBM_INIT_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hexadecimal characters or base64.');
    error.code = 'EBM_INIT_ENCRYPTION_KEY_INVALID';
    error.statusCode = 503;
    throw error;
  }
  return key;
}

function assertInitEncryptionConfigured() {
  if (!getEncryptionKey()) {
    const error = new Error('Configure EBM_INIT_ENCRYPTION_KEY before using sandbox or production device initialization.');
    error.code = 'EBM_INIT_ENCRYPTION_KEY_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
}

function encryptSecret(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    [ENCRYPTED_MARKER]: true,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: ciphertext.toString('base64'),
  };
}

function transformInitResult(value, transform, key, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => transformInitResult(item, transform, key));
  if (!value || typeof value !== 'object') return value;
  if (value[ENCRYPTED_MARKER] === true) return value;

  const result = {};
  for (const [field, nested] of Object.entries(value)) {
    result[field] = SECRET_FIELD.test(field)
      ? transform(nested, key)
      : transformInitResult(nested, transform, key, field);
  }
  return result;
}

function protectInitResult(response) {
  if (!response || typeof response !== 'object') return response;
  const containsSecret = (value) => {
    if (Array.isArray(value)) return value.some(containsSecret);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([field, nested]) => SECRET_FIELD.test(field) || containsSecret(nested));
  };
  if (!containsSecret(response)) return response;
  const key = getEncryptionKey();
  if (!key) {
    const error = new Error('Cannot persist VSDC initialization keys because EBM_INIT_ENCRYPTION_KEY is not configured.');
    error.code = 'EBM_INIT_ENCRYPTION_KEY_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
  return transformInitResult(response, encryptSecret, key);
}

function decryptSecret(encrypted, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function decryptInitResult(response) {
  if (!response || typeof response !== 'object') return response;
  const key = getEncryptionKey();
  if (!key) {
    const error = new Error('EBM_INIT_ENCRYPTION_KEY is required to decrypt stored VSDC initialization keys.');
    error.code = 'EBM_INIT_ENCRYPTION_KEY_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
  return transformInitResult(response, decryptSecret, key);
}

module.exports = {
  ENCRYPTED_MARKER,
  assertInitEncryptionConfigured,
  protectInitResult,
  decryptInitResult,
};

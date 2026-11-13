'use strict';

const { createHash, randomBytes } = require('crypto');
const { generateObjectId } = require('../utils/objectId');
const {
  POS_APP_CURRENT_VERSION,
  POS_APP_MINIMUM_VERSION,
  isSupportedPosAppVersion,
  validPosDevicePublicKey,
} = require('./posSyncOperationContract');

function hashDeviceToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function deviceKeyFingerprint(publicKey) {
  return publicKey
    ? createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 24)
    : null;
}

function validateEnrollment({ publicKey, appVersion }) {
  if (!validPosDevicePublicKey(publicKey)) {
    return {
      status: 400,
      code: 'POS_DEVICE_PUBLIC_KEY_INVALID',
      message: 'Enroll with a valid P-256 device public key.',
    };
  }
  if (!isSupportedPosAppVersion(appVersion)) {
    return {
      status: 409,
      code: 'POS_SYNC_VERSION_UNSUPPORTED',
      message: `Update Kubika POS to a supported version (${POS_APP_MINIMUM_VERSION} through ${POS_APP_CURRENT_VERSION}) before enrolling this device.`,
    };
  }
  return null;
}

function newDeviceId() {
  return generateObjectId();
}

function newDeviceToken() {
  return randomBytes(32).toString('base64url');
}

module.exports = {
  deviceKeyFingerprint,
  hashDeviceToken,
  newDeviceId,
  newDeviceToken,
  validateEnrollment,
};

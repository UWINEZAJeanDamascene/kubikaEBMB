const { prisma } = require('../lib/prisma');

async function findClaimedRegister(companyId, registerId, deviceId) {
  const code = String(registerId || '').trim();
  const normalizedDeviceId = String(deviceId || '').trim().toLowerCase();
  if (!code || !/^[a-f0-9-]{36}$/.test(normalizedDeviceId)) return null;
  const device = await prisma.posDevice.findFirst({
    where: {
      companyId: String(companyId),
      deviceId: normalizedDeviceId,
      status: 'active',
      register: { companyId: String(companyId), code, isActive: true },
    },
    include: { register: true },
  });
  return device?.register || null;
}

function registerClaimRequiredError() {
  const error = new Error('This device is not claimed for an active company POS register. Claim a centrally managed register to continue.');
  error.statusCode = 403;
  error.code = 'POS_REGISTER_CLAIM_REQUIRED';
  return error;
}

module.exports = { findClaimedRegister, registerClaimRequiredError };

const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const secureRandom = (bytes = 32) => randomBytes(bytes).toString('base64url');

function createPairingCode() {
  return `KUBIKA-${randomBytes(4).toString('hex').toUpperCase()}`;
}

async function createPairing(req, registerId, name) {
  const companyId = String(req.user.company?._id || req.user.companyId || '');
  if (!/^[a-f\d]{24}$/i.test(companyId)) throw Object.assign(new Error('Invalid company'), { status: 400 });
  const requestedRegister = String(registerId || '').trim();
  if (!requestedRegister) throw Object.assign(new Error('Invalid register'), { status: 400 });
  const register = await prisma.posRegister.findFirst({
    where: {
      companyId,
      isActive: true,
      OR: [{ id: requestedRegister }, { code: requestedRegister }],
    },
    select: { id: true },
  });
  if (!register) throw Object.assign(new Error('Active register not found'), { status: 404 });

  const code = createPairingCode();
  const row = await prisma.posPrintPairingCode.create({
    data: {
      id: generateObjectId(),
      companyId,
      registerId: register.id,
      name: String(name || 'Kubika Print Agent').trim().slice(0, 120),
      codeHash: hash(code),
      createdById: String(req.user.id || req.user._id),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return { row, code };
}

async function pairAgent({ pairingCode, deviceId, name, platform, version }) {
  const pairingHash = hash(pairingCode);
  const now = new Date();
  const pairInTransaction = () => prisma.$transaction(async (tx) => {
    const pairing = await tx.posPrintPairingCode.findFirst({
      where: {
        codeHash: pairingHash,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!pairing) return { code: 'PRINT_PAIRING_INVALID' };

    const accessToken = secureRandom(48);
    const refreshToken = secureRandom(48);
    const companyId = String(pairing.companyId);
    const resolvedRegisterId = String(pairing.registerId);
    const resolvedDeviceId = String(deviceId).trim().slice(0, 80);
    const existingAgent = await tx.posPrintAgent.findFirst({
      where: {
        companyId,
        deviceId: resolvedDeviceId,
      },
    });
    const agentData = {
        id: generateObjectId(),
        companyId,
        registerId: resolvedRegisterId,
        name: String(name || pairing.name).trim().slice(0, 120),
        deviceId: resolvedDeviceId,
        status: 'active',
        accessTokenHash: hash(accessToken),
        refreshTokenHash: hash(refreshToken),
        accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
        platform: ['windows', 'linux', 'darwin'].includes(platform) ? platform : 'windows',
        version: version ? String(version).slice(0, 40) : null,
        lastSeenAt: now,
    };
    const agent = existingAgent
      ? await tx.posPrintAgent.update({
          where: { id: existingAgent.id },
          data: {
            registerId: resolvedRegisterId,
            name: agentData.name,
            status: 'active',
            revokedAt: null,
            accessTokenHash: agentData.accessTokenHash,
            refreshTokenHash: agentData.refreshTokenHash,
            accessExpiresAt: agentData.accessExpiresAt,
            platform: agentData.platform,
            version: agentData.version,
            lastSeenAt: now,
          },
        })
        : await tx.posPrintAgent.create({ data: agentData });
    await tx.posPrintPairingCode.update({
      where: { id: pairing.id },
      data: { usedAt: now, usedAgentId: agent.id },
    });
    return {
      agent,
      accessToken,
      refreshToken,
      companyId: pairing.companyId,
      registerId: pairing.registerId,
    };
  });
  let result;
  try {
    result = await pairInTransaction();
  } catch (error) {
    const target = error?.meta?.target;
    const isDeviceUniqueConflict = error?.code === 'P2002'
      && (Array.isArray(target)
        ? target.includes('company_id') && target.includes('device_id')
        : String(target || '').includes('company_id') && String(target || '').includes('device_id'));
    if (!isDeviceUniqueConflict) throw error;
    result = await pairInTransaction();
  }
  return result;
}

async function authenticateAgent(req) {
  const authorization = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  return prisma.posPrintAgent.findFirst({
    where: {
      accessTokenHash: hash(match[1]),
      status: 'active',
      revokedAt: null,
      accessExpiresAt: { gt: new Date() },
    },
  });
}

async function refreshAgentToken(refreshToken) {
  const agent = await prisma.posPrintAgent.findFirst({
    where: { refreshTokenHash: hash(refreshToken), status: 'active', revokedAt: null },
  });
  if (!agent) return null;
  const accessToken = secureRandom(48);
  const newRefreshToken = secureRandom(48);
  const updated = await prisma.posPrintAgent.update({
    where: { id: agent.id },
    data: {
      accessTokenHash: hash(accessToken),
      refreshTokenHash: hash(newRefreshToken),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      lastSeenAt: new Date(),
    },
  });
  return { agent: updated, accessToken, refreshToken: newRefreshToken };
}

module.exports = {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  hash,
  createPairing,
  pairAgent,
  authenticateAgent,
  refreshAgentToken,
};

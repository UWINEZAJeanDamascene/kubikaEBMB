const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { drawerActionEnabled, resolveDrawerSettings } = require('./posDrawerPolicyService');

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
    if (existingAgent && String(existingAgent.registerId || '') !== String(resolvedRegisterId)) {
      throw Object.assign(new Error('This device is already paired to a different register and cannot be silently rebound.'), {
        code: 'PRINT_PAIRING_REGISTER_MISMATCH',
        companyId,
        registerId: existingAgent.registerId,
        deviceId: resolvedDeviceId,
      });
    }
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

async function rebindAgent({ companyId, agentId, registerId }) {
  return prisma.$transaction(async (tx) => {
    const register = await tx.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
      select: { id: true },
    });
    if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };

    const agent = await tx.posPrintAgent.findFirst({
      where: { id: agentId, companyId },
    });
    if (!agent) return { code: 'PRINT_AGENT_NOT_FOUND' };

    const now = new Date();
    const updated = await tx.posPrintAgent.update({
      where: { id: agent.id },
      data: {
        registerId: register.id,
        status: 'active',
        revokedAt: null,
        accessTokenHash: hash(secureRandom(48)),
        refreshTokenHash: hash(secureRandom(48)),
        accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
        lastSeenAt: now,
      },
    });
    return { agent: updated, previousRegisterId: agent.registerId };
  });
}

async function issueDrawerAuthorization({
  companyId,
  registerId,
  actionType,
  actionId,
  shiftId,
  requesterId,
  approvalId,
  reason,
  ttlSeconds = 15,
}) {
  const allowedActions = ['cash-sale', 'no-sale', 'paid-in', 'paid-out', 'shift-open', 'shift-close', 'test'];
  if (
    !allowedActions.includes(actionType)
    || !actionId
    || !requesterId
    || !reason
    || (actionType !== 'test' && !shiftId)
    || (actionType === 'no-sale' && (!approvalId || !/^[a-f\d]{24}$/i.test(String(actionId))))
  ) {
    return { code: 'PRINT_DRAWER_AUTHORIZATION_INVALID' };
  }
  const register = await prisma.posRegister.findFirst({
    where: { id: registerId, companyId, isActive: true },
    select: { id: true, code: true, systemTillType: true },
  });
  if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };

  const companySettings = await prisma.systemSettings.findUnique({
    where: { companyId },
    select: { posDrawerSettings: true },
  });
  const settings = resolveDrawerSettings(companySettings?.posDrawerSettings, register.systemTillType, registerId);
  let actionContext = { approvalId, reason };
  let authorizedShiftId = shiftId || null;

  if (actionType === 'cash-sale') {
    const sale = await prisma.invoice.findFirst({
      where: {
        id: String(actionId),
        companyId,
        OR: [{ registerId }, ...(register.code ? [{ registerId: register.code }] : [])],
      },
      select: { id: true, shiftId: true, tillSessionId: true, cashierId: true },
    });
    if (!sale
      || (sale.cashierId && String(sale.cashierId) !== String(requesterId))
      || (shiftId && ![sale.shiftId, sale.tillSessionId].some((id) => String(id || '') === String(shiftId)))) {
      return { code: 'PRINT_DRAWER_ACTION_NOT_FOUND' };
    }
    authorizedShiftId = sale.shiftId || sale.tillSessionId || authorizedShiftId;
    const tenders = await prisma.posPayment.findMany({
      where: { companyId, saleId: sale.id, registerId, status: 'SUCCESS' },
      select: { method: true, amount: true, changeGiven: true },
    });
    actionContext = {
      ...actionContext,
      cashTenderAmount: tenders.filter((payment) => payment.method === 'CASH')
        .reduce((total, payment) => total + Number(payment.amount || 0), 0),
      changeDue: tenders.filter((payment) => payment.method === 'CASH')
        .reduce((total, payment) => total + Number(payment.changeGiven || 0), 0),
    };
  } else if (actionType === 'paid-in' || actionType === 'paid-out') {
    const movement = await prisma.posCashMovement.findFirst({
      where: {
        id: String(actionId),
        companyId,
        registerId,
        shiftId: shiftId || undefined,
        type: actionType === 'paid-in' ? 'cash_in' : 'cash_out',
      },
      select: { id: true, amount: true, performedById: true },
    });
    if (!movement || Number(movement.amount) <= 0 || String(movement.performedById) !== String(requesterId)) {
      return { code: 'PRINT_DRAWER_ACTION_NOT_FOUND' };
    }
  } else if (actionType === 'shift-open' || actionType === 'shift-close') {
    const shift = await prisma.posShift.findFirst({
      where: {
        id: shiftId || String(actionId),
        companyId,
        registerId,
        ...(actionType === 'shift-open'
          ? { status: { in: ['open', 'reopened'] }, openedById: requesterId }
          : { status: 'closed', closedById: requesterId }),
      },
      select: { id: true, managerId: true },
    });
    if (!shift) return { code: 'PRINT_DRAWER_ACTION_NOT_FOUND' };
  } else if (actionType === 'no-sale') {
    const approval = await prisma.posManagerApproval.findFirst({
      where: {
        id: approvalId,
        companyId,
        cashierId: requesterId,
        action: 'no_sale',
        subjectId: shiftId,
        usedAt: { not: null },
      },
      select: { id: true, managerId: true },
    });
    const till = await prisma.tillSession.findFirst({
      where: { id: shiftId, companyId, openedById: requesterId, status: 'open' },
      select: { id: true, registerId: true, cashActivity: true },
    });
    const recordedNoSale = Array.isArray(till?.cashActivity) && till.cashActivity.some((activity) => (
      activity?.type === 'no_sale'
      && String(activity.id || '') === String(actionId)
      && String(activity.recordedBy || '') === String(requesterId)
      && String(activity.approvedById || '') === String(approval?.managerId || '')
    ));
    if (!approval || !till || (till.registerId !== 'legacy' && till.registerId !== register.code) || !recordedNoSale) {
      return { code: 'PRINT_DRAWER_APPROVAL_REQUIRED' };
    }
  }
  if (!drawerActionEnabled(settings, actionType, actionContext)) {
    return { code: actionType === 'cash-sale' && settings.onlyWhenChangeDue === true
      ? 'PRINT_DRAWER_CHANGE_NOT_DUE'
      : 'PRINT_DRAWER_TRIGGER_DISABLED' };
  }

  const token = secureRandom(32);
  const now = new Date();
  const safeTtlSeconds = Math.max(1, Math.min(30, Number(ttlSeconds) || 15));
  const authorization = await prisma.posPrintDrawerAuthorization.create({
    data: {
      id: generateObjectId(),
      companyId,
      registerId,
      tokenHash: hash(token),
      actionType,
      actionId: String(actionId).slice(0, 160),
      shiftId: authorizedShiftId,
      requesterId,
      approvalId: approvalId || null,
      reason: String(reason).trim().slice(0, 500),
      expiresAt: new Date(now.getTime() + safeTtlSeconds * 1000),
    },
  });
  return { authorization, token };
}

async function consumeDrawerAuthorization({ token, agent }) {
  if (!token || !agent?.companyId || !agent?.registerId) return { code: 'PRINT_DRAWER_AUTHORIZATION_INVALID' };
  return prisma.$transaction(async (tx) => {
    const authorization = await tx.posPrintDrawerAuthorization.findFirst({
      where: { tokenHash: hash(token), companyId: agent.companyId },
    });
    if (!authorization) return { code: 'PRINT_DRAWER_AUTHORIZATION_INVALID' };
    if (String(authorization.registerId) !== String(agent.registerId)) {
      return { code: 'PRINT_DRAWER_AUTHORIZATION_REGISTER_MISMATCH', authorization };
    }
    const now = new Date();
    if (authorization.expiresAt <= now) return { code: 'PRINT_DRAWER_AUTHORIZATION_EXPIRED', authorization };
    if (authorization.usedAt) return { code: 'PRINT_DRAWER_AUTHORIZATION_REUSED', authorization };

    const consumed = await tx.posPrintDrawerAuthorization.updateMany({
      where: {
        id: authorization.id,
        companyId: agent.companyId,
        registerId: agent.registerId,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now, outcome: 'authorized' },
    });
    if (consumed.count !== 1) return { code: 'PRINT_DRAWER_AUTHORIZATION_REUSED', authorization };
    return { authorization: { ...authorization, usedAt: now, outcome: 'authorized' } };
  });
}

async function recordDrawerAuthorizationOutcome({ authorizationId, companyId, registerId, outcome }) {
  if (!authorizationId || !companyId || !registerId || !['opened', 'failed'].includes(outcome)) {
    return { code: 'PRINT_DRAWER_OUTCOME_INVALID' };
  }
  const authorization = await prisma.posPrintDrawerAuthorization.findFirst({
    where: { id: authorizationId, companyId, registerId, usedAt: { not: null } },
  });
  if (!authorization) return { code: 'PRINT_DRAWER_AUTHORIZATION_NOT_FOUND' };
  if (authorization.outcome !== 'authorized') return { code: 'PRINT_DRAWER_OUTCOME_ALREADY_RECORDED', authorization };
  const outcomeAt = new Date();
  const updated = await prisma.posPrintDrawerAuthorization.updateMany({
    where: { id: authorization.id, companyId, registerId, usedAt: authorization.usedAt, outcome: 'authorized' },
    data: { outcome, outcomeAt },
  });
  if (updated.count !== 1) return { code: 'PRINT_DRAWER_OUTCOME_ALREADY_RECORDED', authorization };
  return { authorization: { ...authorization, outcome, outcomeAt } };
}

module.exports = {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  hash,
  createPairing,
  pairAgent,
  authenticateAgent,
  refreshAgentToken,
  rebindAgent,
  issueDrawerAuthorization,
  consumeDrawerAuthorization,
  recordDrawerAuthorizationOutcome,
};

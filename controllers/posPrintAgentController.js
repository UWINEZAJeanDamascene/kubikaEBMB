const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { createPairing, pairAgent, authenticateAgent, refreshAgentToken, hash } = require('../services/posPrintAgentService');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');

exports.createPairing = async (req, res, next) => {
  try {
    const registerId = String(req.body.registerId || '');
    const { row, code } = await createPairing(req, registerId, req.body.name);
    await writePosAuditLog({
      companyId: companyIdFor(req), registerId: row.registerId, userId: req.user.id || req.user._id,
      event: 'PRINT_AGENT_PAIRING_CREATED', metadata: { pairingId: row.id, expiresAt: row.expiresAt }, ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { pairingId: row.id, code, expiresAt: row.expiresAt } });
  } catch (error) { next(error); }
};

exports.pair = async (req, res, next) => {
  try {
    const pairingCode = String(req.body.pairingCode || '').trim().toUpperCase();
    const deviceId = String(req.body.deviceId || '').trim();
    if (!deviceId || deviceId.length > 80 || !/^KUBIKA-[A-F0-9]{8}$/.test(pairingCode)) return res.status(400).json({ success: false, code: 'PRINT_PAIRING_INVALID', message: 'Invalid pairing request.' });
    const result = await pairAgent({ pairingCode, deviceId, name: req.body.name, platform: req.body.platform, version: req.body.version });
    if (!result.agent) return res.status(401).json({ success: false, code: 'PRINT_PAIRING_INVALID', message: 'Pairing code is invalid, expired, used, or revoked.' });
    await writePosAuditLog({
      companyId: result.companyId, registerId: result.registerId, event: 'PRINT_AGENT_PAIRED',
      metadata: { agentId: result.agent.id, deviceId: result.agent.deviceId, platform: result.agent.platform }, ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: {
        agentId: result.agent.id, accessToken: result.accessToken, refreshToken: result.refreshToken,
        accessExpiresAt: result.agent.accessExpiresAt,
        companyId: result.companyId,
        registerId: result.registerId,
      },
    });
  } catch (error) { next(error); }
};

exports.refresh = async (req, res, next) => {
  try {
    const result = await refreshAgentToken(String(req.body.refreshToken || ''));
    if (!result) return res.status(401).json({ success: false, code: 'PRINT_AGENT_UNAUTHORIZED', message: 'Refresh token is invalid or revoked.' });
    return res.json({ success: true, data: { accessToken: result.accessToken, refreshToken: result.refreshToken, accessExpiresAt: result.agent.accessExpiresAt } });
  } catch (error) { next(error); }
};

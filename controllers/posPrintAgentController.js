const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  createPairing,
  pairAgent,
  refreshAgentToken,
  rebindAgent,
  issueDrawerAuthorization,
  consumeDrawerAuthorization,
  recordDrawerAuthorizationOutcome,
} = require('../services/posPrintAgentService');

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
  } catch (error) {
    if (error?.code === 'PRINT_PAIRING_REGISTER_MISMATCH') {
      await writePosAuditLog({
        companyId: error.companyId,
        registerId: error.registerId,
        event: 'PRINT_AGENT_PAIRING_REBIND_DENIED',
        metadata: { deviceId: error.deviceId, reason: 'DEVICE_BOUND_TO_DIFFERENT_REGISTER' },
        ip: requestIp(req),
      });
      return res.status(409).json({
        success: false,
        code: error.code,
        message: 'This device is already paired to a different register. An authorized administrator must rebind it.',
      });
    }
    return next(error);
  }
};

exports.refresh = async (req, res, next) => {
  try {
    const result = await refreshAgentToken(String(req.body.refreshToken || ''));
    if (!result) return res.status(401).json({ success: false, code: 'PRINT_AGENT_UNAUTHORIZED', message: 'Refresh token is invalid or revoked.' });
    return res.json({ success: true, data: { accessToken: result.accessToken, refreshToken: result.refreshToken, accessExpiresAt: result.agent.accessExpiresAt } });
  } catch (error) { next(error); }
};

exports.rebind = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const agentId = String(req.params.agentId || '').trim();
    const registerId = String(req.body.registerId || '').trim();
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!/^[a-f\d]{24}$/i.test(agentId) || !/^[a-f\d]{24}$/i.test(registerId) || !reason) {
      return res.status(400).json({
        success: false,
        code: 'PRINT_AGENT_REBIND_INVALID',
        message: 'A valid agent, active register, and rebind reason are required.',
      });
    }
    const result = await rebindAgent({ companyId, agentId, registerId });
    if (result.code === 'POS_REGISTER_NOT_FOUND') {
      return res.status(404).json({ success: false, code: result.code, message: 'Active register not found for this company.' });
    }
    if (result.code === 'PRINT_AGENT_NOT_FOUND') {
      return res.status(404).json({ success: false, code: result.code, message: 'Print agent not found for this company.' });
    }
    await writePosAuditLog({
      companyId,
      registerId,
      userId: req.user.id || req.user._id,
      event: 'PRINT_AGENT_REBOUND',
      metadata: {
        agentId: result.agent.id,
        previousRegisterId: result.previousRegisterId,
        registerId,
        reason,
        credentialsRotated: true,
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { id: result.agent.id, registerId: result.agent.registerId, status: result.agent.status } });
  } catch (error) { return next(error); }
};

exports.issueDrawerAuthorization = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const result = await issueDrawerAuthorization({
      companyId,
      registerId: String(req.body.registerId || ''),
      actionType: String(req.body.actionType || ''),
      actionId: String(req.body.actionId || ''),
      shiftId: req.body.shiftId ? String(req.body.shiftId) : null,
      requesterId: String(req.user.id || req.user._id || ''),
      approvalId: req.body.approvalId ? String(req.body.approvalId) : null,
      reason: String(req.body.reason || ''),
      ttlSeconds: req.body.ttlSeconds,
    });
    if (result.code === 'POS_REGISTER_NOT_FOUND') {
      return res.status(404).json({ success: false, code: result.code, message: 'Active register not found for this company.' });
    }
    if (result.code) {
      return res.status(400).json({ success: false, code: result.code, message: 'Drawer authorization details are invalid.' });
    }
    await writePosAuditLog({
      companyId,
      registerId: result.authorization.registerId,
      userId: req.user.id || req.user._id,
      event: 'PRINT_DRAWER_AUTHORIZATION_ISSUED',
      metadata: {
        authorizationId: result.authorization.id,
        actionType: result.authorization.actionType,
        actionId: result.authorization.actionId,
        shiftId: result.authorization.shiftId,
        approvalId: result.authorization.approvalId,
        requesterId: result.authorization.requesterId,
        reason: result.authorization.reason,
        expiresAt: result.authorization.expiresAt,
      },
      ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: { authorizationId: result.authorization.id, token: result.token, expiresAt: result.authorization.expiresAt },
    });
  } catch (error) { return next(error); }
};

exports.consumeDrawerAuthorization = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const result = await consumeDrawerAuthorization({
      token: String(req.body.token || ''),
      agent,
    });
    if (result.code) {
      await writePosAuditLog({
        companyId: agent.companyId,
        registerId: agent.registerId,
        event: 'PRINT_DRAWER_KICK_DENIED',
        metadata: {
          authorizationId: result.authorization?.id || null,
          actionId: result.authorization?.actionId || null,
          actionType: result.authorization?.actionType || null,
          shiftId: result.authorization?.shiftId || null,
          approvalId: result.authorization?.approvalId || null,
          requesterId: result.authorization?.requesterId || null,
          reason: result.authorization?.reason || null,
          denialCode: result.code,
          outcome: 'denied',
        },
        ip: requestIp(req),
      });
      const status = result.code === 'PRINT_DRAWER_AUTHORIZATION_EXPIRED' ? 410
        : result.code === 'PRINT_DRAWER_AUTHORIZATION_REUSED' ? 409
          : 403;
      return res.status(status).json({ success: false, code: result.code, message: 'Drawer authorization is invalid, expired, used, or bound to another register.' });
    }
    await writePosAuditLog({
      companyId: agent.companyId,
      registerId: agent.registerId,
      event: 'PRINT_DRAWER_AUTHORIZATION_CONSUMED',
      metadata: {
        authorizationId: result.authorization.id,
        actionType: result.authorization.actionType,
        actionId: result.authorization.actionId,
        shiftId: result.authorization.shiftId,
        approvalId: result.authorization.approvalId,
        requesterId: result.authorization.requesterId,
        reason: result.authorization.reason,
        outcome: 'authorized',
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { authorized: true, authorizationId: result.authorization.id } });
  } catch (error) { return next(error); }
};

exports.recordAgentDrawerOutcome = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const authorizationId = String(req.params.authorizationId || '');
    const outcome = String(req.body.outcome || '');
    if (!/^[a-f\d]{24}$/i.test(authorizationId) || !['opened', 'failed'].includes(outcome)) {
      return res.status(400).json({ success: false, code: 'PRINT_DRAWER_OUTCOME_INVALID', message: 'Drawer outcome is invalid.' });
    }
    const result = await recordDrawerAuthorizationOutcome({
      authorizationId,
      companyId: String(agent.companyId),
      registerId: String(agent.registerId),
      outcome,
    });
    if (result.code) {
      const status = result.code === 'PRINT_DRAWER_AUTHORIZATION_NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ success: false, code: result.code, message: 'The drawer outcome could not be recorded.' });
    }
    const authorization = result.authorization;
    await writePosAuditLog({
      companyId: String(agent.companyId),
      registerId: String(agent.registerId),
      userId: authorization.requesterId || null,
      event: 'PRINT_DRAWER_KICK_OUTCOME_RECORDED',
      metadata: {
        authorizationId: authorization.id,
        actionType: authorization.actionType,
        actionId: authorization.actionId,
        approvalId: authorization.approvalId,
        shiftId: authorization.shiftId,
        requesterId: authorization.requesterId,
        reason: authorization.reason,
        outcome,
        outcomeAt: authorization.outcomeAt,
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { authorizationId, outcome, outcomeAt: authorization.outcomeAt } });
  } catch (error) { return next(error); }
};

exports.issueSessionDrawerAuthorization = async (req, res, next) => {
  try {
    const session = req.posSession;
    if (String(req.body.actionType || '') === 'test') {
      return res.status(403).json({ success: false, code: 'PRINT_DRAWER_TEST_ADMIN_REQUIRED', message: 'Drawer diagnostics require an administrator.' });
    }
    const registerId = String(req.body.registerId || '');
    if (registerId !== String(session.registerId)) {
      return res.status(403).json({ success: false, code: 'PRINT_DRAWER_AUTHORIZATION_REGISTER_MISMATCH', message: 'Authorization register must match the active cashier session.' });
    }
    const result = await issueDrawerAuthorization({
      companyId: String(session.companyId),
      registerId,
      actionType: String(req.body.actionType || ''),
      actionId: String(req.body.actionId || ''),
      shiftId: req.body.shiftId ? String(req.body.shiftId) : null,
      requesterId: String(session.userId),
      approvalId: req.body.approvalId ? String(req.body.approvalId) : null,
      reason: String(req.body.reason || ''),
      ttlSeconds: req.body.ttlSeconds,
    });
    if (result.code === 'POS_REGISTER_NOT_FOUND') {
      return res.status(404).json({ success: false, code: result.code, message: 'Active register not found for this company.' });
    }
    if (result.code) {
      return res.status(400).json({ success: false, code: result.code, message: 'Drawer authorization details are invalid.' });
    }
    await writePosAuditLog({
      companyId: String(session.companyId),
      registerId,
      userId: String(session.userId),
      event: 'PRINT_DRAWER_AUTHORIZATION_ISSUED',
      metadata: {
        authorizationId: result.authorization.id,
        actionType: result.authorization.actionType,
        actionId: result.authorization.actionId,
        shiftId: result.authorization.shiftId,
        approvalId: result.authorization.approvalId,
        requesterId: result.authorization.requesterId,
        reason: result.authorization.reason,
        expiresAt: result.authorization.expiresAt,
      },
      ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: { authorizationId: result.authorization.id, token: result.token, expiresAt: result.authorization.expiresAt },
    });
  } catch (error) { return next(error); }
};

exports.consumeSessionDrawerAuthorization = async (req, res, next) => {
  try {
    const session = req.posSession;
    const result = await consumeDrawerAuthorization({
      token: String(req.body.token || ''),
      agent: { companyId: String(session.companyId), registerId: String(session.registerId) },
    });
    if (result.code) {
      await writePosAuditLog({
        companyId: String(session.companyId),
        registerId: String(session.registerId),
        userId: String(session.userId),
        event: 'PRINT_DRAWER_KICK_DENIED',
        metadata: {
          authorizationId: result.authorization?.id || null,
          actionId: result.authorization?.actionId || null,
          actionType: result.authorization?.actionType || null,
          shiftId: result.authorization?.shiftId || null,
          approvalId: result.authorization?.approvalId || null,
          requesterId: result.authorization?.requesterId || null,
          reason: result.authorization?.reason || null,
          outcome: 'denied',
          denialCode: result.code,
        },
        ip: requestIp(req),
      });
      const status = result.code === 'PRINT_DRAWER_AUTHORIZATION_EXPIRED' ? 410
        : result.code === 'PRINT_DRAWER_AUTHORIZATION_REUSED' ? 409
          : 403;
      return res.status(status).json({ success: false, code: result.code, message: 'Drawer authorization is invalid, expired, used, or bound to another register.' });
    }
    await writePosAuditLog({
      companyId: String(session.companyId),
      registerId: String(session.registerId),
      userId: String(session.userId),
      event: 'PRINT_DRAWER_AUTHORIZATION_CONSUMED',
      metadata: {
        authorizationId: result.authorization.id,
        actionType: result.authorization.actionType,
        actionId: result.authorization.actionId,
        shiftId: result.authorization.shiftId,
        approvalId: result.authorization.approvalId,
        requesterId: result.authorization.requesterId,
        reason: result.authorization.reason,
        outcome: 'authorized',
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { authorized: true, authorizationId: result.authorization.id } });
  } catch (error) { return next(error); }
};

exports.recordSessionDrawerOutcome = async (req, res, next) => {
  try {
    const session = req.posSession;
    const authorizationId = String(req.params.authorizationId || '');
    const outcome = String(req.body.outcome || '');
    if (!/^[a-f\d]{24}$/i.test(authorizationId) || !['opened', 'failed'].includes(outcome)) {
      return res.status(400).json({ success: false, code: 'PRINT_DRAWER_OUTCOME_INVALID', message: 'Drawer outcome is invalid.' });
    }
    const result = await recordDrawerAuthorizationOutcome({
      authorizationId,
      companyId: String(session.companyId),
      registerId: String(session.registerId),
      outcome,
    });
    if (result.code) {
      const status = result.code === 'PRINT_DRAWER_AUTHORIZATION_NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ success: false, code: result.code, message: 'The drawer outcome could not be recorded.' });
    }
    const authorization = result.authorization;
    await writePosAuditLog({
      companyId: String(session.companyId),
      registerId: String(session.registerId),
      userId: String(session.userId),
      event: 'PRINT_DRAWER_KICK_OUTCOME_RECORDED',
      metadata: {
        authorizationId: authorization.id,
        actionType: authorization.actionType,
        actionId: authorization.actionId,
        approvalId: authorization.approvalId,
        shiftId: authorization.shiftId,
        requesterId: authorization.requesterId,
        reason: authorization.reason,
        outcome,
        outcomeAt: authorization.outcomeAt,
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { authorizationId, outcome, outcomeAt: authorization.outcomeAt } });
  } catch (error) { return next(error); }
};

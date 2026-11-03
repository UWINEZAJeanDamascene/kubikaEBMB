const { generateObjectId } = require('../utils/objectId');

async function lockOpenPosShiftForRegister(client, companyId, registerId) {
  const rows = await client.$queryRawUnsafe(
    'SELECT "id" FROM "pos_shifts" WHERE "company_id" = $1 AND "register_id" = $2 AND "status" IN (\'open\', \'reopened\') FOR UPDATE',
    String(companyId),
    String(registerId),
  );
  return rows[0]?.id ? String(rows[0].id).trim() : null;
}

async function lockOpenPosShiftForRegisterCode(client, companyId, registerCode) {
  const rows = await client.$queryRawUnsafe(
    'SELECT shift."id" FROM "pos_shifts" AS shift JOIN "pos_registers" AS register ON register."id" = shift."register_id" WHERE shift."company_id" = $1 AND register."code" = $2 AND register."is_active" = TRUE AND shift."status" IN (\'open\', \'reopened\') FOR UPDATE OF shift',
    String(companyId),
    String(registerCode),
  );
  return rows[0]?.id ? String(rows[0].id).trim() : null;
}

async function findOpenPosShiftForRegisterCode(client, companyId, registerCode) {
  const rows = await client.$queryRawUnsafe(
    'SELECT shift."id" FROM "pos_shifts" AS shift JOIN "pos_registers" AS register ON register."id" = shift."register_id" WHERE shift."company_id" = $1 AND register."code" = $2 AND shift."status" IN (\'open\', \'reopened\') LIMIT 1',
    String(companyId),
    String(registerCode),
  );
  return rows[0]?.id ? String(rows[0].id).trim() : null;
}

async function findRegisterForShift(client, companyId, registerId) {
  return client.posRegister.findFirst({
    where: { id: String(registerId), companyId: String(companyId) },
    select: { id: true, code: true, name: true },
  });
}

async function lockRegisterForZNumber(client, companyId, registerId) {
  const rows = await client.$queryRawUnsafe(
    'SELECT "id" FROM "pos_registers" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE',
    String(registerId),
    String(companyId),
  );
  return rows[0]?.id ? String(rows[0].id).trim() : null;
}

async function findTillSessionForShift(client, { companyId, registerCode, shift, status }) {
  return client.tillSession.findFirst({
    where: {
      companyId: String(companyId),
      registerId: String(registerCode),
      openedById: String(shift.openedById),
      ...(status === 'closed' ? { openedAt: shift.openedAt } : {}),
      status,
    },
  });
}

async function openTillSessionForShift(client, {
  companyId,
  userId,
  register,
  shift,
  openingFloat,
  openingCount,
}) {
  const existing = await client.tillSession.findFirst({
    where: { companyId: String(companyId), registerId: String(register.code), status: 'open' },
    select: { id: true },
  });
  if (existing) {
    const error = new Error('This register already has an open cashier till.');
    error.code = 'POS_REGISTER_ALREADY_OPEN';
    throw error;
  }

  return client.tillSession.create({
    data: {
      id: generateObjectId(),
      companyId: String(companyId),
      openedById: String(userId),
      registerId: String(register.code),
      registerName: String(register.name),
      status: 'open',
      openingFloat,
      expectedCash: openingFloat,
      cashActivity: [{
        type: 'opening_float',
        amount: openingFloat,
        recordedBy: String(userId),
        recordedAt: shift.openedAt.toISOString(),
        posShiftId: String(shift.id),
        denominationCount: openingCount,
      }],
      openedAt: shift.openedAt,
    },
  });
}

async function closeTillSessionForShift(client, {
  companyId,
  registerCode,
  shift,
  closedAt,
  expectedCash,
  countedCash,
  variance,
  closeNotes,
  zReport,
}) {
  const till = await findTillSessionForShift(client, {
    companyId,
    registerCode,
    shift,
    status: 'open',
  });
  if (!till) {
    const error = new Error('The POS shift has no matching open till session.');
    error.code = 'POS_TILL_SHIFT_LINK_MISSING';
    throw error;
  }
  const activity = Array.isArray(till.cashActivity) ? till.cashActivity : [];
  return client.tillSession.update({
    where: { id: till.id },
    data: {
      status: 'closed',
      closedAt,
      expectedCash,
      closingCount: countedCash,
      cashVariance: variance,
      closeNotes: closeNotes || null,
      zReport,
      zReportGeneratedAt: closedAt,
      cashActivity: [...activity, {
        type: 'pos_shift_closed',
        posShiftId: String(shift.id),
        expectedCash,
        closingCount: countedCash,
        variance,
        recordedAt: closedAt.toISOString(),
      }],
    },
  });
}

async function reopenTillSessionForShift(client, { companyId, registerCode, shift, reopenedAt }) {
  const till = await findTillSessionForShift(client, {
    companyId,
    registerCode,
    shift,
    status: 'closed',
  });
  if (!till) {
    const error = new Error('The closed POS shift has no matching till session.');
    error.code = 'POS_TILL_SHIFT_LINK_MISSING';
    throw error;
  }
  const activity = Array.isArray(till.cashActivity) ? till.cashActivity : [];
  return client.tillSession.update({
    where: { id: till.id },
    data: {
      status: 'open',
      closedAt: null,
      closingCount: null,
      cashVariance: null,
      closeNotes: null,
      zReport: null,
      zReportGeneratedAt: null,
      expectedCash: Number(shift.expectedCash || 0),
      cashActivity: [...activity, {
        type: 'pos_shift_reopened',
        posShiftId: String(shift.id),
        recordedAt: reopenedAt.toISOString(),
      }],
    },
  });
}

async function recordTillCashMovement(client, {
  companyId,
  registerCode,
  shift,
  movement,
}) {
  const till = await findTillSessionForShift(client, {
    companyId,
    registerCode,
    shift,
    status: 'open',
  });
  if (!till) {
    const error = new Error('The open POS shift has no matching till session.');
    error.code = 'POS_TILL_SHIFT_LINK_MISSING';
    throw error;
  }
  const expectedCash = Number(till.expectedCash || 0)
    + (movement.type === 'cash_in' ? movement.amount : -movement.amount);
  const activity = Array.isArray(till.cashActivity) ? till.cashActivity : [];
  return client.tillSession.update({
    where: { id: till.id },
    data: {
      expectedCash,
      cashActivity: [...activity, {
        type: movement.type,
        amount: movement.amount,
        reasonCode: movement.reasonCode,
        note: movement.note,
        recordedBy: movement.performedById,
        recordedAt: new Date().toISOString(),
        posShiftId: String(shift.id),
      }],
    },
  });
}

module.exports = {
  lockOpenPosShiftForRegister,
  lockOpenPosShiftForRegisterCode,
  findOpenPosShiftForRegisterCode,
  findRegisterForShift,
  lockRegisterForZNumber,
  findTillSessionForShift,
  openTillSessionForShift,
  closeTillSessionForShift,
  reopenTillSessionForShift,
  recordTillCashMovement,
};

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { calculateExpectedCash, normalizePosShiftSettings } = require('../services/posShiftService');
const { postShiftVariance } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { getPosEbmSettings } = require('../services/posEbmSettingsService');
const { getPosZReportHighWaterMark } = require('../services/posZReportSequence');
const { releaseInvoiceReservations } = require('../services/posVoucherService');
const { retireUnusedReceiptNumbersForShift } = require('../services/posOfflineReceiptNumberService');
const { buildReport } = require('./tillZReportController');
const {
  findRegisterForShift,
  findTillSessionForShift,
  lockRegisterForZNumber,
  closeTillSessionForShift,
} = require('../services/posShiftLinkService');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_DATABASE_INT = 2147483647;

function invalidRequest(res, status, code, message, details = {}) {
  return res.status(status).json({ success: false, code, message, ...details });
}

function contextFor(req) {
  const context = req.posAuthContext;
  return {
    companyId: String(context.session.companyId),
    registerId: String(context.session.registerId),
    userId: String(context.session.userId),
  };
}

function requestIpAddress(req) {
  return requestIp(req);
}

function idempotencyKeyFrom(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function approvalTokenFrom(req) {
  return String(
    req.get?.('X-Pos-Approval-Token')
    || req.headers?.['x-pos-approval-token']
    || req.body?.approvalToken
    || '',
  ).trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeClosingCount(value, denominations) {
  if (!isPlainObject(value)) {
    throw new TypeError('closingCount must be an object containing denomination counts.');
  }
  const supportedKeys = new Set([...denominations.map(String), 'other']);
  if (Object.keys(value).some((key) => !supportedKeys.has(key))) {
    throw new TypeError('closingCount contains an unsupported denomination.');
  }

  const count = Object.fromEntries(denominations.map((denomination) => [String(denomination), 0]));
  count.other = 0;
  let total = 0;
  for (const denomination of denominations) {
    const key = String(denomination);
    const quantity = value[key] ?? 0;
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new TypeError(`closingCount.${key} must be a non-negative whole-number count.`);
    }
    count[key] = quantity;
    total += denomination * quantity;
  }

  const other = value.other ?? 0;
  if (!Number.isSafeInteger(other) || other < 0) {
    throw new TypeError('closingCount.other must be a non-negative whole-number RWF amount.');
  }
  count.other = other;
  total += other;
  if (!Number.isSafeInteger(total) || total > MAX_DATABASE_INT) {
    throw new RangeError('Closing cash exceeds the supported integer amount range.');
  }
  return { count, countedCash: total };
}

function closePayloadHash({ shiftId, userId, countedCash, closingCount, differenceReason }) {
  return createHash('sha256').update(JSON.stringify({
    shiftId,
    userId,
    countedCash,
    closingCount,
    differenceReason,
  })).digest('hex');
}

function centsOrWholeAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TypeError('A linked POS tender contains an invalid amount.');
  }
  return Math.round(amount);
}

function movementTotals(movements) {
  const totals = { cashIn: 0, cashOut: 0, safeDrops: 0 };
  for (const movement of movements) {
    if (movement.type === 'cash_in') totals.cashIn += movement.amount;
    if (movement.type === 'cash_out' || movement.type === 'REFUND') totals.cashOut += movement.amount;
    if (movement.type === 'safe_drop') totals.safeDrops += movement.amount;
  }
  return totals;
}

async function recheckExpiredProviderPayments() {
  return [];
}

function paymentAttemptSummary(payment) {
  const status = String(payment.status || '').toUpperCase();
  const method = String(payment.method || '').replace(/_/g, ' ');
  if (status === 'EXPIRED') return `${method} request expired`;
  if (status === 'FAILED') return `${method} payment failed`;
  if (status === 'CANCELLED') return `${method} request cancelled`;
  if (status === 'PENDING' || status === 'PENDING_VERIFICATION') return `${method} payment is still waiting`;
  if (status === 'SUCCESS') return `${method} payment received`;
  return `${method} payment ${status.toLowerCase()}`;
}

function pendingSaleSummary(invoice) {
  const payments = Array.isArray(invoice.posPayments) ? invoice.posPayments : [];
  const moneyReceived = payments.some((payment) => ['SUCCESS', 'UNMATCHED_SUCCESS'].includes(payment.status));
  const providerPending = payments.some((payment) => ['PENDING', 'PENDING_VERIFICATION'].includes(payment.status));
  const totalReceived = payments
    .filter((payment) => ['SUCCESS', 'UNMATCHED_SUCCESS'].includes(payment.status))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const totalRefunded = payments.reduce((sum, payment) => sum + (payment.refunds || [])
    .filter((refund) => refund.status === 'DONE')
    .reduce((subtotal, refund) => subtotal + Number(refund.amount || 0), 0), 0);
  return {
    saleId: invoice.id,
    referenceNo: invoice.referenceNo,
    totalAmount: Number(invoice.totalAmount || 0),
    amountReceived: totalReceived,
    amountRefunded: totalRefunded,
    balanceDue: Math.max(0, Number(invoice.totalAmount || 0) - totalReceived),
    paymentSummary: payments.map(paymentAttemptSummary),
    hasMoneyReceived: moneyReceived,
    hasProviderPending: providerPending,
    canTakeRemaining: moneyReceived && !providerPending
      && Number(invoice.totalAmount || 0) > totalReceived,
    canComplete: moneyReceived && !providerPending
      && Number(invoice.totalAmount || 0) <= totalReceived,
    canRefundAndCancel: moneyReceived && !providerPending,
  };
}

function invoiceTotals(invoices) {
  const totals = {
    transactionCount: invoices.length,
    gross: 0,
    discounts: 0,
    tax: 0,
    sales: 0,
    cashSales: 0,
    tenders: {},
  };
  for (const invoice of invoices) {
    totals.gross += Number(invoice.subtotal || 0);
    totals.discounts += Number(invoice.totalDiscount || 0);
    totals.tax += Number(invoice.taxAmount || 0);
    totals.sales += Number(invoice.totalAmount || 0);
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    for (const payment of payments) {
      const method = String(payment?.paymentMethod || 'unknown').toLowerCase();
      const amount = Number(payment?.amount || 0);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new TypeError('A linked POS invoice contains an invalid tender amount.');
      }
      totals.tenders[method] = (totals.tenders[method] || 0) + amount;
      if (method === 'cash') totals.cashSales += amount;
    }
  }
  totals.cashSales = centsOrWholeAmount(totals.cashSales);
  return totals;
}

async function findCashRefunds(client, companyId, shiftId) {
  return client.$queryRawUnsafe(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(refund->>'amount', '')::numeric, 0)), 0)::numeric AS amount,
            COUNT(*)::int AS count
       FROM credit_notes cn
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cn.payments, '[]'::jsonb)) AS refund
      WHERE cn.company_id = $1 AND refund->>'shiftId' = $2
        AND LOWER(COALESCE(refund->>'paymentMethod', '')) = 'cash'`,
    companyId,
    shiftId,
  );
}

async function findHeldSalesCount(client, companyId) {
  const rows = await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM "pos_held_sales" WHERE "company_id" = $1',
    companyId,
  );
  return Number(rows[0]?.count || 0);
}

function approvalContext({ shiftId, countedCash, expectedCash, variance, differenceReason }) {
  return { shiftId, countedCash, expectedCash, variance, differenceReason };
}

async function buildShiftReportSnapshot({
  queryClient,
  companyId,
  till,
  shift,
  reportNumber,
  now,
  differenceReason,
  approvedById,
  closedById,
  heldSalesCount,
  heldSalesPolicy,
  journalEntryId,
  postingStatus,
  cancelledAfterPaymentByCashier,
  fiscalClosePolicy,
  fiscalApprovedById,
}) {
  const snapshot = await buildReport(companyId, till, queryClient);
  snapshot.version = 2;
  snapshot.reportType = 'Z';
  snapshot.label = 'FINAL';
  snapshot.zNumber = reportNumber;
  snapshot.generatedAt = now.toISOString();
  snapshot.shift.id = shift.id;
  snapshot.shift.number = shift.shiftNumber;
  snapshot.shift.posRegisterId = shift.registerId;
  snapshot.shift.closedById = closedById;
  snapshot.sales.tenders = snapshot.paymentMethods;
  snapshot.cash.countedCash = snapshot.cash.count;
  snapshot.cash.differenceReason = differenceReason;
  snapshot.cash.approvedById = approvedById;
  snapshot.cash.journalEntryId = journalEntryId;
  snapshot.cash.postingStatus = postingStatus;
  snapshot.heldSales = { count: heldSalesCount, policy: heldSalesPolicy };
  snapshot.fiscalReceipts.policy = fiscalClosePolicy;
  snapshot.fiscalReceipts.closeApproval = fiscalApprovedById
    ? { approved: true, approvedById: fiscalApprovedById }
    : { approved: false, required: fiscalClosePolicy === 'REQUIRE_APPROVAL' && snapshot.fiscalReceipts.unsent.length > 0 };
  if (!snapshot.cancelledAfterPaymentByCashier) snapshot.cancelledAfterPaymentByCashier = [];
  return snapshot;
}

function sameClosedShift(existing, { shiftId, userId, payloadHash }) {
  return existing?.id === shiftId
    && existing?.closedById === userId
    && existing?.closePayloadHash === payloadHash;
}

exports.close = async (req, res, next) => {
  const key = idempotencyKeyFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalidRequest(
      res,
      400,
      'POS_IDEMPOTENCY_KEY_INVALID',
      'Provide an Idempotency-Key between 8 and 100 supported characters.',
    );
  }

  const { companyId, registerId, userId } = contextFor(req);
  const shiftId = String(req.params.shiftId || '');
  let payloadHash;
  const differenceReasonInput = req.body?.differenceReason;
  if (differenceReasonInput != null
    && (typeof differenceReasonInput !== 'string' || differenceReasonInput.trim().length > 500)) {
    return invalidRequest(res, 400, 'POS_SHIFT_DIFFERENCE_REASON_INVALID', 'Difference reason must be text no longer than 500 characters.');
  }
  const differenceReason = differenceReasonInput?.trim() || null;

  try {
    const savedSettings = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: {
        posCashDenominations: true,
        posVarianceTolerance: true,
        posVarianceApprovalLimit: true,
        posHeldSalesOnClose: true,
      },
    });
    const settings = normalizePosShiftSettings(savedSettings || undefined);
    const fiscalSettings = await getPosEbmSettings(prisma, companyId);
    let counted;
    try {
      counted = normalizeClosingCount(req.body?.closingCount, settings.denominations);
    } catch (error) {
      return invalidRequest(res, 400, 'POS_SHIFT_CLOSING_COUNT_INVALID', error.message);
    }
    payloadHash = closePayloadHash({
      shiftId,
      userId,
      countedCash: counted.countedCash,
      closingCount: counted.count,
      differenceReason,
    });
    const approvalToken = approvalTokenFrom(req);
    const fiscalApprovalToken = String(req.body?.fiscalApprovalToken || '').trim();
    const unconfirmedProviderPayments = await recheckExpiredProviderPayments({
      companyId,
      shiftId,
      registerId,
      userId,
      req,
    });
    if (unconfirmedProviderPayments.length) {
      return invalidRequest(
        res,
        409,
        'POS_PROVIDER_STATUS_UNCONFIRMED',
        'We could not confirm this payment yet. Try again in a moment.',
        { sales: unconfirmedProviderPayments },
      );
    }

    const result = await runInTransaction(async (tx) => {
      const previous = await tx.posShift.findFirst({
        where: { companyId, closeIdempotencyKey: key },
        include: { zReport: true },
      });
      if (previous) {
        if (previous.status === 'closed'
          && sameClosedShift(previous, { shiftId, userId, payloadHash })
        ) {
          const correctionReport = await tx.posShiftCorrectionReport.findFirst({
            where: { companyId, idempotencyKey: key },
          });
          return { shift: previous, zReport: previous.zReport, correctionReport, replayed: true };
        }
        return { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }
      const historicalKey = await tx.posShiftCorrectionReport.findFirst({
        where: { companyId, priorCloseIdempotencyKey: key },
        select: { id: true },
      });
      if (historicalKey) return { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      const priorCorrection = await tx.posShiftCorrectionReport.findFirst({
        where: { companyId, idempotencyKey: key },
        select: { id: true },
      });
      if (priorCorrection) return { code: 'POS_IDEMPOTENCY_KEY_REUSED' };

      const locked = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 AND "register_id" = $3 AND "status" IN (\'open\', \'reopened\') FOR UPDATE',
        shiftId,
        companyId,
        registerId,
      );
      if (!locked.length) {
        const alreadyClosed = await tx.posShift.findFirst({
          where: { id: shiftId, companyId, registerId },
          include: { zReport: true },
        });
        if (alreadyClosed?.status === 'closed'
          && sameClosedShift(alreadyClosed, { shiftId, userId, payloadHash })) {
          return { shift: alreadyClosed, zReport: alreadyClosed.zReport, replayed: true };
        }
        if (alreadyClosed?.status === 'closed') return { code: 'POS_SHIFT_ALREADY_CLOSED' };
        return { code: 'POS_SHIFT_NOT_OPEN' };
      }

      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId, status: { in: ['open', 'reopened'] } },
        include: {
          zReport: true,
          invoices: {
            where: { status: { notIn: ['cancelled', 'PENDING_PAYMENT'] } },
            select: {
              subtotal: true,
              totalDiscount: true,
              taxAmount: true,
              totalAmount: true,
              payments: true,
            },
          },
          cashMovements: { select: { type: true, amount: true } },
        },
      });
      if (!shift) return { code: 'POS_SHIFT_NOT_OPEN' };
      const unprintedReceiptCount = await tx.posPrintJob.count({
        where: {
          companyId,
          registerId,
          shiftId,
          localOnly: true,
          jobType: { in: ['receipt', 'refund-receipt'] },
          status: { in: ['queued', 'failed', 'transmitting', 'transmitted', 'uncertain'] },
        },
      });

      await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE company_id = $1 AND shift_id = $2 AND pos_origin = true AND status = $3 FOR UPDATE',
        companyId,
        shiftId,
        'PENDING_PAYMENT',
      );
      const pendingSales = await tx.invoice.findMany({
        where: { companyId, shiftId, posOrigin: true, status: 'PENDING_PAYMENT' },
        include: {
          posPayments: {
            include: { refunds: { where: { status: 'DONE' } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      });
      const salesWithMoneyReceived = [];
      const pendingProviderSales = [];
      const unpaidSalesAutoCancelled = [];
      for (const invoice of pendingSales) {
        const summary = pendingSaleSummary(invoice);
        if (summary.hasMoneyReceived) salesWithMoneyReceived.push(summary);
        if (summary.hasProviderPending) pendingProviderSales.push(summary);
        if (summary.hasMoneyReceived || summary.hasProviderPending) continue;

        const cancelledAt = new Date();
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: 'cancelled',
            cancelledAt,
            cancelledById: userId,
            cancellationReason: 'AUTO_CANCELLED_SHIFT_CLOSE',
          },
        });
        await releaseInvoiceReservations(tx, companyId, invoice.id, userId);
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'PENDING_SALE_AUTO_CANCELLED',
          metadata: {
            saleId: invoice.id,
            referenceNo: invoice.referenceNo,
            reason: 'AUTO_CANCELLED_SHIFT_CLOSE',
            paymentStatuses: (invoice.posPayments || []).map((payment) => payment.status),
          },
          ip: requestIpAddress(req),
        }, tx);
        unpaidSalesAutoCancelled.push({
          saleId: invoice.id,
          referenceNo: invoice.referenceNo,
          paymentSummary: (invoice.posPayments || []).map(paymentAttemptSummary),
        });
      }
      if (salesWithMoneyReceived.length || pendingProviderSales.length) {
        return {
          code: 'POS_SHIFT_PENDING_PAYMENTS',
          pendingPaymentCount: salesWithMoneyReceived.length + pendingProviderSales.length,
          salesWithMoneyReceived,
          pendingProviderSales,
          unpaidSalesAutoCancelled,
        };
      }

      const unsentFiscalReceipts = await tx.$queryRawUnsafe(
        `SELECT id, document_type AS "documentType", document_id AS "documentId",
                ebm_status AS "ebmStatus", is_retryable AS "isRetryable",
                payload->>'totAmt' AS amount, last_error->>'code' AS "errorCode",
                last_error->>'message' AS "errorMessage"
           FROM ebm_submission_queues
          WHERE company_id = $1 AND shift_id = $2 AND register_id IS NOT NULL
            AND sales_ty_cd IS NOT NULL AND rcpt_ty_cd IS NOT NULL
            AND NOT (ebm_status = 'submitted' AND signed_at IS NOT NULL)
            AND ebm_status IN ('pending', 'submitting', 'failed')
          ORDER BY id FOR UPDATE`,
        companyId, shiftId,
      );
      const fiscalClosePolicy = fiscalSettings.shiftCloseFiscalPolicy || 'REQUIRE_APPROVAL';
      const fiscalApprovalContext = {
        shiftId,
        policy: fiscalClosePolicy,
        submissionIds: unsentFiscalReceipts.map((row) => String(row.id)).sort(),
      };
      let fiscalApprovedById = null;
      if (unsentFiscalReceipts.length && fiscalClosePolicy === 'BLOCK') {
        return { code: 'POS_SHIFT_FISCAL_RECEIPTS_BLOCKED', policy: fiscalClosePolicy, unsentFiscalReceipts };
      }
      if (unsentFiscalReceipts.length && fiscalClosePolicy === 'REQUIRE_APPROVAL') {
        if (!fiscalApprovalToken) {
          return { code: 'POS_SHIFT_FISCAL_APPROVAL_REQUIRED', policy: fiscalClosePolicy, fiscalApprovalContext, unsentFiscalReceipts };
        }
        const approval = await tx.posApproval.findFirst({ where: {
          companyId, registerId, requestedBy: userId, action: 'CLOSE_WITH_UNSENT_RECEIPTS',
          tokenHash: createHash('sha256').update(fiscalApprovalToken, 'utf8').digest('hex'),
          usedAt: null, expiresAt: { gt: new Date() }, context: { equals: fiscalApprovalContext },
        } });
        if (!approval) return { code: 'POS_SHIFT_FISCAL_APPROVAL_INVALID', policy: fiscalClosePolicy, fiscalApprovalContext, unsentFiscalReceipts };
        const now = new Date();
        const consumed = await tx.posApproval.updateMany({
          where: { id: approval.id, companyId, registerId, requestedBy: userId, action: 'CLOSE_WITH_UNSENT_RECEIPTS', usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) return { code: 'POS_SHIFT_FISCAL_APPROVAL_INVALID', policy: fiscalClosePolicy, fiscalApprovalContext, unsentFiscalReceipts };
        fiscalApprovedById = approval.approvedBy;
        await writePosAuditLog({
          companyId, registerId, userId, event: 'APPROVAL_USED',
          metadata: { approvalId: approval.id, action: 'CLOSE_WITH_UNSENT_RECEIPTS', approvedBy: fiscalApprovedById, shiftId, submissionIds: fiscalApprovalContext.submissionIds },
          ip: requestIpAddress(req),
        }, tx);
        await writePosAuditLog({
          companyId, registerId, userId, event: 'SHIFT_FISCAL_CLOSE_APPROVED',
          metadata: { shiftId, policy: fiscalClosePolicy, approvedById: fiscalApprovedById, submissionIds: fiscalApprovalContext.submissionIds },
          ip: requestIpAddress(req),
        }, tx);
      }

      const sales = invoiceTotals(shift.invoices);
      const register = await findRegisterForShift(tx, companyId, registerId);
      if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };
      const till = await findTillSessionForShift(tx, {
        companyId,
        registerCode: register.code,
        shift,
        status: 'open',
      });
      if (!till) {
        const error = new Error('The POS shift has no matching open till session.');
        error.code = 'POS_TILL_SHIFT_LINK_MISSING';
        throw error;
      }
      const cashGiftCardIssues = centsOrWholeAmount(
        (Array.isArray(till.cashActivity) ? till.cashActivity : [])
          .filter((activity) => activity.type === 'gift_card_issue' && !activity.posShiftId)
          .reduce((sum, activity) => sum + centsOrWholeAmount(activity.amount), 0),
      );
      const refundRows = await findCashRefunds(tx, companyId, shiftId);
      const cashRefunds = centsOrWholeAmount(refundRows[0]?.amount);
      const movements = movementTotals(shift.cashMovements);
      const pendingCashRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(payment.amount), 0)::numeric AS amount
           FROM pos_payments payment
           JOIN invoices invoice ON invoice.id = payment.sale_id AND invoice.company_id = payment.company_id
          WHERE payment.company_id = $1
            AND payment.shift_id = $2
            AND payment.method = 'CASH'
            AND payment.status = 'SUCCESS'
            AND invoice.pos_origin = true
            AND invoice.status IN ('PENDING_PAYMENT', 'cancelled')`,
        companyId,
        shiftId,
      );
      const pendingCashReceived = centsOrWholeAmount(pendingCashRows[0]?.amount);
      const heldSalesCount = await findHeldSalesCount(tx, companyId);
      if (settings.heldSalesOnClose === 'BLOCK' && heldSalesCount > 0) {
        return { code: 'POS_SHIFT_HELD_SALES_BLOCKED', heldSalesCount };
      }

      let expectedCash;
      try {
        expectedCash = calculateExpectedCash({
          openingFloat: shift.openingFloat,
          cashSales: sales.cashSales + pendingCashReceived,
          cashGiftCardIssues,
          cashRefunds,
          cashIn: movements.cashIn,
          cashOut: movements.cashOut,
          safeDrops: movements.safeDrops,
        });
      } catch (error) {
        return { code: 'POS_SHIFT_CASH_RECONCILIATION_INVALID', message: error.message };
      }
      if (expectedCash > MAX_DATABASE_INT) {
        return { code: 'POS_SHIFT_CASH_RECONCILIATION_INVALID', message: 'Expected cash exceeds the supported integer amount range.' };
      }

      const variance = counted.countedCash - expectedCash;
      const varianceAmount = Math.abs(variance);
      const requiresApproval = varianceAmount > settings.varianceApprovalLimit;
      const requiresReason = varianceAmount > settings.varianceTolerance || requiresApproval;
      if (requiresReason && (!differenceReason || differenceReason.length < 10)) {
        return {
          code: 'POS_SHIFT_VARIANCE_REASON_REQUIRED',
          expectedCash,
          countedCash: counted.countedCash,
          variance,
          tolerance: settings.varianceTolerance,
        };
      }
      if (requiresApproval && !approvalToken) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'SHIFT_CLOSE_VARIANCE', shiftId, variance, reason: 'POS_APPROVAL_REQUIRED' },
          ip: requestIpAddress(req),
        }, tx);
        return {
          code: 'POS_SHIFT_VARIANCE_APPROVAL_REQUIRED',
          expectedCash,
          countedCash: counted.countedCash,
          variance,
          approvalContext: approvalContext({ shiftId, countedCash: counted.countedCash, expectedCash, variance, differenceReason }),
        };
      }

      let approvedById = null;
      if (requiresApproval) {
        const context = approvalContext({
          shiftId,
          countedCash: counted.countedCash,
          expectedCash,
          variance,
          differenceReason,
        });
        const approval = await tx.posApproval.findFirst({
          where: {
            companyId,
            registerId,
            requestedBy: userId,
            action: 'SHIFT_CLOSE_VARIANCE',
            tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
            usedAt: null,
            expiresAt: { gt: new Date() },
            context: { equals: context },
          },
        });
        if (!approval) {
          await writePosAuditLog({
            companyId,
            registerId,
            userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: 'SHIFT_CLOSE_VARIANCE', shiftId, variance, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIpAddress(req),
          }, tx);
          return { code: 'POS_SHIFT_VARIANCE_APPROVAL_INVALID' };
        }
        const now = new Date();
        const consumed = await tx.posApproval.updateMany({
          where: {
            id: approval.id,
            companyId,
            registerId,
            requestedBy: userId,
            action: 'SHIFT_CLOSE_VARIANCE',
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          await writePosAuditLog({
            companyId,
            registerId,
            userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: 'SHIFT_CLOSE_VARIANCE', shiftId, variance, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIpAddress(req),
          }, tx);
          return { code: 'POS_SHIFT_VARIANCE_APPROVAL_INVALID' };
        }
        approvedById = approval.approvedBy;
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_USED',
          metadata: { approvalId: approval.id, action: 'SHIFT_CLOSE_VARIANCE', approvedBy: approvedById },
          ip: requestIpAddress(req),
        }, tx);
      }

      if (shift.status === 'reopened' && !shift.zReport) {
        return { code: 'POS_Z_REPORT_NOT_FOUND' };
      }
      if (shift.status !== 'reopened'
        && !(await lockRegisterForZNumber(tx, companyId, registerId))) {
        return { code: 'POS_REGISTER_NOT_FOUND' };
      }
      const zNumber = shift.status === 'reopened'
        ? shift.zReport.zNumber
        : (await getPosZReportHighWaterMark(tx, companyId, registerId)) + 1;
      const now = new Date();
      const correctionReportId = shift.status === 'reopened' ? generateObjectId() : null;
      const posting = await postShiftVariance({
        tx,
        companyId,
        userId,
        shift: { ...shift, differenceReason },
        variance,
        reportNumber: zNumber,
        date: now,
        ...(correctionReportId ? { sourceId: correctionReportId } : {}),
      });
      const { journalEntryId, postingStatus } = posting;
      const updatedShift = await tx.posShift.update({
        where: { id: shift.id },
        data: {
          status: 'closed',
          closedById: userId,
          closedAt: now,
          countedCash: counted.countedCash,
          closingCount: counted.count,
          expectedCash,
          difference: variance,
          differenceReason,
          approvedById,
          journalEntryId,
          postingStatus,
          closeIdempotencyKey: key,
          closePayloadHash: payloadHash,
        },
      });
      const closedTill = await closeTillSessionForShift(tx, {
        companyId,
        registerCode: register.code,
        shift,
        closedAt: now,
        expectedCash,
        countedCash: counted.countedCash,
        variance,
        closeNotes: differenceReason,
        zReport: null,
      });
      const unusedOfflineReceiptNumbers = await retireUnusedReceiptNumbersForShift(tx, {
        companyId, tillSessionId: closedTill.id, at: now,
      });
      const snapshot = await buildShiftReportSnapshot({
        queryClient: tx,
        companyId,
        till: closedTill,
        shift,
        reportNumber: zNumber,
        now,
        differenceReason,
        approvedById,
        closedById: userId,
        heldSalesCount,
        heldSalesPolicy: settings.heldSalesOnClose,
        journalEntryId,
        postingStatus,
        fiscalClosePolicy,
        fiscalApprovedById,
      });
      snapshot.unprintedReceipts = {
        count: unprintedReceiptCount,
        warning: unprintedReceiptCount > 0,
      };
      snapshot.offlineReceiptNumbers = {
        unusedAtClose: unusedOfflineReceiptNumbers,
        accounting: 'Unused reservations for this shift were retired and cannot be used by a later shift.',
      };
      await tx.tillSession.update({
        where: { id: closedTill.id },
        data: { zReport: snapshot, zReportGeneratedAt: now },
      });

      let zReport = shift.zReport;
      let correctionReport = null;
      if (shift.status === 'reopened') {
        const latestCorrection = await tx.posShiftCorrectionReport.findFirst({
          where: { shiftId },
          orderBy: { correctionNumber: 'desc' },
          select: { correctionNumber: true },
        });
        correctionReport = await tx.posShiftCorrectionReport.create({
          data: {
            id: correctionReportId,
            companyId,
            registerId,
            shiftId,
            originalZReportId: shift.zReport.id,
            correctionNumber: (latestCorrection?.correctionNumber || 0) + 1,
            correctionType: 'reclosed',
            idempotencyKey: key,
            payloadHash,
            snapshot: {
              version: 1,
              originalZReportId: shift.zReport.id,
              originalZNumber: shift.zReport.zNumber,
              correctionZNumber: zNumber,
              generatedAt: now.toISOString(),
              closedById: userId,
              sales: snapshot.sales,
              cash: snapshot.cash,
              heldSales: snapshot.heldSales,
            },
            journalEntryId,
            createdById: userId,
            createdAt: now,
          },
        });
      } else {
        zReport = await tx.posZReport.create({
          data: {
            id: generateObjectId(),
            companyId,
            registerId,
            shiftId,
            zNumber,
            snapshot,
          },
        });
      }
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: shift.status === 'reopened' ? 'SHIFT_RECLOSED' : 'SHIFT_CLOSED',
        metadata: {
          shiftId,
          shiftNumber: shift.shiftNumber,
          zReportId: zReport.id,
          correctionReportId: correctionReport?.id || null,
          zNumber,
          expectedCash,
          countedCash: counted.countedCash,
          variance,
          approvedById,
          journalEntryId,
          postingStatus,
        },
        ip: requestIpAddress(req),
      }, tx);
      return {
        shift: updatedShift,
        zReport,
        correctionReport,
        replayed: false,
        warning: settings.heldSalesOnClose === 'WARN' && heldSalesCount > 0
          ? { code: 'POS_SHIFT_HELD_SALES_REMAIN', count: heldSalesCount }
          : settings.heldSalesOnClose === 'CARRY_OVER' && heldSalesCount > 0
            ? { code: 'POS_SHIFT_HELD_SALES_CARRIED_OVER', count: heldSalesCount }
          : null,
      };
    });

    if (result.code === 'POS_IDEMPOTENCY_KEY_REUSED') {
      return invalidRequest(res, 409, result.code, 'This Idempotency-Key was already used for a different shift close.');
    }
    if (result.code === 'POS_SHIFT_NOT_OPEN') {
      return invalidRequest(res, 409, result.code, 'The shift is not open on this register.');
    }
    if (result.code === 'POS_REGISTER_NOT_FOUND') {
      return invalidRequest(res, 404, result.code, 'Active POS register not found.');
    }
    if (result.code === 'POS_Z_REPORT_NOT_FOUND') {
      return invalidRequest(res, 409, result.code, 'The original Z report is missing; the shift cannot be re-closed.');
    }
    if (result.code === 'POS_SHIFT_ALREADY_CLOSED') {
      return invalidRequest(res, 409, result.code, 'This shift is already closed. Use the original Idempotency-Key to retrieve its result.');
    }
    if (result.code === 'POS_SHIFT_CASH_RECONCILIATION_INVALID') {
      return invalidRequest(res, 409, result.code, result.message);
    }
    if (result.code === 'POS_SHIFT_VARIANCE_REASON_REQUIRED') {
      return invalidRequest(res, 400, result.code, 'Explain the cash variance with at least 10 characters before closing.', result);
    }
    if (result.code === 'POS_SHIFT_VARIANCE_APPROVAL_REQUIRED') {
      return invalidRequest(res, 403, result.code, 'A manager approval is required for this cash variance.', result);
    }
    if (result.code === 'POS_SHIFT_VARIANCE_APPROVAL_INVALID') {
      return invalidRequest(res, 403, result.code, 'The manager approval is invalid, expired, used, or does not match this reconciliation.');
    }
    if (result.code === 'POS_SHIFT_HELD_SALES_BLOCKED') {
      return invalidRequest(res, 409, result.code, 'Recall, complete, or remove held sales before closing this shift.', {
        heldSalesCount: result.heldSalesCount,
      });
    }
    if (result.code === 'POS_SHIFT_FISCAL_RECEIPTS_BLOCKED') {
      return invalidRequest(res, 409, result.code, 'This shift cannot close while fiscal receipts are unsent. Resolve the VSDC submissions first.', {
        policy: result.policy, unsentFiscalReceipts: result.unsentFiscalReceipts,
      });
    }
    if (result.code === 'POS_SHIFT_FISCAL_APPROVAL_REQUIRED') {
      return invalidRequest(res, 403, result.code, 'A manager must approve closing with unsent fiscal receipts.', {
        policy: result.policy, approvalAction: 'CLOSE_WITH_UNSENT_RECEIPTS',
        approvalContext: result.fiscalApprovalContext, unsentFiscalReceipts: result.unsentFiscalReceipts,
      });
    }
    if (result.code === 'POS_SHIFT_FISCAL_APPROVAL_INVALID') {
      return invalidRequest(res, 403, result.code, 'The fiscal close approval is invalid, expired, used, or the unsent receipts changed.', {
        policy: result.policy, unsentFiscalReceipts: result.unsentFiscalReceipts,
      });
    }
    if (result.code === 'POS_SHIFT_PENDING_PAYMENTS') {
      return invalidRequest(
        res,
        409,
        result.code,
        'Resolve sales with money received or provider payments still waiting before closing this shift.',
        {
          pendingPaymentCount: result.pendingPaymentCount,
          salesWithMoneyReceived: result.salesWithMoneyReceived,
          pendingProviderSales: result.pendingProviderSales,
          unpaidSalesAutoCancelled: result.unpaidSalesAutoCancelled,
        },
      );
    }

    return res.json({
      success: true,
      replayed: result.replayed,
      data: {
        shift: result.shift,
        zReport: result.zReport,
        ...(result.correctionReport ? { correctionReport: result.correctionReport } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      },
    });
  } catch (error) {
    if (error?.code === 'PERIOD_CLOSED') {
      return invalidRequest(
        res,
        409,
        'POS_ACCOUNTING_PERIOD_CLOSED',
        'The accounting period is closed. Ask your manager to reopen it before closing this shift.',
      );
    }
    if (error?.code === 'POS_TILL_SHIFT_LINK_MISSING') {
      return invalidRequest(res, 409, error.code, error.message);
    }
    if (error?.code === 'P2002') {
      try {
        const existing = await prisma.posShift.findFirst({
          where: { companyId, closeIdempotencyKey: key },
          include: { zReport: true },
        });
        if (existing && sameClosedShift(existing, { shiftId, userId, payloadHash })) {
          const correctionReport = await prisma.posShiftCorrectionReport.findFirst({
            where: { companyId, idempotencyKey: key },
          });
          return res.json({
            success: true,
            replayed: true,
            data: {
              shift: existing,
              zReport: existing.zReport,
              ...(correctionReport ? { correctionReport } : {}),
            },
          });
        }
        if (existing) {
          return invalidRequest(res, 409, 'POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different shift close.');
        }
      } catch (recoveryError) {
        return next(recoveryError);
      }
    }
    return next(error);
  }
};

exports.zReport = async (req, res, next) => {
  try {
    const { companyId, registerId } = contextFor(req);
    const report = await prisma.posZReport.findFirst({
      where: {
        shiftId: String(req.params.shiftId || ''),
        companyId,
        registerId,
      },
      include: {
        shift: {
          select: { status: true, closedAt: true },
        },
      },
    });
    if (!report) return invalidRequest(res, 404, 'POS_Z_REPORT_NOT_FOUND', 'No final Z report exists for this shift.');
    return res.json({ success: true, data: report });
  } catch (error) {
    return next(error);
  }
};

exports.normalizeClosingCount = normalizeClosingCount;
exports.invoiceTotals = invoiceTotals;
exports.movementTotals = movementTotals;
exports.findCashRefunds = findCashRefunds;
exports.findHeldSalesCount = findHeldSalesCount;
exports.buildShiftReportSnapshot = buildShiftReportSnapshot;
exports.centsOrWholeAmount = centsOrWholeAmount;

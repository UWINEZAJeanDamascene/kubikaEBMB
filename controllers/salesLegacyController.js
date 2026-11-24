const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const { findClaimedRegister, registerClaimRequiredError } = require('../services/posRegisterService');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockBatch = require('../models/StockBatch');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObjectIdString(value) {
  return /^[0-9a-fA-F]{24}$/.test(String(value || '').trim());
}

const { runInTransaction } = require('../services/transactionService');
const inventoryService = require('../services/inventoryService');
const JournalService = require('../services/journalService');
const CurrencyService = require('../services/CurrencyService');
const cacheService = require('../services/cacheService');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const { buildPosSaleJournalEntries } = require('../services/posSaleJournalBuilder');
const { createHash, randomBytes } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { consumeApproval: consumePosManagerApproval } = require('./posManagerApprovalController');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const { validateAndRecordPharmacyCheckout } = require('../services/posPharmacyCheckoutService');
const {
  reservePharmacyPendingSale,
  lockPharmacyPendingSaleReservation,
  consumeReservedPharmacyBatches,
  markPharmacyPendingSaleReservationConsumed,
} = require('../services/posPharmacyPendingStockReservationService');
const FiscalService = require('../services/fiscalService');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const { verifyCapability: verifyPosOfflineCapability } = require('../services/posOfflineCapabilityService');
const { shouldBlockOfflineFiscalSale } = require('../services/posOfflinePolicyService');
const { reserveOfflineActionUsage } = require('../services/posOfflineActionUsageService');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');
const { getWarehouseTransferVisibility } = require('../services/posTransferVisibilityService');
const { normalizeWholesaleConfig, resolveWholesaleLine } = require('../utils/posWholesalePricing');
const notificationDeliveryService = require('../services/notificationDeliveryService');
const posPaymentService = require('../services/posPaymentService');
const {
  quoteReservation: quotePosVouchers,
  redeemReservation: redeemPosVouchers,
} = require('../services/posVoucherService');
const {
  calculatePosLineAmounts,
  hashPosSalePayload,
  lineValuesMatch,
  pendingCheckoutPayload,
  resolveProductTaxRate,
  roundMoney,
} = require('../services/posCheckoutCoreService');

const {
  consumeTrackedBatches,
  consumeOfflineTrackedBatches,
  findAvailableSerialsOutsideQuarantine,
} = require('../services/posTrackedStockService');

const { replayPosSale } = require('../services/posSaleReplayService');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  evaluateDiscountCaps,
  getApplicableDiscountLimits,
  getTillTypeFeatures,
  normalizeStoredDiscountSettings,
} = require('../services/posDiscountSettingsService');
const { buildDiscountApprovalContext } = require('../services/posDiscountApplicationService');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');

async function recordOfflineFiscalSyncException({
  companyId,
  deviceId,
  operationId,
  userId,
  registerId,
  payload,
  snapshotMode,
  snapshotVersion,
  currentMode,
  currentVersion,
}) {
  const safePayload = { ...payload };
  delete safePayload.offlineSnapshotCapability;
  return dbClient().$transaction(async (tx) => {
    const exception = await tx.posSyncException.upsert({
      where: {
        companyId_deviceId_operationId: {
          companyId: String(companyId),
          deviceId: String(deviceId),
          operationId: String(operationId),
        },
      },
      create: {
        id: randomBytes(12).toString('hex'),
        companyId: String(companyId),
        deviceId: String(deviceId),
        operationId: String(operationId),
        errorCode: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
        message: 'The company fiscal setting changed after this offline sale was authorized. Review the sale before syncing it.',
        operationPayload: safePayload,
        status: 'open',
      },
      update: {},
    });
    await writePosAuditLog({
      companyId,
      registerId: String(registerId || ''),
      userId: String(userId || ''),
      event: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
      metadata: {
        operationId: String(operationId),
        syncExceptionId: exception.id,
        snapshotMode,
        snapshotVersion,
        currentMode,
        currentVersion,
        status: exception.status,
      },
    }, tx);
    return exception;
  });
}
const { normalizeScannerConfiguration } = require('../services/posScannerSettingsService');

async function replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash }) {
  const replay = await replayPosSale({
    companyId,
    requestKey,
    payloadHash,
    cashierId: String(req.posAuthContext?.session?.userId || req.user.id),
    body: req.body,
  });
  if (!replay.handled) return false;
  res.status(replay.status).json(replay.body);
  return true;
}

const sendDirectSaleEmail = async (invoice, companyId, { explicit = false } = {}) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications && !explicit) {
      return;
    }
    const invoiceWithProducts = await Invoice.findById(invoice._id).populate('items.product', 'name');
    await notificationDeliveryService.sendInvoiceDelivery(invoiceWithProducts || invoice, companyId, {
      explicit,
      requireDigitalReceiptConsent: true,
    });
  } catch (err) {
    console.error('[Direct Sale Email] Failed:', err.message);
  }
};

/**
 * @desc    Create a direct sales invoice (canonical POS checkout)
 * @route   POST /api/sales-legacy/direct-sale
 * @access  Private
 *
 * This is the only supported POS sale write path. POST /api/pos/sale is retired.
 *
 * Workflow: Invoice (Direct) Ã¢â€ â€™ Payment
 * No quotation, no sales order, no delivery note
 * Stock decrement happens immediately via WAC/FIFO
 * Journals posted: Dr Receivable / Cr Revenue + Dr COGS / Cr Inventory
 */
exports.createDirectSale = async (req, res, next) => {
  let companyId;
  let requestKey = '';
  let payloadHash = '';
  let offlineContext = null;
  let createdPending = false;
  let completionReplayed = false;
  let proformaDocument = null;
  try {
    companyId = req.user.company._id;
    let purchaseOrderNumber = String(req.body?.purchaseOrderNumber || '').trim();
    if (purchaseOrderNumber.length > 80) {
      return res.status(400).json({ success: false, code: 'POS_PURCHASE_ORDER_NUMBER_INVALID', message: 'Purchase order number must be 80 characters or fewer.' });
    }
    req.body = { ...req.body, purchaseOrderNumber: purchaseOrderNumber || undefined };
    // Mock mode is intentionally manual so development/test checkouts never
    // acquire fabricated fiscal receipts. Sandbox and production POS sales
    // are submitted after the sale transaction commits.
    const ebmEnabled = await moduleEntitlementService.hasModule(companyId, 'fiscal.ebm', { useCache: false });
    const fiscalMode = ebmEnabled
      ? String(await FiscalService.getCurrentEnvironment(companyId) || 'mock').toLowerCase()
      : 'none';
    const autoFiscalSubmission = ebmEnabled && fiscalMode !== 'mock';
    const proformaDocumentId = String(req.body?.proformaDocumentId || '').trim();
    if (proformaDocumentId) {
      proformaDocument = await dbClient().posNonPostingDocument.findFirst({ where: { id: proformaDocumentId, companyId: String(companyId) } });
      if (!proformaDocument || proformaDocument.documentType !== 'PROFORMA') {
        return res.status(404).json({ success: false, code: 'POS_PROFORMA_NOT_FOUND', message: 'Proforma was not found for this company.' });
      }
      if (!['open', 'converted'].includes(proformaDocument.status)) {
        return res.status(409).json({ success: false, code: 'POS_PROFORMA_NOT_OPEN', message: 'This proforma cannot be converted.' });
      }
      const savedDocument = proformaDocument.documentData || {};
      const requestedLines = Array.isArray(req.body?.items) ? req.body.items : [];
      const savedLines = Array.isArray(savedDocument.items) ? savedDocument.items : [];
      const sameLines = requestedLines.length === savedLines.length && savedLines.every((savedLine, index) => {
        const requestedLine = requestedLines[index] || {};
        const sameNumber = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) <= 0.005;
        const requestedSerials = Array.isArray(requestedLine.serialNumbers) ? requestedLine.serialNumbers.map(String) : [];
        const savedSerials = Array.isArray(savedLine.serialNumbers) ? savedLine.serialNumbers.map(String) : [];
        return String(requestedLine.productId || requestedLine._id || '') === String(savedLine.productId)
          && sameNumber(requestedLine.quantity ?? requestedLine.cartQuantity, savedLine.quantity)
          && sameNumber(requestedLine.unitPrice ?? requestedLine.cartUnitPrice, savedLine.unitPrice)
          && sameNumber(requestedLine.discountPct ?? requestedLine.cartDiscountPct, savedLine.discountPct)
          && JSON.stringify(requestedSerials) === JSON.stringify(savedSerials);
      });
      if (!sameLines || String(req.body?.warehouseId || '') !== String(savedDocument.warehouseId || '')) {
        return res.status(409).json({ success: false, code: 'POS_PROFORMA_CART_CHANGED', message: 'The cart or warehouse changed after this proforma was saved. Clear the proforma selection and review the sale.' });
      }
      req.body = {
        ...req.body,
        items: (savedDocument.items || []).map((item) => ({
          productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice,
          discountPct: item.discountPct, discountReason: item.discountReason, serialNumbers: item.serialNumbers || [],
        })),
        cartDiscountPct: Number(savedDocument.cartDiscountPct) || 0,
        cartDiscountReason: savedDocument.cartDiscountReason || '',
        warehouseId: savedDocument.warehouseId,
        clientId: savedDocument.clientId || undefined,
        clientInfo: savedDocument.clientInfo || undefined,
        purchaseOrderNumber: savedDocument.purchaseOrderNumber || undefined,
        buyerTin: savedDocument.buyerTin || undefined,
        salespersonId: savedDocument.salespersonId || undefined,
        salespersonName: savedDocument.salespersonName || undefined,
      };
      purchaseOrderNumber = String(req.body.purchaseOrderNumber || '').trim();
    }
    const buyerTin = String(req.body?.buyerTin || '').trim();
    if (buyerTin && !/^\d{9}$/.test(buyerTin)) {
      return res.status(422).json({ success: false, code: 'POS_BUYER_TIN_INVALID', message: 'Buyer TIN must contain exactly 9 digits.' });
    }
    requestKey = req.posV2Completion
      ? String(req.posV2Completion.offlineOperationId || req.posV2Completion.completionKey || '').trim()
      : String(proformaDocument?.conversionKey || req.get('Idempotency-Key') || '').trim();
    if (requestKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(requestKey)) {
      return res.status(400).json({ success: false, code: 'POS_INVALID_IDEMPOTENCY_KEY', message: 'Checkout idempotency key is invalid.' });
    }
    const hasOfflineOperation = Boolean(
      req.body.offlineSnapshotCapability || req.body.offlineSaleId
      || req.body.offlineCreatedAt || req.body.offlineOperationId,
    );
    payloadHash = hashPosSalePayload(req.body);
    if (requestKey && !hasOfflineOperation && await replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash })) return;
    const salespersonId = String(req.body?.salespersonId || req.posAuthContext?.session?.userId || req.user?.id || req.user?._id || '').trim();
    let salesperson = null;
    if (salespersonId) {
      if (!/^[a-f\d]{24}$/i.test(salespersonId)) return res.status(422).json({ success: false, code: 'POS_SALESPERSON_INVALID', message: 'Choose an active salesperson from this company.' });
      salesperson = await dbClient().user.findFirst({
        where: { id: salespersonId, isActive: true, OR: [{ companyId: String(companyId) }, { companyUsers: { some: { companyId: String(companyId), status: 'active' } } }] },
        select: { id: true, name: true },
      });
      if (!salesperson) return res.status(422).json({ success: false, code: 'POS_SALESPERSON_INVALID', message: 'The selected salesperson is not active in this company.' });
    }
    req.body = { ...req.body, salespersonId: salesperson?.id || undefined, salespersonName: salesperson?.name || undefined };
    // Legacy checkout, pending V2 creation, and online/offline V2 completion
    // all reserve this company-scoped request row inside the sale transaction.
    // The invoice completion key remains as a domain-level recovery check.
    const requestedRegisterId = String(req.body.registerId || '');
    const claimedRegister = await findClaimedRegister(companyId, requestedRegisterId, req.body.deviceId);
    if (!claimedRegister) throw registerClaimRequiredError();
    if (claimedRegister.trainingMode) {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_TRAINING_MODE', message: 'This register is in training mode. No real sale can be recorded until a manager turns training mode off.' });
    }
    if (proformaDocument && String(proformaDocument.registerId) !== String(claimedRegister.id)) {
      return res.status(403).json({ success: false, code: 'POS_PROFORMA_REGISTER_MISMATCH', message: 'Convert this proforma on the register where it was created.' });
    }
    const posCashierId = String(req.posAuthContext?.session?.userId || req.user.id);
    if (req.posAuthContext && (
      String(req.posAuthContext.session.companyId) !== String(companyId)
      || String(req.posAuthContext.session.registerId) !== String(claimedRegister.id)
    )) {
      return res.status(403).json({
        success: false,
        code: 'POS_SESSION_REGISTER_MISMATCH',
        message: 'The active cashier session does not match this register.',
      });
    }
    const paymentSettings = await posPaymentService.getPaymentSettings(String(companyId));
    const configuredPaymentFlow = posPaymentService.resolvePaymentFlow(paymentSettings, String(claimedRegister.id));
    if (!hasOfflineOperation && req.posPaymentFlow === 'PAYMENTS_V2' && configuredPaymentFlow !== 'PAYMENTS_V2') {
      return res.status(409).json({
        success: false,
        code: 'POS_PAYMENT_FLOW_DISABLED',
        message: 'V2 payments are not enabled for this register. Ask a manager to review POS payment settings.',
      });
    }
    if (!hasOfflineOperation && !req.posPaymentFlow && configuredPaymentFlow === 'PAYMENTS_V2') {
      return res.status(409).json({
        success: false,
        code: 'POS_PAYMENT_V2_REQUIRED',
        message: 'This till uses the new payment flow. Please use the payment screen.',
      });
    }
    const isV2Pending = req.posPaymentFlow === 'PAYMENTS_V2' && !req.posV2Completion;
    if (isV2Pending && !requestKey) {
      return res.status(400).json({
        success: false,
        code: 'POS_IDEMPOTENCY_KEY_REQUIRED',
        message: 'Provide an Idempotency-Key before creating a pending POS sale.',
      });
    }
    if (hasOfflineOperation) {
      const claims = verifyPosOfflineCapability(req.body.offlineSnapshotCapability);
      const offlineSaleId = String(req.body.offlineSaleId || '').trim();
      const offlineOperationId = String(req.body.offlineOperationId || offlineSaleId).trim();
      const saleCreatedAt = new Date(req.body.offlineCreatedAt);
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(offlineSaleId)
        || !/^[a-zA-Z0-9_-]{16,100}$/.test(offlineOperationId)
        || !Number.isFinite(saleCreatedAt.getTime())
        || saleCreatedAt.getTime() < claims.issuedAt || saleCreatedAt.getTime() > claims.expiresAt
        || String(claims.companyId) !== String(companyId)
        || String(claims.userId) !== String(req.user.id)
        || String(claims.deviceId) !== String(req.body.deviceId || '')
        || String(claims.registerId) !== String(requestedRegisterId)) {
        return res.status(403).json({ success: false, code: 'POS_OFFLINE_CAPABILITY_BINDING_INVALID', message: 'The signed offline POS capability does not authorize this cashier, device, register, or sale time.' });
      }
      const snapshots = await dbClient().$queryRawUnsafe(
        'SELECT id, warehouse_id AS "warehouseId", till_session_id AS "tillSessionId", snapshot_data AS "snapshotData", fiscal_mode AS "fiscalMode", entitlement_version AS "entitlementVersion", queue_limit AS "queueLimit", expires_at AS "expiresAt" FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 AND user_id = $3 AND device_id = $4 AND register_id = $5 LIMIT 1',
        claims.id, companyId, req.user.id, req.body.deviceId, requestedRegisterId,
      );
      const snapshot = snapshots[0];
      const snapshotData = typeof snapshot?.snapshotData === 'string'
        ? JSON.parse(snapshot.snapshotData)
        : snapshot?.snapshotData;
      const expectedPaymentFlow = claims.paymentFlow || snapshotData?.paymentFlow || 'LEGACY';
      const queuedPaymentFlow = req.body.offlinePaymentFlow || 'LEGACY';
      if (!snapshot || String(snapshot.warehouseId) !== String(req.body.warehouseId || '')
        || String(snapshot.tillSessionId) !== String(claims.tillSessionId || '')
        || !req.posV2Completion && String(snapshot.tillSessionId) !== String(req.body.tillSession?.id || '')
        || new Date(snapshot.expiresAt).getTime() !== claims.expiresAt) {
        return res.status(403).json({ success: false, code: 'POS_OFFLINE_SNAPSHOT_UNAVAILABLE', message: 'The signed offline catalog snapshot is unavailable or does not match this sale.' });
      }
      const [fiscalPolicyRows, currentEntitlement] = await Promise.all([
        dbClient().$queryRawUnsafe(
          `SELECT s.pos_offline_policy AS "offlinePolicy"
             FROM system_settings s
            WHERE s.company_id = $1 LIMIT 1`, String(companyId),
        ),
        moduleEntitlementService.getEntitlement(companyId, 'fiscal.ebm', { useCache: false }),
      ]);
      const fiscalPolicyRow = fiscalPolicyRows[0];
      const storedOfflinePolicy = typeof fiscalPolicyRow?.offlinePolicy === 'string'
        ? JSON.parse(fiscalPolicyRow.offlinePolicy)
        : fiscalPolicyRow?.offlinePolicy;
      const snapshotFiscalMode = snapshot?.fiscalMode || snapshotData?.fiscalMode || null;
      const snapshotEntitlementVersion = snapshot?.entitlementVersion == null
        ? snapshotData?.entitlementVersion
        : Number(snapshot.entitlementVersion);
      const currentFiscalMode = currentEntitlement.status === 'on' ? 'ebm' : 'none';
      const snapshotCapabilityMatches = ['none', 'ebm'].includes(snapshotFiscalMode)
        && Number.isSafeInteger(Number(snapshotEntitlementVersion))
        && Number(snapshotEntitlementVersion) > 0
        && snapshot?.fiscalMode === snapshotFiscalMode
        && Number(snapshot?.entitlementVersion) === Number(snapshotEntitlementVersion)
        && snapshotData?.fiscalMode === snapshotFiscalMode
        && Number(snapshotData?.entitlementVersion) === Number(snapshotEntitlementVersion)
        && claims.fiscalMode === snapshotFiscalMode
        && Number(claims.entitlementVersion) === Number(snapshotEntitlementVersion);
      const fiscalCapabilityChanged = !snapshotCapabilityMatches
        || currentFiscalMode !== snapshotFiscalMode
        || currentEntitlement.version !== Number(snapshotEntitlementVersion);
      if (fiscalCapabilityChanged) {
        const syncException = await recordOfflineFiscalSyncException({
          companyId,
          deviceId: req.body.deviceId,
          operationId: offlineOperationId,
          userId: req.user.id,
          registerId: requestedRegisterId,
          payload: req.body,
          snapshotMode: snapshotFiscalMode,
          snapshotVersion: snapshotEntitlementVersion ?? null,
          currentMode: currentFiscalMode,
          currentVersion: currentEntitlement.version,
        });
        return res.status(409).json({
          success: false,
          code: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
          message: 'This offline sale needs review because the company fiscal setting changed after the snapshot was issued.',
          syncExceptionId: syncException.id,
        });
      }
      if (shouldBlockOfflineFiscalSale({
        ebmEnabled: snapshotFiscalMode === 'ebm',
        snapshotRequiresFiscalSubmission: snapshotFiscalMode === 'ebm',
        capabilityAllowsProvisionalReceipt: claims.provisionalFiscalReceiptsAllowed,
        companyAllowsProvisionalReceipt: storedOfflinePolicy?.provisionalFiscalReceiptsAllowed,
      })) {
        return res.status(409).json({
          success: false,
          code: 'POS_OFFLINE_FISCAL_SALE_BLOCKED',
          message: 'This shop requires an RRA fiscal receipt. Offline fiscal sales are not approved yet. Keep the cart and reconnect before completing the sale.',
        });
      }
      if (!['LEGACY', 'PAYMENTS_V2'].includes(queuedPaymentFlow)
        || queuedPaymentFlow !== expectedPaymentFlow
        || queuedPaymentFlow !== configuredPaymentFlow
        || queuedPaymentFlow !== (req.posPaymentFlow === 'PAYMENTS_V2' ? 'PAYMENTS_V2' : 'LEGACY')) {
        return res.status(409).json({
          success: false,
          code: 'POS_OFFLINE_PAYMENT_FLOW_CHANGED',
          message: 'The POS payment flow changed after this sale was queued. The sale was not rerouted; review or retry it only after restoring its original payment flow.',
        });
      }
      const priorReceiptAllocation = await dbClient().$queryRawUnsafe(
        `SELECT receipt_number AS "receiptNumber"
           FROM pos_receipt_number_allocations
          WHERE company_id = $1 AND device_id = $2 AND register_id = $3
            AND operation_id = $4
          LIMIT 1`,
        String(companyId),
        String(req.body.deviceId),
        String(claimedRegister.id),
        offlineOperationId,
      );
      let receiptNumber = String(
        priorReceiptAllocation[0]?.receiptNumber || req.body.offlineReceiptNumber || '',
      );
      const hasSignedReceiptList = Array.isArray(claims.receiptNumbers);
      const signedReceiptNumbers = hasSignedReceiptList
        ? claims.receiptNumbers.filter((number) => typeof number === 'string')
        : [];
      const validReceiptNumber = /^[A-Z]{2,8}-\d{4}-\d{5,}$/.test(receiptNumber);
      if (!validReceiptNumber || !priorReceiptAllocation.length
        && hasSignedReceiptList && !signedReceiptNumbers.includes(receiptNumber)) {
        const availableReceipts = hasSignedReceiptList
          ? signedReceiptNumbers.filter((number) => (
          /^[A-Z]{2,8}-\d{4}-\d{5,}$/.test(number)
          ))
          : null;
        const allocations = !hasSignedReceiptList || availableReceipts.length
          ? await dbClient().$queryRawUnsafe(
            `SELECT receipt_number AS "receiptNumber"
               FROM pos_receipt_number_allocations
              WHERE company_id = $1 AND device_id = $2 AND register_id = $3
                AND operation_id IS NULL AND used_at IS NULL AND retired_at IS NULL
                AND expires_at > $4::timestamptz
                AND ($5::text[] IS NULL OR receipt_number = ANY($5::text[]))
              ORDER BY created_at ASC, block_index ASC
              LIMIT 1`,
            String(companyId),
            String(req.body.deviceId),
            String(claimedRegister.id),
            saleCreatedAt,
            availableReceipts,
          )
          : [];
        receiptNumber = String(allocations[0]?.receiptNumber || '');
      }
      if (!/^[A-Z]{2,8}-\d{4}-\d{5,}$/.test(receiptNumber)) {
        return res.status(403).json({
          success: false,
          code: 'POS_OFFLINE_RECEIPT_NUMBER_INVALID',
          message: 'No unused valid receipt number is available in this sale’s signed offline block. Refresh the POS receipt block before retrying.',
        });
      }
      offlineContext = {
        claims,
        snapshotId: String(snapshot.id),
        snapshotData,
        fiscalMode: snapshotFiscalMode,
        entitlementVersion: Number(snapshotEntitlementVersion),
        queueLimit: Number(snapshot.queueLimit),
        offlineSaleId,
        operationId: offlineOperationId,
        receiptNumber,
        paymentFlow: queuedPaymentFlow,
        saleCreatedAt,
      };
      if (requestKey && await replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash })) return;
    }

    const invoiceCurrency = await CurrencyService.getCompanyBase(companyId);
    const {
      clientId,
      clientInfo, // For walk-in customers: { name, contact, address }
      items,
      warehouseId,
      paymentMethod,
      paymentProvider,
      paymentAmount,
      paymentReference,
      payments: requestedPayments,
      notes,
      dueDate,
      terms,
      bankAccountId,
      tillSession,
      promotionId,
      cartDiscountPct: rawCartDiscountPct,
      cartDiscountReason,
      discountApprovalScope,
      voucherReservationTokens,
    } = req.body;
    if (isV2Pending && (Array.isArray(requestedPayments) && requestedPayments.length
      || Number(paymentAmount) > 0)) {
      return res.status(400).json({
        success: false,
        code: 'POS_PAYMENT_V2_SEPARATE_PAYMENT_REQUIRED',
        message: 'Create the pending sale first, then record cash through the POS Payments V2 payment screen.',
      });
    }
    const offlineV2NonCashPayment = req.posV2Completion
      && Array.isArray(req.body.payments)
      && req.body.payments.some((payment) => String(payment?.paymentMethod || '').toLowerCase() !== 'cash');
    const hasUnsupportedOfflineTender = req.posV2Completion
      ? offlineV2NonCashPayment
      : Array.isArray(req.body.payments) && req.body.payments.length > 0 || req.body.splitTender === true;
    const v2OfflinePaymentMethods = req.posV2Completion && Array.isArray(req.body.payments)
      ? req.body.payments.map((payment) => String(payment?.paymentMethod || '').toLowerCase())
      : [];
    const offlinePaymentIsCash = req.posV2Completion
      ? v2OfflinePaymentMethods.length === 1 && v2OfflinePaymentMethods[0] === 'cash'
      : paymentMethod === 'cash' && !hasUnsupportedOfflineTender;
    if (offlineContext && (!offlinePaymentIsCash || hasUnsupportedOfflineTender)) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_CASH_ONLY', message: 'Offline POS accepts only a single cash payment.' });
    }

    // Validation
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No items provided for sale'
      });
    }
    if (items.some((item) => !item || !isObjectIdString(item.productId))) {
      return res.status(400).json({
        success: false,
        code: 'ERR_INVALID_SALE_LINE',
        message: 'Every sale line must include a valid product ID',
      });
    }

    const activeTill = await TillSession.findOne({
      company: companyId,
      registerId: claimedRegister.code,
      status: 'open',
    });
    if (!activeTill) {
      return res.status(400).json({
        success: false,
        code: 'POS_SHIFT_REQUIRED',
        message: 'Open this register shift before recording a POS sale.',
      });
    }
    if (tillSession?.id && String(tillSession.id) !== String(activeTill._id)) {
      return res.status(409).json({ success: false, code: 'POS_TILL_SESSION_CHANGED', message: 'The register shift changed. Refresh the POS and verify the active cashier session.' });
    }

    if (!warehouseId) {
      return res.status(400).json({
        success: false,
        message: 'Warehouse is required'
      });
    }

    // Verify warehouse exists
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Resolve or create client
    let client = null;
    if (clientId) {
      client = await Client.findOne({ _id: clientId, company: companyId });
    }

    // Defer creating a walk-in customer until the sale transaction begins so
    // a failed accounting post cannot leave an orphan customer record.
    const walkInCustomer = {
      name: clientInfo?.name || 'Walk-in Customer',
      code: 'WALKIN-' + Date.now().toString().slice(-6),
      contact: clientInfo?.contact || {},
      address: clientInfo?.address || {},
    };

     // Batch-load all products in a single query with select projection
    const productIds = [...new Set(items.map((it) => String(it.productId)))];
    const productsMap = new Map();
    try {
      const productsBatch = await Product.find({
        _id: { $in: productIds },
        company: companyId,
      })
        .select('name sku sellingPrice unit taxRate taxCode currentStock isActive isStockable isNoDiscount category averageCost trackingType trackSerialNumbers trackBatch customFields')
        .lean();
      productsBatch.forEach((p) => productsMap.set(p._id.toString(), p));
    } catch (batchErr) {
      console.warn('[createDirectSale] Batch product load failed:', batchErr.message);
    }
    const wholesaleBaseQuantityByProduct = new Map();
    for (const item of items) {
      const product = productsMap.get(String(item.productId));
      if (!product) continue;
      const code = String(item.salesUnitCode || '').trim().toLowerCase();
      const configuredUnit = code ? normalizeWholesaleConfig(product).units.find((unit) => unit.code === code) : null;
      if (code && !configuredUnit) {
        return res.status(409).json({ success: false, code: 'POS_WHOLESALE_UNIT_CHANGED', message: `${product.name} selling unit is no longer configured. Refresh the till and retry.` });
      }
      const multiplier = configuredUnit?.baseQuantity || 1;
      wholesaleBaseQuantityByProduct.set(String(product._id), (wholesaleBaseQuantityByProduct.get(String(product._id)) || 0) + Number(item.quantity || 0) * multiplier);
    }
    const categoryIds = [...new Set([...productsMap.values()]
      .map((product) => String(product.category?._id || product.category || ''))
      .filter(isObjectIdString))];
    const categoryRestrictions = categoryIds.length
      ? await dbClient().category.findMany({
        where: { companyId: String(companyId), id: { in: categoryIds } },
        select: { id: true, isNoDiscount: true },
      })
      : [];
    const noDiscountCategoryIds = new Set(
      categoryRestrictions.filter((category) => category.isNoDiscount).map((category) => String(category.id)),
    );
    const isDiscountRestricted = (product) => Boolean(product.isNoDiscount)
      || noDiscountCategoryIds.has(String(product.category?._id || product.category || ''));
    const [discountSettingsRow, roleAssignments] = await Promise.all([
      dbClient().systemSettings.findUnique({
        where: { companyId: String(companyId) },
        select: { posDiscountSettings: true, posScannerSettings: true },
      }),
      posCashierId
        ? dbClient().userRole.findMany({
          where: { userId: posCashierId, role: { is: { OR: [{ companyId: String(companyId) }, { companyId: null }] } } },
          select: { roleId: true },
        })
        : [],
    ]);
    const discountSettings = normalizeStoredDiscountSettings(
      discountSettingsRow?.posDiscountSettings || DEFAULT_DISCOUNT_SETTINGS,
    );
    const configuredOpenPriceProductId = normalizeScannerConfiguration(
      discountSettingsRow?.posScannerSettings,
    ).openPriceProductId;
    const openPriceItems = items.filter((item) => item?.openPrice === true
      || (configuredOpenPriceProductId && String(item?.productId) === configuredOpenPriceProductId));
    if (openPriceItems.length) {
      if (offlineContext) {
        return res.status(403).json({
          success: false,
          code: 'POS_OPEN_PRICE_OFFLINE_UNSUPPORTED',
          message: 'Open-price items require an online checkout.',
        });
      }
      if (!configuredOpenPriceProductId || openPriceItems.some((item) => (
        item.openPrice !== true || String(item.productId) !== configuredOpenPriceProductId
      ))) {
        return res.status(403).json({
          success: false,
          code: 'POS_OPEN_PRICE_PRODUCT_INVALID',
          message: 'Open-price items must use the company-configured POS product.',
        });
      }
      const configuredProduct = productsMap.get(configuredOpenPriceProductId);
      if (!configuredProduct || configuredProduct.isActive === false || configuredProduct.isStockable !== false) {
        return res.status(409).json({
          success: false,
          code: 'POS_OPEN_PRICE_PRODUCT_UNAVAILABLE',
          message: 'The configured POS open-price product is no longer an active non-stock product.',
        });
      }
      const allowed = await hasPosPermission(
        req.posAuthContext?.user,
        String(companyId),
        req.posAuthContext?.settings?.posRolePermissions,
        'pos.till.open_price',
      );
      if (!allowed) {
        return res.status(403).json({
          success: false,
          code: 'POS_PERMISSION_DENIED',
          message: 'Your POS role does not allow open-price items.',
          requiredPermission: 'pos.till.open_price',
        });
      }
    }
    const hasOpenPriceItems = openPriceItems.length > 0;
    const tillFeatures = getTillTypeFeatures(discountSettings, claimedRegister.systemTillType);
    if (!tillFeatures.manualDiscounts && Number(rawCartDiscountPct) > 0) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Manual discounts are disabled for this till type.',
      });
    }
    if (!tillFeatures.promotions && promotionId) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Promotions are disabled for this till type.',
      });
    }
    if (!tillFeatures.vouchers && (Array.isArray(voucherReservationTokens) && voucherReservationTokens.length
      || req.posV2Completion?.voucherReservations)) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Promotional vouchers are disabled for this till type.',
      });
    }
    const applicableDiscountLimits = getApplicableDiscountLimits(
      discountSettings,
      roleAssignments.map((assignment) => assignment.roleId),
      claimedRegister.discountLabel || null,
    );
    const priceListPricing = await getWarehousePriceListPrices(
      companyId,
      warehouseId,
      productIds,
      offlineContext ? offlineContext.saleCreatedAt : new Date(),
      offlineContext?.snapshotData.priceListId || null,
      Boolean(offlineContext),
    );
    let allowNegativeStock = Boolean(offlineContext?.snapshotData.negativeStockAllowed);
    if (!offlineContext) {
      const stockPolicy = await dbClient().$queryRawUnsafe(
        'SELECT allow_negative_stock AS "allowNegativeStock" FROM system_settings WHERE company_id = $1 LIMIT 1',
        String(companyId),
      );
      allowNegativeStock = stockPolicy[0]?.allowNegativeStock === true;
    }

    let promotion = null;
    const promotionDiscountPctByIndex = new Map();
    let promotionDiscountAmount = 0;
    let promotionDiscountPercent = 0;
    if (promotionId) {
      if (offlineContext) {
        promotion = (offlineContext.snapshotData.promotions || []).find((entry) => String(entry.id) === String(promotionId)) || null;
        if (promotion && (offlineContext.saleCreatedAt < new Date(promotion.startsAt)
          || offlineContext.saleCreatedAt >= new Date(promotion.endsAt))) promotion = null;
      } else {
        const now = new Date();
        const promotionRows = await dbClient().$queryRawUnsafe(
          'SELECT id, name, code, discount_type AS "discountType", value FROM pos_promotions WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND starts_at <= $3 AND ends_at > $3',
          String(promotionId), String(companyId), now,
        );
        promotion = promotionRows[0] || null;
      }
      if (!promotion) return res.status(409).json({ success: false, code: 'POS_PROMOTION_UNAVAILABLE', message: 'This promotion is no longer active. Refresh the POS promotions and retry.' });
      const promotionValue = Number(promotion.value);
      if (!Number.isFinite(promotionValue) || promotionValue <= 0 || promotionValue > Number.MAX_SAFE_INTEGER
        || !['percent', 'fixed'].includes(promotion.discountType)
        || (promotion.discountType === 'percent' && promotionValue > 100)) {
        return res.status(409).json({ success: false, code: 'POS_PROMOTION_INVALID', message: 'This promotion has an invalid discount value.' });
      }
      const bases = items.map((item) => {
        const product = productsMap.get(String(item.productId));
        const snapshotProduct = offlineContext?.snapshotData.products?.[String(item.productId)];
        const quantity = Number(item.quantity);
        const basePrice = offlineContext
          ? Number(snapshotProduct?.price)
          : product ? effectivePrice(String(product._id), product.sellingPrice, priceListPricing.priceByProduct) : NaN;
        const wholesaleLine = offlineContext || !product
          ? { salesUnitPrice: basePrice }
          : resolveWholesaleLine({ product, quantity, salesUnitCode: item.salesUnitCode, basePrice, totalBaseQuantity: wholesaleBaseQuantityByProduct.get(String(product._id)) || quantity });
        const expectedPrice = Number(wholesaleLine.salesUnitPrice);
        const requestedPrice = item.unitPrice == null ? expectedPrice : Number(item.unitPrice);
        if (!product || wholesaleLine.error || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(basePrice)
          || Math.abs(requestedPrice - expectedPrice) > 0.000001 || Number(item.discountPct || 0) !== 0) return null;
        if (isDiscountRestricted(product)) return 0;
        return quantity * expectedPrice;
      });
      if (bases.some((amount) => amount == null)) {
        return res.status(400).json({ success: false, code: 'POS_PROMOTION_MANUAL_DISCOUNT_CONFLICT', message: 'Promotions cannot be combined with manual discounts or overridden prices. Remove the manual adjustment and apply one promotion.' });
      }
      const baseTotal = bases.reduce((sum, amount) => sum + amount, 0);
      if (baseTotal <= 0) return res.status(400).json({ success: false, code: 'POS_PROMOTION_EMPTY_CART', message: 'A promotion requires a positive-value cart.' });
      promotionDiscountAmount = promotion.discountType === 'percent'
        ? Math.round((baseTotal * promotionValue / 100 + Number.EPSILON) * 100) / 100
        : Math.min(baseTotal, Math.round((promotionValue + Number.EPSILON) * 100) / 100);
      promotionDiscountPercent = promotionDiscountAmount / baseTotal * 100;
      let allocated = 0;
      const eligibleIndexes = bases.map((base, index) => base > 0 ? index : -1).filter((index) => index >= 0);
      eligibleIndexes.forEach((index, eligibleIndex) => {
        const base = bases[index];
        const lineDiscount = eligibleIndex === eligibleIndexes.length - 1
          ? Math.max(0, promotionDiscountAmount - allocated)
          : Math.round((promotionDiscountAmount * base / baseTotal + Number.EPSILON) * 100) / 100;
        allocated += lineDiscount;
        promotionDiscountPctByIndex.set(index, base > 0 ? lineDiscount / base * 100 : 0);
      });
    }
    const cartDiscountPct = rawCartDiscountPct == null || rawCartDiscountPct === ''
      ? 0
      : Number(rawCartDiscountPct);
    if (!Number.isFinite(cartDiscountPct) || cartDiscountPct < 0 || cartDiscountPct > 100) {
      return res.status(400).json({
        success: false,
        code: 'POS_DISCOUNT_VALUE_INVALID',
        message: 'Cart discount must be between 0 and 100 percent.',
      });
    }
    if (hasOpenPriceItems && (
      cartDiscountPct > 0
      || promotionId
      || (Array.isArray(voucherReservationTokens) && voucherReservationTokens.length > 0)
      || req.posV2Completion?.voucherReservations
    )) {
      return res.status(400).json({
        success: false,
        code: 'POS_OPEN_PRICE_DISCOUNT_UNSUPPORTED',
        message: 'Remove open-price items before applying cart discounts, promotions, or vouchers.',
      });
    }
    if (offlineContext && cartDiscountPct > 0) {
      return res.status(403).json({
        success: false,
        code: 'POS_OFFLINE_DISCOUNT_UNSUPPORTED',
        message: 'Cart discounts require online server validation and cannot be applied to an offline sale.',
      });
    }
    if (cartDiscountPct > 0) {
      if (promotion) {
        return res.status(400).json({
          success: false,
          code: 'POS_DISCOUNT_SCOPES_CANNOT_COMBINE',
          message: 'Apply either a promotion or a cart discount, not both.',
        });
      }
      if (items.some((item) => Number(item.discountPct || 0) > 0)) {
        return res.status(400).json({
          success: false,
          code: 'POS_DISCOUNT_SCOPES_CANNOT_COMBINE',
          message: 'Apply either line discounts or a cart discount, not both.',
        });
      }
      const reason = typeof cartDiscountReason === 'string' ? cartDiscountReason.trim() : '';
      if (!discountSettings.discountReasons.some((value) => value.toLocaleLowerCase() === reason.toLocaleLowerCase())) {
        return res.status(400).json({
          success: false,
          code: 'POS_DISCOUNT_REASON_REQUIRED',
          message: 'Select a valid configured reason for the cart discount.',
        });
      }
    }

    // Validate all items and build invoice lines
    const invoiceLines = [];
    const stockUpdates = [];
    const missingProducts = [];
    const offlineConflicts = [];
    const offlineBatchUsageByProduct = new Map();
    const stockRequiredByProduct = new Map();
    let offlineTaxPayloadMismatch = false;
    const selectedWarehouseLevels = await StockLevel.find({
      company_id: companyId,
      warehouse_id: warehouseId,
      product_id: { $in: productIds },
    }).lean();
    const stockLevelByProduct = new Map(
      selectedWarehouseLevels.map((level) => [String(level.product_id), level]),
    );
    const quarantineWhere = {
      companyId: String(companyId),
      warehouseId: String(warehouseId),
      productId: { in: productIds.map(String) },
      isQuarantined: true,
      qtyOnHand: { gt: 0 },
    };
    const quarantinedRows = productIds.length
      ? await dbClient().stockBatch.groupBy({
        by: ['productId'],
        where: quarantineWhere,
        _sum: { qtyOnHand: true },
      })
      : [];
    const quarantinedByProduct = new Map(quarantinedRows.map((row) => [String(row.productId), Number(row._sum?.qtyOnHand || 0)]));
    let requiresManagerApproval = false;

    if (req.posRestaurantCheckout
      && (!Array.isArray(req.posRestaurantCheckout.lines)
        || req.posRestaurantCheckout.lines.length !== items.length)) {
      return res.status(409).json({
        success: false,
        code: 'RESTAURANT_CHECKOUT_SNAPSHOT_INVALID',
        message: 'The saved Restaurant order no longer matches this checkout. Review the bill before retrying.',
      });
    }

    for (const [itemIndex, item] of items.entries()) {
      const product = productsMap.get(String(item.productId));
      if (!product) {
        missingProducts.push(item.productId);
        continue;
      }

      const restaurantLine = req.posRestaurantCheckout?.lines?.[itemIndex];
      const isSavedRestaurantPromotion = Boolean(restaurantLine?.promotionSnapshot);
      if (req.posRestaurantCheckout && (
        !restaurantLine
        || String(item.productId) !== String(restaurantLine.productId)
        || Number(item.quantity) !== Number(restaurantLine.quantity)
        || Number(item.unitPrice) !== Number(restaurantLine.unitPrice)
        || String(item.taxCode || '') !== String(restaurantLine.taxCode || '')
        || Number(item.taxRate) !== Number(restaurantLine.taxRate)
        || String(item.description || '') !== String(restaurantLine.description || '')
        || Number(item.discountPct || 0) !== Number(restaurantLine.discountPct || 0)
      )) {
        return res.status(409).json({
          success: false,
          code: 'RESTAURANT_CHECKOUT_SNAPSHOT_INVALID',
          message: 'The saved Restaurant order no longer matches this checkout. Review the bill before retrying.',
        });
      }

      const snapshotProduct = offlineContext?.snapshotData.products?.[String(item.productId)];
      if (offlineContext && !snapshotProduct) {
        return res.status(403).json({ success: false, code: 'POS_OFFLINE_PRODUCT_NOT_IN_SNAPSHOT', message: 'A sale item was not included in the signed offline catalog snapshot.' });
      }
      const saleQuantity = Number(item.quantity);
      const productPrice = effectivePrice(String(product._id), product.sellingPrice, priceListPricing.priceByProduct);
      const wholesaleLine = offlineContext || restaurantLine
        ? { multiplier: 1, baseQuantity: saleQuantity, unitPrice: productPrice, salesUnitPrice: productPrice, unitLabel: product.unit }
        : resolveWholesaleLine({
          product, quantity: saleQuantity, salesUnitCode: item.salesUnitCode, basePrice: productPrice,
          totalBaseQuantity: wholesaleBaseQuantityByProduct.get(String(product._id)) || saleQuantity,
        });
      if (wholesaleLine.error || (offlineContext && item.salesUnitCode)) {
        return res.status(offlineContext ? 403 : 409).json({
          success: false,
          code: offlineContext ? 'POS_OFFLINE_WHOLESALE_UNSUPPORTED' : 'POS_WHOLESALE_UNIT_CHANGED',
          message: offlineContext ? 'Wholesale packs and quantity-break pricing require the till to be online.' : wholesaleLine.error,
        });
      }
      const quantity = Number(wholesaleLine.baseQuantity);
      const expectedSalesPrice = offlineContext ? productPrice : Number(wholesaleLine.salesUnitPrice);
      if (offlineContext && Math.abs(Number(snapshotProduct.price) - productPrice) > 0.000001) {
        return res.status(403).json({ success: false, code: 'POS_OFFLINE_PRICE_SNAPSHOT_MISMATCH', message: `${snapshotProduct.name} price no longer matches the signed offline catalog.` });
      }
      const requestedUnitPrice = restaurantLine
        ? Number(restaurantLine.unitPrice)
        : item.unitPrice == null ? expectedSalesPrice : Number(item.unitPrice);
      const requestedDiscountPct = item.discountPct == null ? 0 : Number(item.discountPct);
      const isOpenPriceItem = item.openPrice === true;
      const isRestrictedProduct = !isOpenPriceItem && isDiscountRestricted(product);
      if (isOpenPriceItem) {
        const description = String(item.description || '').normalize('NFKC').trim();
        if (description.length < 1 || description.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(description)
          || !Number.isFinite(requestedUnitPrice) || requestedUnitPrice <= 0
          || requestedUnitPrice > Number.MAX_SAFE_INTEGER
          || requestedDiscountPct !== 0) {
          return res.status(400).json({
            success: false,
            code: 'POS_OPEN_PRICE_LINE_INVALID',
            message: 'Open-price lines require a description, a positive valid price, and no line discount.',
          });
        }
      }
      const appliedCartDiscountPct = restaurantLine || isRestrictedProduct ? 0 : cartDiscountPct;
      const discountPct = restaurantLine
        ? Number(restaurantLine.discountPct || 0)
        : promotion
        ? Number(promotionDiscountPctByIndex.get(itemIndex) || 0)
        : appliedCartDiscountPct > 0 ? appliedCartDiscountPct : requestedDiscountPct;
      const discountReason = appliedCartDiscountPct > 0
        ? String(cartDiscountReason || '').trim()
        : restaurantLine ? '' : typeof item.discountReason === 'string' ? item.discountReason.trim() : '';
      if (offlineContext && (
        item.catalogUnitPrice == null
        || Math.abs(Number(item.catalogUnitPrice) - expectedSalesPrice) > 0.000001
        || Math.abs(requestedUnitPrice - expectedSalesPrice) > 0.000001
        || Number(item.discountPct || 0) !== 0
      )) {
        return res.status(403).json({ success: false, code: 'POS_OFFLINE_PRICE_SNAPSHOT_MISMATCH', message: `${snapshotProduct.name} price or discount does not match the signed offline catalog.` });
      }
      if (!offlineContext && item.catalogUnitPrice != null && Math.abs(Number(item.catalogUnitPrice) - expectedSalesPrice) > 0.000001) {
        return res.status(409).json({
          success: false,
          code: 'POS_PRICE_CHANGED',
          message: `${product.name} catalog price changed. Refresh the cart before completing this sale.`,
        });
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER
        || !Number.isFinite(productPrice) || productPrice < 0 || productPrice > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Quantity or catalog price is invalid for ${product.name}`,
        });
      }
      if (!Number.isFinite(requestedUnitPrice) || requestedUnitPrice < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Price or discount is invalid for ${product.name}`,
        });
      }
      if (!restaurantLine && isRestrictedProduct
        && (requestedDiscountPct > 0 || requestedUnitPrice < expectedSalesPrice - 0.000001 || discountPct > 0)) {
        return res.status(403).json({
          success: false,
          code: 'POS_ITEM_DISCOUNT_NOT_ALLOWED',
          message: `${product.name} or its category is marked as no-discount.`,
        });
      }
      if (!restaurantLine && !appliedCartDiscountPct && requestedDiscountPct > 0 && !discountSettings.discountReasons.some(
        (reason) => reason.toLocaleLowerCase() === discountReason.toLocaleLowerCase(),
      )) {
        return res.status(400).json({
          success: false,
          code: 'POS_DISCOUNT_REASON_REQUIRED',
          message: 'Select a valid configured reason for every manual discount.',
        });
      }

      const unitPrice = requestedUnitPrice;
      const hasPriceOverride = !restaurantLine && Math.abs(requestedUnitPrice - expectedSalesPrice) > 0.000001;
      if (!tillFeatures.manualDiscounts && !isSavedRestaurantPromotion
        && (requestedDiscountPct > 0 || (hasPriceOverride && !isOpenPriceItem))) {
        return res.status(403).json({
          success: false,
          code: 'POS_TILL_FEATURE_DISABLED',
          message: 'Manual discounts and price overrides are disabled for this till type.',
        });
      }
      if (hasPriceOverride && !isOpenPriceItem) requiresManagerApproval = true;
      
      const isStockable = offlineContext ? snapshotProduct.isStockable !== false : product.isStockable !== false;
      const serialNumbers = Array.isArray(item.serialNumbers)
        ? item.serialNumbers.map((serial) => String(serial).trim().toUpperCase()).filter(Boolean)
        : [];
      const productTrackingType = offlineContext
        ? snapshotProduct.trackingType
        : product.trackingType === 'serial' || product.trackSerialNumbers
        ? 'serial'
        : product.trackingType === 'batch' || product.trackBatch
          ? 'batch'
          : (product.trackingType || 'none');
      let batchAllocations = [];
      let batchSnapshot = Array.isArray(snapshotProduct?.batches) ? snapshotProduct.batches : null;
      let reconstructedLegacyBatchAllocation = false;
      if (offlineContext && productTrackingType === 'batch') {
        if (!batchSnapshot) {
          const currentBatches = await dbClient().stockBatch.findMany({
            where: {
              companyId: String(companyId),
              productId: String(product._id),
              warehouseId: String(warehouseId),
              isQuarantined: false,
              recallStatus: 'active',
              qtyOnHand: { gt: 0 },
            },
            select: {
              id: true,
              batchNo: true,
              qtyOnHand: true,
              reservedQuantity: true,
              unitCost: true,
              expiryDate: true,
              recallStatus: true,
              createdAt: true,
            },
            orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
            take: 500,
          });
          batchSnapshot = currentBatches
            .map((batch) => ({
              id: String(batch.id),
              batchNo: String(batch.batchNo || ''),
              availableQuantity: Math.max(0, Number(batch.qtyOnHand || 0) - Number(batch.reservedQuantity || 0)),
              expiryDate: batch.expiryDate ? new Date(batch.expiryDate).toISOString() : null,
              recallStatus: String(batch.recallStatus || 'active'),
              unitCost: Number(batch.unitCost) || 0,
              createdAt: batch.createdAt ? new Date(batch.createdAt).getTime() : 0,
            }))
            .filter((batch) => batch.availableQuantity > 0
              && (!batch.expiryDate
                || (new Date(batch.expiryDate).getTime() >= offlineContext.saleCreatedAt.getTime()
                  && new Date(batch.expiryDate).getTime() >= Date.now())))
            .sort((left, right) => (
              (left.expiryDate ? new Date(left.expiryDate).getTime() : Number.MAX_SAFE_INTEGER)
                - (right.expiryDate ? new Date(right.expiryDate).getTime() : Number.MAX_SAFE_INTEGER)
              || left.createdAt - right.createdAt
              || left.id.localeCompare(right.id)
            ));
          reconstructedLegacyBatchAllocation = true;
        }
        const snapshotBatchesById = new Map(batchSnapshot.map((batch) => [String(batch.id), batch]));
        let requestedAllocations = Array.isArray(item.batchAllocations) ? item.batchAllocations : [];
        if (!requestedAllocations.length) {
          let remaining = quantity;
          requestedAllocations = [];
          const usedByCart = offlineBatchUsageByProduct.get(String(product._id)) || new Map();
          for (const batch of batchSnapshot) {
            const availableQuantity = Math.max(
              0,
              (Number(batch.availableQuantity) || 0) - (Number(usedByCart.get(String(batch.id))) || 0),
            );
            const amount = Math.min(availableQuantity, remaining);
            if (amount <= 0) continue;
            requestedAllocations.push({ batchId: String(batch.id), quantity: amount });
            remaining -= amount;
            if (remaining <= 0.0000001) break;
          }
          if (remaining > 0.0000001) {
            return res.status(409).json({
              success: false,
              code: 'POS_OFFLINE_BATCH_ALLOCATION_UNAVAILABLE',
              message: `Eligible batch stock is no longer available to sync ${product.name}. Manager review is required.`,
            });
          }
        }
        const seenBatchIds = new Set();
        let allocatedQuantity = 0;
        for (const allocation of requestedAllocations) {
          const batchId = String(allocation?.batchId || '').trim();
          const allocationQuantity = Number(allocation?.quantity);
          const snapshotBatch = snapshotBatchesById.get(batchId);
          if (!isObjectIdString(batchId) || !snapshotBatch || seenBatchIds.has(batchId)
            || !Number.isFinite(allocationQuantity) || allocationQuantity <= 0) {
            return res.status(403).json({
              success: false,
              code: 'POS_OFFLINE_BATCH_ALLOCATION_INVALID',
              message: `A batch allocation for ${product.name} is missing, duplicated, or was not in the signed offline snapshot.`,
            });
          }
          const expiryTime = snapshotBatch.expiryDate ? new Date(snapshotBatch.expiryDate).getTime() : null;
          if (expiryTime != null && expiryTime < offlineContext.saleCreatedAt.getTime()) {
            return res.status(403).json({
              success: false,
              code: 'POS_OFFLINE_BATCH_EXPIRED',
              message: `A batch allocated to ${product.name} had expired before the offline sale was recorded.`,
            });
          }
          const usedByCart = offlineBatchUsageByProduct.get(String(product._id)) || new Map();
          const allocatedForBatch = (usedByCart.get(batchId) || 0) + allocationQuantity;
          if (allocatedForBatch > Number(snapshotBatch.availableQuantity) + 0.00005) {
            return res.status(403).json({
              success: false,
              code: 'POS_OFFLINE_BATCH_SNAPSHOT_STOCK_EXCEEDED',
              message: `The allocated batch quantity for ${product.name} exceeds the signed offline snapshot.`,
            });
          }
          seenBatchIds.add(batchId);
          allocatedQuantity += allocationQuantity;
          usedByCart.set(batchId, allocatedForBatch);
          offlineBatchUsageByProduct.set(String(product._id), usedByCart);
          batchAllocations.push({ batchId, quantity: allocationQuantity });
        }
        if (Math.abs(allocatedQuantity - quantity) > 0.00005) {
          return res.status(403).json({
            success: false,
            code: 'POS_OFFLINE_BATCH_ALLOCATION_INVALID',
            message: `Select signed batch allocations totaling ${quantity} for ${product.name}.`,
          });
        }
      }
      if (isStockable && productTrackingType === 'serial') {
        if (serialNumbers.length !== quantity || new Set(serialNumbers).size !== serialNumbers.length) {
          return res.status(400).json({ success: false, code: 'POS_SERIALS_REQUIRED', message: `Enter exactly ${quantity} unique serial number(s) for ${product.name}.` });
        }
        const availableSerials = await findAvailableSerialsOutsideQuarantine({
          companyId,
          productId: product._id,
          warehouseId,
          serialNumbers,
        });
        const signedSerials = new Set((snapshotProduct?.serialNumbers || []).map((serial) => String(serial).toUpperCase()));
        if (offlineContext && serialNumbers.some((serial) => !signedSerials.has(serial))) {
          return res.status(403).json({ success: false, code: 'POS_OFFLINE_SERIAL_NOT_IN_SNAPSHOT', message: `A serial number for ${product.name} was not available in the signed offline snapshot.` });
        }
        if (availableSerials.length !== serialNumbers.length && !offlineContext) {
          const found = new Set(availableSerials.map((serial) => String(serial.serialNo).toUpperCase()));
          const unavailable = serialNumbers.filter((serial) => !found.has(serial));
          return res.status(409).json({ success: false, code: 'POS_SERIAL_UNAVAILABLE', message: `Serial number(s) unavailable in this warehouse for ${product.name}: ${unavailable.join(', ')}` });
        }
      } else if (serialNumbers.length) {
        return res.status(400).json({ success: false, code: 'POS_SERIALS_NOT_ALLOWED', message: `${product.name} is not configured for serial tracking.` });
      }
      const restaurantUsesRecipeStock = Boolean(
        restaurantLine
        && (restaurantLine.stockMode === 'recipe' || restaurantLine.barStockProductId),
      );
      if (isStockable && !restaurantUsesRecipeStock) {
        const stockLevel = stockLevelByProduct.get(String(product._id));
        const availableStock = stockLevel
          ? Math.max(0, Number(stockLevel.qty_on_hand || 0) - Number(stockLevel.qty_reserved || 0) - (quarantinedByProduct.get(String(product._id)) || 0))
          : 0;
        const totalRequired = (stockRequiredByProduct.get(String(product._id)) || 0) + quantity;
        stockRequiredByProduct.set(String(product._id), totalRequired);
        const maySellBelowOnHand = allowNegativeStock
          && productTrackingType === 'none'
          && (quarantinedByProduct.get(String(product._id)) || 0) <= 0;
        const hasQuarantinedStock = (quarantinedByProduct.get(String(product._id)) || 0) > 0;
        if (availableStock < totalRequired && (!offlineContext || hasQuarantinedStock) && !maySellBelowOnHand) {
          return res.status(409).json({
            success: false,
            code: 'ERR_INSUFFICIENT_STOCK',
            message: `Insufficient stock for ${product.name}. Available: ${availableStock}, Required: ${totalRequired}`,
          });
        }
      }

      const taxRate = offlineContext
        ? Number(snapshotProduct.taxRate)
        : restaurantLine ? Number(restaurantLine.taxRate) : resolveProductTaxRate(product);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return res.status(422).json({
          success: false,
          code: 'ERR_INVALID_PRODUCT_TAX',
          message: `The configured tax rate for ${product.name} is invalid`,
        });
      }
      const taxCode = offlineContext
        ? snapshotProduct.taxCode
        : restaurantLine ? String(restaurantLine.taxCode) : (product.taxCode || (taxRate > 0 ? 'B' : 'A'));
      if (offlineContext && Number(item.taxRate) !== taxRate) offlineTaxPayloadMismatch = true;
      const baseUnitPrice = requestedUnitPrice / Number(wholesaleLine.multiplier || 1);
      const { subtotal, discountAmount, netAmount, taxAmount, lineTotal } = calculatePosLineAmounts({
        quantity, unitPrice: baseUnitPrice, discountPct, taxRate,
      });
      if (![subtotal, discountAmount, netAmount, taxAmount, lineTotal].every(Number.isFinite)
        || lineTotal > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({
          success: false,
          code: 'ERR_INVALID_SALE_LINE',
          message: `Sale line total is outside the supported range for ${product.name}`,
        });
      }

      invoiceLines.push({
        product: product._id,
        productCode: offlineContext ? snapshotProduct.sku : (product.sku || ''),
        productName: offlineContext ? snapshotProduct.name : product.name,
        description: restaurantLine
          ? String(restaurantLine.description)
          : offlineContext
          ? snapshotProduct.name
          : item.openPrice === true
            ? String(item.description).normalize('NFKC').trim()
            : Number(wholesaleLine.multiplier || 1) > 1
              ? `${product.name} · ${saleQuantity} ${wholesaleLine.unitLabel} (${quantity} ${product.unit || 'unit'})`
              : (item.description || product.name),
        qty: quantity,
        unit: offlineContext ? snapshotProduct.unit : (product.unit || 'pcs'),
        unitPrice: baseUnitPrice,
        discountPct: discountPct,
        discountReason,
        discountCapPercent: promotion
          ? Number(promotionDiscountPctByIndex.get(itemIndex) || 0)
          : (appliedCartDiscountPct > 0 || isSavedRestaurantPromotion) ? 0 : requestedDiscountPct,
        taxCode: taxCode,
        taxRate: taxRate,
        taxAmount: taxAmount,
        lineSubtotal: subtotal,
        lineTotal: lineTotal,
        serviceChargeExempt: restaurantLine?.serviceChargeExempt === true,
        warehouse: warehouseId,
        serialNumbers,
      });

      if (isStockable && !restaurantUsesRecipeStock) {
        stockUpdates.push({
          product,
          quantity,
          trackingType: productTrackingType,
          warehouseId,
          lineData: {
            productName: product.name,
            lineOrder: invoiceLines.length - 1,
            unitCost: offlineContext ? Number(snapshotProduct.averageCost) || 0 : Number(product.averageCost) || 0,
            serialNumbers,
            batchAllocations,
            batchSnapshot: batchSnapshot || [],
            reconstructedLegacyBatchAllocation,
          },
          offlineAvailableStock: offlineContext ? Number(snapshotProduct.availableStock) || 0 : undefined,
        });
      }
    }

    if (missingProducts.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Products not found: ${missingProducts.join(', ')}`,
      });
    }

    const voucherTokens = Array.isArray(voucherReservationTokens)
      ? [...new Set(voucherReservationTokens.map((token) => String(token || '').trim()).filter(Boolean))]
      : [];
    if (voucherTokens.length > 10 || (voucherReservationTokens != null && !Array.isArray(voucherReservationTokens))) {
      return res.status(400).json({
        success: false,
        code: 'POS_VOUCHER_RESERVATION_INVALID',
        message: 'Voucher reservations are invalid. Reapply the voucher before checkout.',
      });
    }
    const voucherCartInput = {
      items: items.map((item, index) => ({
        productId: String(item.productId),
        quantity: Number(item.quantity),
        unitPrice: Number(invoiceLines[index].unitPrice),
        catalogUnitPrice: Number(item.catalogUnitPrice ?? invoiceLines[index].unitPrice),
        discountPct: Number(item.discountPct || 0),
        discountReason: String(item.discountReason || ''),
      })),
      cartDiscountPct,
      cartDiscountReason,
      promotionId: String(promotionId || ''),
      clientId: client?.isWalkIn ? 'walk-in' : String(clientId || 'walk-in'),
      warehouseId: String(warehouseId || ''),
      promotion,
    };
    const voucherProductsById = new Map(items.map((item, index) => {
      const product = productsMap.get(String(item.productId));
      const restricted = isDiscountRestricted(product);
      const categoryId = String(product.category?._id || product.category || '');
      return [String(item.productId), {
        price: Number(invoiceLines[index].unitPrice),
        isActive: true,
        isNoDiscount: restricted,
        category: { _id: categoryId, isNoDiscount: Boolean(product.categoryNoDiscount) },
        taxCode: invoiceLines[index].taxCode,
      }];
    }));
    const voucherQuote = await quotePosVouchers(String(companyId), posCashierId, {
      tokens: voucherTokens,
      ...(req.posV2Completion?.voucherReservations ? { invoiceId: req.posV2Completion.invoiceId } : {}),
      cartInput: voucherCartInput,
      productsById: voucherProductsById,
    });

    const discountBeforeVouchers = roundMoney(
      invoiceLines.reduce((sum, line) => sum + (line.lineSubtotal * (line.discountPct || 0) / 100), 0),
    );
    if (voucherQuote) {
      const voucherCodeLabels = [...new Set(voucherQuote.vouchers.map((voucher) => `****${voucher.codeSuffix}`))];
      for (const [index, line] of invoiceLines.entries()) {
        const voucherDiscount = Number(voucherQuote.pricing.lines[index]?.voucherDiscountRwf || 0);
        if (!voucherDiscount) continue;
        const existingDiscount = roundMoney(line.lineSubtotal * Number(line.discountPct || 0) / 100);
        const totalLineDiscount = roundMoney(existingDiscount + voucherDiscount);
        if (totalLineDiscount > line.lineSubtotal + 0.005) {
          return res.status(409).json({
            success: false,
            code: 'POS_VOUCHER_CART_CHANGED',
            message: 'Voucher allocation no longer matches the sale. Reapply the voucher.',
          });
        }
        const netAmount = roundMoney(line.lineSubtotal - totalLineDiscount);
        line.discountPct = line.lineSubtotal > 0 ? totalLineDiscount / line.lineSubtotal * 100 : 0;
        line.discountReason = [line.discountReason, ...voucherCodeLabels.map((label) => `Voucher ${label}`)]
          .filter(Boolean)
          .join('; ');
        line.taxAmount = roundMoney(netAmount * (line.taxRate / 100));
        line.lineTotal = roundMoney(netAmount + line.taxAmount);
      }
    }

    // Calculate totals
    const serviceCharge = req.posRestaurantCheckout?.serviceCharge || null;
    const serviceChargeAmount = Number(serviceCharge?.amountRwf || 0);
    const serviceChargeTaxAmount = Number(serviceCharge?.taxAmountRwf || 0);
    if (serviceCharge && (
      !['off', 'income', 'pass-through'].includes(serviceCharge.mode)
      || !Number.isFinite(serviceChargeAmount)
      || serviceChargeAmount < 0
      || !Number.isFinite(serviceChargeTaxAmount)
      || serviceChargeTaxAmount < 0
      || (serviceCharge.mode === 'off' && (serviceChargeAmount > 0 || serviceChargeTaxAmount > 0))
      || (serviceCharge.taxable !== true && serviceChargeTaxAmount !== 0)
      || (serviceChargeAmount > 0 && !Number.isFinite(Number(serviceCharge.ratePct)))
    )) {
      return res.status(409).json({
        success: false,
        code: 'RESTAURANT_SERVICE_CHARGE_SNAPSHOT_INVALID',
        message: 'The saved Restaurant service-charge details are invalid. Review the bill before retrying.',
      });
    }
    const itemSubtotal = roundMoney(invoiceLines.reduce((sum, line) => sum + line.lineSubtotal, 0));
    const subtotal = roundMoney(itemSubtotal + serviceChargeAmount);
    const voucherDiscountRwf = Number(voucherQuote?.pricing.totals.voucherDiscountRwf || 0);
    const totalDiscount = roundMoney(discountBeforeVouchers + voucherDiscountRwf);
    const netSales = roundMoney(subtotal - totalDiscount);
    const totalTax = roundMoney(
      invoiceLines.reduce((sum, line) => sum + line.taxAmount, 0) + serviceChargeTaxAmount,
    );
    const grandTotal = roundMoney(
      invoiceLines.reduce((sum, line) => sum + line.lineTotal, 0)
        + serviceChargeAmount
        + serviceChargeTaxAmount,
    );
    if (offlineContext) {
      const savedDisplayTotal = Number(req.body.displayTotal);
      if (Number.isFinite(savedDisplayTotal) && Math.abs(savedDisplayTotal - grandTotal) > 0.009) {
        return res.status(409).json({
          success: false,
          code: 'POS_OFFLINE_TOTAL_SNAPSHOT_MISMATCH',
          message: `The saved sale total (${savedDisplayTotal.toFixed(2)}) differs from the signed-catalog total (${grandTotal.toFixed(2)}). Manager review is required; the sale was not changed.`,
        });
      }
      if (offlineTaxPayloadMismatch && !Number.isFinite(savedDisplayTotal)) {
        return res.status(409).json({
          success: false,
          code: 'POS_OFFLINE_TAX_SNAPSHOT_MISMATCH',
          message: 'The queued tax rate differs from the signed offline catalog, and the saved sale total is unavailable to verify. Manager review is required.',
        });
      }
    }
    const breachedDiscountCaps = evaluateDiscountCaps({
      limits: applicableDiscountLimits,
      lineDiscounts: invoiceLines.map((line) => ({ percent: Number(line.discountCapPercent) || 0 })),
      cartDiscountPercent: promotion ? promotionDiscountPercent : cartDiscountPct,
      totalDiscountRwf: discountBeforeVouchers,
    });
    requiresManagerApproval = requiresManagerApproval || breachedDiscountCaps.length > 0;
    if (requiresManagerApproval && !req.body.managerApprovalId && !req.posV2Completion) {
      return res.status(403).json({
        success: false,
        code: 'POS_MANAGER_APPROVAL_REQUIRED',
        message: breachedDiscountCaps.length
          ? 'The configured discount limit was exceeded. A second manager must approve this sale.'
          : 'A second manager must approve price overrides before this sale can be recorded.',
      });
    }

    // Determine payment status
    const normalizedPaymentReference = String(paymentReference || '').trim();
    const storedValueMethods = ['gift_card', 'store_credit', 'loyalty'];
    const supportedPaymentMethods = ['cash', 'card', 'bank_transfer', 'mobile_money', 'cheque', 'loyalty_points', ...storedValueMethods];
    const rawPayments = isV2Pending
      ? []
      : req.posV2Completion
      ? (Array.isArray(requestedPayments) ? requestedPayments : [])
      : Array.isArray(requestedPayments) && requestedPayments.length
      ? requestedPayments
      : [{
        paymentMethod,
        provider: paymentProvider,
        amount: paymentAmount,
        reference: normalizedPaymentReference,
        providerName: req.body.providerName,
        payerPhone: req.body.payerPhone,
        bankAccountId,
      }];
    if (rawPayments.length > 5) {
      return res.status(400).json({ success: false, code: 'POS_TOO_MANY_TENDERS', message: 'A sale can contain at most five payment methods.' });
    }
    const normalizedPayments = [];
    const transactionReferences = new Set();
    const v2StoredValuePaymentIds = new Set(req.posV2Completion?.storedValuePaymentIds || []);
    const v2ManualMobileMoneyPaymentIds = new Set(req.posV2Completion?.manualMobileMoneyPaymentIds || []);
    const placeholderReferences = new Set(['na', 'n/a', 'none', 'null', 'unknown', 'test', 'paid', 'cash', '-', '0', '000']);
    for (const [index, entry] of rawPayments.entries()) {
      const method = String(entry?.paymentMethod || (rawPayments.length === 1 ? paymentMethod : '')).toLowerCase();
      const provider = String(entry?.provider || '').trim().toLowerCase();
      const providerName = String(entry?.providerName || '').normalize('NFKC').trim();
      const amount = entry?.amount == null || entry.amount === '' ? 0 : Number(entry.amount);
      const reference = String(entry?.reference || '').trim();
      if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
        return res.status(400).json({ success: false, code: 'ERR_INVALID_PAYMENT_AMOUNT', message: `Payment ${index + 1} must have a valid non-negative amount.` });
      }
      if (amount > 0 && !supportedPaymentMethods.includes(method)) {
        return res.status(400).json({ success: false, code: 'ERR_INVALID_PAYMENT_METHOD', message: `Select a supported method for payment ${index + 1}.` });
      }
      if (provider && (method !== 'mobile_money' || !['momo', 'airtel'].includes(provider))) {
        return res.status(400).json({ success: false, code: 'POS_MOBILE_MONEY_PROVIDER_INVALID', message: `Select MoMo or Airtel as the provider for payment ${index + 1}.` });
      }
      const savedV2ManualMobileMoneyPayment = req.posV2Completion
        && method === 'mobile_money'
        && v2ManualMobileMoneyPaymentIds.has(String(entry?.manualMobileMoneyPaymentId || ''));
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method)
        && !reference && !savedV2ManualMobileMoneyPayment) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_REQUIRED', message: `Enter a verified transaction or cheque reference for payment ${index + 1}.` });
      }
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method)
        && placeholderReferences.has(reference.toLowerCase().replace(/\s+/g, ''))) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_INVALID', message: `Enter the actual provider or bank reference for payment ${index + 1}; placeholder values are not accepted.` });
      }
      if (reference.length > 160 || providerName.length > 80) {
        return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_TOO_LONG', message: 'Payment references must be 160 characters or fewer, and provider names must be 80 characters or fewer.' });
      }
      if (amount > 0 && ['bank_transfer', 'mobile_money', 'cheque'].includes(method) && reference) {
        const referenceKey = reference.toLowerCase();
        if (transactionReferences.has(referenceKey)) {
          return res.status(400).json({ success: false, code: 'POS_PAYMENT_REFERENCE_DUPLICATE', message: 'Each non-cash payment must use its own transaction reference.' });
        }
        transactionReferences.add(referenceKey);
      }
      const savedV2GiftCardPayment = req.posV2Completion
        && method === 'gift_card'
        && v2StoredValuePaymentIds.has(String(entry?.posPaymentId || ''))
        && Boolean(entry?.storedValueAccountId);
      if (amount > 0 && ['gift_card', 'store_credit'].includes(method)
        && reference.length < 8 && !savedV2GiftCardPayment) {
        return res.status(400).json({ success: false, code: 'POS_STORED_VALUE_CODE_REQUIRED', message: `Enter the ${method.replace('_', ' ')} code for payment ${index + 1}.` });
      }
      if (amount > 0 && method === 'loyalty' && (!clientId || clientId === 'walk-in')) {
        return res.status(400).json({ success: false, code: 'POS_LOYALTY_CUSTOMER_REQUIRED', message: 'Select a registered customer to redeem loyalty credit.' });
      }
      if (amount > 0 && method === 'loyalty_points' && (!clientId || clientId === 'walk-in')) {
        return res.status(400).json({ success: false, code: 'POS_LOYALTY_POINTS_CUSTOMER_REQUIRED', message: 'Select a registered customer to redeem loyalty points.' });
      }
      if (amount > 0 && method === 'cheque' && (!client || client.isWalkIn)) {
        return res.status(400).json({ success: false, code: 'POS_CHEQUE_CUSTOMER_REQUIRED', message: 'Select a registered customer before accepting a cheque.' });
      }
      if (amount > 0 && method === 'cheque' && !Number.isSafeInteger(amount)) {
        return res.status(400).json({ success: false, code: 'POS_CHEQUE_AMOUNT_INVALID', message: 'Cheque amounts must be whole-number RWF values.' });
      }
      if (amount > 0 && method === 'loyalty_points' && req.posV2Completion) {
        return res.status(409).json({ success: false, code: 'POS_LOYALTY_POINTS_V2_UNAVAILABLE', message: 'Loyalty points are not available in this checkout until their fiscal payment treatment is confirmed.' });
      }
      if (amount > 0 && (storedValueMethods.includes(method) || method === 'loyalty_points') && offlineContext) {
        return res.status(400).json({ success: false, code: 'POS_STORED_VALUE_OFFLINE_UNAVAILABLE', message: 'Gift card, store credit, and loyalty payments require an online balance check.' });
      }
      if (amount > 0) {
        const methodCode = method === 'mobile_money'
          ? provider === 'momo' ? 'MTN_MOMO' : provider === 'airtel' ? 'AIRTEL_MONEY' : ''
          : method === 'credit' ? 'CREDIT'
            : method === 'loyalty' ? 'LOYALTY'
              : method.toUpperCase();
        if (!methodCode) {
          return res.status(400).json({ success: false, code: 'POS_MOBILE_MONEY_PROVIDER_INVALID', message: `Select MoMo or Airtel as the provider for payment ${index + 1}.` });
        }
        try {
          await posPaymentService.assertPaymentMethodEnabled({
            companyId: String(companyId),
            registerId: String(claimedRegister.id),
            tillType: String(claimedRegister.systemTillType || 'retail'),
            method: methodCode,
          });
          posPaymentService.validateTenderConfiguration(paymentSettings, {
            registerId: String(claimedRegister.id),
            tillType: String(claimedRegister.systemTillType || 'retail'),
            method: methodCode,
            amount,
            reference,
            customerId: clientId,
            tendered: method === 'cash' ? amount : undefined,
            allowOptionalReference: savedV2ManualMobileMoneyPayment,
          });
        } catch (error) {
          const status = error?.code === 'POS_PAYMENT_METHOD_DISABLED'
            || error?.code === 'POS_PAYMENT_CONFIRMATION_UNAVAILABLE'
            || error?.code === 'POS_PAYMENT_PROVIDER_NOT_CONFIGURED'
            ? 409
            : 400;
          return res.status(status).json({
            success: false,
            code: error?.code || 'POS_PAYMENT_SETTINGS_INVALID',
            message: error?.message || 'Payment settings could not be validated.',
          });
        }
      }
      normalizedPayments.push({
        paymentMethod: method,
        ...(method === 'mobile_money' ? { provider } : {}),
        ...(providerName ? { providerName } : {}),
        amount,
        reference,
        bankAccountId: entry?.bankAccountId || (rawPayments.length === 1 ? bankAccountId : null) || null,
        ...(req.posV2Completion && entry?.storedValueAccountId
          ? { storedValueAccountId: String(entry.storedValueAccountId) } : {}),
        ...(req.posV2Completion && entry?.posPaymentId
          ? { posPaymentId: String(entry.posPaymentId) } : {}),
      });
    }
    for (const tender of normalizedPayments) tender.amount = roundMoney(tender.amount);
    const amountTendered = roundMoney(normalizedPayments.reduce((sum, tender) => sum + tender.amount, 0));
    const cashTendered = roundMoney(normalizedPayments.filter((tender) => tender.paymentMethod === 'cash').reduce((sum, tender) => sum + tender.amount, 0));
    if (!Number.isFinite(amountTendered) || amountTendered < 0 || amountTendered > Number.MAX_SAFE_INTEGER) {
      return res.status(400).json({
        success: false,
        code: 'ERR_INVALID_PAYMENT_AMOUNT',
        message: 'Payment amount must be a valid non-negative number',
      });
    }
    const offlineNonCashTotal = normalizedPayments
      .filter((tender) => tender.paymentMethod !== 'cash')
      .reduce((sum, tender) => sum + tender.amount, 0);
    const offlineMobileMoneyCount = normalizedPayments
      .filter((tender) => tender.paymentMethod === 'mobile_money' && tender.amount > 0).length;
    if (offlineContext && !isV2Pending && (
      !normalizedPayments.length
      || normalizedPayments.some((tender) => (
        tender.amount <= 0 || !['cash', 'card', 'mobile_money'].includes(tender.paymentMethod)
        || tender.paymentMethod === 'card'
          && placeholderReferences.has(tender.reference.toLowerCase().replace(/\s+/g, ''))
      ))
      || offlineMobileMoneyCount > 1
      || amountTendered < grandTotal - 0.009
      || offlineNonCashTotal > grandTotal + 0.009
      || offlineMobileMoneyCount > 0 && Math.abs(amountTendered - grandTotal) > 0.009
      || !(requestKey || req.posV2Completion && offlineContext.operationId)
    )) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_PAYMENT_INVALID', message: 'Offline POS requires full payment using cash, card, or manual mobile money. Mobile money may be used once per sale, and any change must come from cash.' });
    }
    // Card is not a cash-equivalent tender. Until a terminal/provider
    // confirms authorization and settlement, accepting it here would mark an
    // unverified payment as paid and post it to the cash-on-hand account.
    if (amountTendered > grandTotal && cashTendered < amountTendered - grandTotal) {
      return res.status(400).json({
        success: false,
        code: 'ERR_PAYMENT_EXCEEDS_TOTAL',
        message: 'Any change due from split tender must be covered by the cash portion.',
      });
    }
    let paidAmount = Math.min(amountTendered, grandTotal);
    const changeDue = roundMoney(Math.max(0, amountTendered - paidAmount));
    let remainingToApply = paidAmount;
    // Apply non-cash tenders first so any permitted overpayment is returned
    // from cash, and the posted cash amount equals cash actually retained.
    const allocationOrder = [
      ...normalizedPayments.filter((tender) => tender.paymentMethod !== 'cash'),
      ...normalizedPayments.filter((tender) => tender.paymentMethod === 'cash'),
    ];
    const appliedPayments = allocationOrder.map((tender) => {
      const appliedAmount = Math.min(tender.amount, remainingToApply);
      remainingToApply = Math.max(0, remainingToApply - appliedAmount);
      return { ...tender, amount: appliedAmount };
    }).filter((tender) => tender.amount > 0);
    let paymentStatus = 'draft';
    let amountPaid = 0;
    let amountOutstanding = grandTotal;

    if (paidAmount >= grandTotal - 0.009) {
      paymentStatus = 'fully_paid';
      paidAmount = grandTotal;
      amountPaid = grandTotal;
      amountOutstanding = 0;
    } else if (paidAmount > 0) {
      paymentStatus = 'partially_paid';
      amountPaid = roundMoney(paidAmount);
      amountOutstanding = roundMoney(grandTotal - amountPaid);
    }
    if (isV2Pending) {
      paymentStatus = 'PENDING_PAYMENT';
      amountPaid = 0;
      amountOutstanding = grandTotal;
    }
    const hasCreditTender = String(paymentMethod || '').toLocaleLowerCase() === 'credit'
      || (Array.isArray(requestedPayments) && requestedPayments.some((payment) => (
        String(payment?.paymentMethod || '').toLocaleLowerCase() === 'credit'
      )));
    if (!tillFeatures.customerCredit && (hasCreditTender || !isV2Pending && amountOutstanding > 0)) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Customer credit is disabled for this till type. Complete payment before finishing the sale.',
      });
    }

    // Execute in transaction
    let invoice;
    let totalCOGS = 0;
    let pharmacyStockReservation = null;
    let storedLinesForPosting = invoiceLines;
    let v2CreditLedgerData = null;
    let customerCreditLedgerData = null;
    let customerCreditTermsDays = 30;
    let fiscalOutboxId = null;
    const financialAccountCodes = new Set();

    await runInTransaction(async (session) => {
      const postingClient = session?.$executeRawUnsafe && session?.$queryRawUnsafe
        ? session
        : dbClient();
      if (offlineContext) {
        const allocation = await postingClient.$queryRawUnsafe(
          `UPDATE pos_receipt_number_allocations
              SET operation_id = $6, used_at = CURRENT_TIMESTAMP
            WHERE company_id = $1 AND device_id = $2 AND register_id = $3
              AND receipt_number = $4 AND (operation_id IS NULL OR operation_id = $6)
              AND expires_at > $5::timestamptz
          RETURNING id`,
          String(companyId),
          String(req.body.deviceId),
          String(claimedRegister.id),
          offlineContext.receiptNumber,
          offlineContext.saleCreatedAt,
          offlineContext.operationId,
        );
        if (!allocation.length) {
          throw Object.assign(new Error('This offline receipt number has already been used or expired. Refresh the POS receipt block and retry only if the sale was not recorded.'), {
            code: 'POS_OFFLINE_RECEIPT_NUMBER_UNAVAILABLE',
            statusCode: 409,
          });
        }
      }
      if (requestKey) {
        const reservation = await dbClient().$queryRawUnsafe(
          'INSERT INTO pos_sale_requests (company_id, request_key, created_by_id, payload_hash, status, created_at, updated_at) VALUES ($1, $2, $3, $4, \'processing\', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (company_id, request_key) DO NOTHING RETURNING request_key AS "requestKey"',
          String(companyId), requestKey, posCashierId, payloadHash,
        );
        if (!reservation.length) {
          const error = new Error('This POS checkout request is already being processed.');
          error.code = 'POS_IDEMPOTENCY_DUPLICATE';
          throw error;
        }
      }
      if (proformaDocument) {
        const lockedProforma = await dbClient().$queryRawUnsafe(
          'SELECT status, conversion_key AS "conversionKey" FROM pos_non_posting_documents WHERE id = $1 AND company_id = $2 AND document_type = \'PROFORMA\' FOR UPDATE',
          String(proformaDocument.id), String(companyId),
        );
        if (lockedProforma.length !== 1 || lockedProforma[0].status !== 'open'
          || String(lockedProforma[0].conversionKey) !== String(proformaDocument.conversionKey)) {
          throw Object.assign(new Error('This proforma has already been converted or changed.'), { code: 'POS_PROFORMA_NOT_OPEN' });
        }
      }
      if (offlineContext && !req.posV2Completion) {
        const snapshotRows = await dbClient().$queryRawUnsafe(
          'SELECT queue_limit AS "queueLimit", used_value AS "usedValue" FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 FOR UPDATE',
          offlineContext.snapshotId, String(companyId),
        );
        const snapshotRow = snapshotRows[0];
        if (!snapshotRow || Number(snapshotRow.usedValue) + grandTotal > Number(snapshotRow.queueLimit)) {
          throw Object.assign(new Error('This register has reached its authorized offline queued-value limit.'), {
            code: 'POS_OFFLINE_VALUE_LIMIT',
            statusCode: 409,
          });
        }
        await dbClient().$executeRawUnsafe(
          'UPDATE pos_offline_snapshots SET used_value = used_value + $1::numeric WHERE id = $2 AND company_id = $3',
          grandTotal, offlineContext.snapshotId, String(companyId),
        );
      }
      if (offlineContext && !isV2Pending) {
        const actionAmounts = ['card', 'mobile_money']
          .map((action) => ({
            action,
            amount: Math.round(appliedPayments
              .filter((tender) => tender.paymentMethod === action)
              .reduce((sum, tender) => sum + tender.amount, 0)),
          }))
          .filter((entry) => entry.amount > 0);
        for (const { action, amount } of actionAmounts) {
          await reserveOfflineActionUsage({
            tx: postingClient,
            companyId: String(companyId),
            snapshotId: offlineContext.snapshotId,
            operationId: offlineContext.operationId,
            deviceId: String(req.body.deviceId),
            registerId: String(requestedRegisterId),
            action,
            amount,
            occurredAt: offlineContext.saleCreatedAt,
          });
        }
      }

      if (requiresManagerApproval && !req.posV2Completion) {
        const discountApplicationApproval = discountApprovalScope === 'DISCOUNT_APPLICATION';
        const approvalPayload = discountApplicationApproval
          ? buildDiscountApprovalContext(req.body)
          : { ...req.body };
        if (!discountApplicationApproval) delete approvalPayload.managerApprovalId;
        await consumePosManagerApproval({
          approvalId: req.body.managerApprovalId,
          companyId,
          cashierId: posCashierId,
          action: 'discount',
          subjectId: null,
          payload: approvalPayload,
        });
      }

      // Reserve receivables against the customer's configured credit limit
      // while holding their row lock. This serializes concurrent POS checkouts
      // for the same account so two tills cannot spend the same credit twice.
      if (amountOutstanding > 0 && !isV2Pending) {
        if (!clientId) {
          const error = new Error('Walk-in sales must be paid in full. Select a customer with an approved credit limit to record an unpaid balance.');
          error.code = 'POS_WALKIN_CREDIT_NOT_ALLOWED';
          throw error;
        }
        if (!client) {
          const error = new Error('The selected customer could not be found in this workspace.');
          error.code = 'POS_CLIENT_NOT_FOUND';
          throw error;
        }
        const lockedClients = await dbClient().$queryRawUnsafe(
          'SELECT credit_limit, outstanding_balance, credit_account_status, credit_terms_days, code FROM clients WHERE id = $1 AND company_id = $2 AND is_active = TRUE FOR UPDATE',
          String(client._id), String(companyId),
        );
        if (!lockedClients.length) {
          const error = new Error('The selected customer could not be found in this workspace.');
          error.code = 'POS_CLIENT_NOT_FOUND';
          throw error;
        }
        if (String(lockedClients[0].credit_account_status || 'ACTIVE') !== 'ACTIVE') {
          throw Object.assign(new Error('This customer credit account is on hold or closed. Ask a manager to review it before charging the account.'), {
            code: 'POS_CREDIT_ACCOUNT_NOT_ACTIVE',
          });
        }
        customerCreditTermsDays = Number(lockedClients[0].credit_terms_days ?? 30);
        if (req.posV2Completion && /^WALKIN-/i.test(String(lockedClients[0].code || ''))) {
          throw Object.assign(new Error('Choose a named customer before adding credit. Walk-in sales must be paid in full.'), {
            code: 'POS_CREDIT_CUSTOMER_REQUIRED',
          });
        }
        const creditLimit = Number(lockedClients[0].credit_limit || 0);
        const outstandingBalance = Number(lockedClients[0].outstanding_balance || 0);
        const nextOutstandingBalance = outstandingBalance + amountOutstanding;
        const exceedsCreditLimit = creditLimit <= 0 || nextOutstandingBalance > creditLimit + 0.00005;
        if (req.posV2Completion
          && Math.abs(amountOutstanding - Number(req.posV2Completion.creditAmount || 0)) > 0.00005) {
          throw Object.assign(new Error('The saved credit allocation does not match the invoice balance. Review the sale before completing it.'), {
            code: 'POS_CREDIT_ALLOCATION_MISMATCH',
          });
        }
        if (req.posV2Completion) {
          const overdueRows = await dbClient().$queryRawUnsafe(
            'SELECT COALESCE(SUM(amount_outstanding), 0)::text AS "overdueAmount" FROM invoices WHERE company_id = $1 AND client_id = $2 AND id <> $3 AND due_date < CURRENT_TIMESTAMP AND amount_outstanding > 0 AND status NOT IN (\'cancelled\', \'draft\', \'PENDING_PAYMENT\', \'fully_paid\')',
            String(companyId),
            String(client._id),
            String(req.posV2Completion.invoiceId),
          );
          if (Number(overdueRows[0]?.overdueAmount || 0) > 0) {
            throw Object.assign(new Error('This customer has an overdue balance. Choose another payment method or ask a manager to review the account.'), {
              code: 'POS_CUSTOMER_OVERDUE',
            });
          }
          const paymentSettings = await posPaymentService.getPaymentSettings(String(companyId));
          if (exceedsCreditLimit && !paymentSettings.allowOverCreditLimit) {
            const availableCredit = Math.max(0, creditLimit - outstandingBalance);
            throw Object.assign(
              new Error(`This credit sale exceeds the customer's available credit of ${Math.floor(availableCredit)} RWF.`),
              { code: 'POS_CREDIT_LIMIT_EXCEEDED' },
            );
          }
          if (exceedsCreditLimit) {
            const overrideReason = String(req.posV2Completion.creditOverrideReason || '').trim();
            if (overrideReason.length < 10) {
              throw Object.assign(new Error('Enter a reason of at least 10 characters before requesting a manager credit-limit override.'), {
                code: 'POS_CREDIT_OVERRIDE_REASON_REQUIRED',
              });
            }
            const approvalContext = {
              saleId: String(req.posV2Completion.invoiceId),
              clientId: String(client._id),
              creditAmount: Math.round(amountOutstanding),
              creditLimit: Math.round(creditLimit),
              outstandingBalance: Math.round(outstandingBalance),
              reason: overrideReason,
            };
            const approvalToken = String(req.posV2Completion.creditApprovalToken || '').trim();
            if (!approvalToken) {
              throw Object.assign(new Error('A manager must approve this credit amount before the sale can be completed.'), {
                code: 'POS_CREDIT_APPROVAL_REQUIRED',
                approvalContext,
              });
            }
            const approval = await dbClient().posApproval.findFirst({
              where: {
                companyId: String(companyId),
                registerId: String(claimedRegister.id),
                requestedBy: posCashierId,
                action: 'CREDIT_OVER_LIMIT',
                tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
                usedAt: null,
                expiresAt: { gt: new Date() },
                context: { equals: approvalContext },
              },
            });
            if (!approval) {
              throw Object.assign(new Error('The manager approval is invalid, expired, already used, or no longer matches this customer balance.'), {
                code: 'POS_CREDIT_APPROVAL_INVALID',
              });
            }
            const consumed = await dbClient().posApproval.updateMany({
              where: {
                id: approval.id,
                companyId: String(companyId),
                registerId: String(claimedRegister.id),
                requestedBy: posCashierId,
                action: 'CREDIT_OVER_LIMIT',
                usedAt: null,
                expiresAt: { gt: new Date() },
              },
              data: { usedAt: new Date() },
            });
            if (consumed.count !== 1) {
              throw Object.assign(new Error('The manager approval was already used or expired. Request a new approval.'), {
                code: 'POS_CREDIT_APPROVAL_INVALID',
              });
            }
            await writePosAuditLog({
              companyId: String(companyId),
              registerId: String(claimedRegister.id),
              userId: posCashierId,
              event: 'APPROVAL_USED',
              metadata: { approvalId: approval.id, action: 'CREDIT_OVER_LIMIT', approvedBy: approval.approvedBy, reason: overrideReason },
              ip: requestIp(req),
            }, dbClient());
          }
        } else if (exceedsCreditLimit) {
          const availableCredit = Math.max(0, creditLimit - outstandingBalance);
          const error = new Error(`Customer credit limit exceeded. Available credit: ${availableCredit.toFixed(2)}; this sale needs ${amountOutstanding.toFixed(2)}.`);
          error.code = 'POS_CREDIT_LIMIT_EXCEEDED';
          throw error;
        }
        // Client.save below persists customer totals in this same transaction.
        // Use the freshly locked balance instead of the stale pre-transaction read.
        client.outstandingBalance = nextOutstandingBalance;
        customerCreditLedgerData = {
          clientId: String(client._id),
          amount: Math.round(amountOutstanding),
          clientBalanceAfter: nextOutstandingBalance,
        };
        if (req.posV2Completion) v2CreditLedgerData = customerCreditLedgerData;
      }

      if (!client) {
        client = await Client.create({
          company: companyId,
          ...walkInCustomer,
          type: 'individual',
        });
      }

      const activePosShifts = await dbClient().$queryRawUnsafe(
        'SELECT "id", "opened_by" AS "openedById" FROM "pos_shifts" WHERE "company_id" = $1 AND "register_id" = $2 AND "status" IN (\'open\', \'reopened\') FOR UPDATE',
        String(companyId),
        String(claimedRegister.id),
      );
      const activePosShift = activePosShifts[0];
      if (!activePosShift) {
        throw Object.assign(new Error('An open POS shift is required before recording a POS sale.'), {
          code: 'POS_SHIFT_REQUIRED',
        });
      }
      if (String(activePosShift.openedById) !== String(activeTill.openedById || activeTill.openedBy)) {
        throw Object.assign(new Error('The open till session is not linked to this register shift. Refresh the till before recording a sale.'), {
          code: 'POS_TILL_SHIFT_LINK_MISSING',
        });
      }

      // 1. Create the invoice
      const saleConfirmedAt = new Date();
      if (req.posV2Completion) {
        const lockedInvoice = await dbClient().$queryRawUnsafe(
          'SELECT status, pos_completion_key AS "completionKey" FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
          String(req.posV2Completion.invoiceId), String(companyId),
        );
        if (!lockedInvoice.length) {
          throw Object.assign(new Error('The pending POS sale was not found.'), { code: 'POS_PENDING_SALE_NOT_FOUND' });
        }
        if (lockedInvoice[0].status !== 'PENDING_PAYMENT') {
          if (lockedInvoice[0].completionKey === req.posV2Completion.completionKey) {
            completionReplayed = true;
            return;
          }
          throw Object.assign(new Error('The pending POS sale was already completed or changed.'), {
            code: 'POS_SALE_NOT_PENDING',
          });
        }
        invoice = await Invoice.findOne({
          _id: req.posV2Completion.invoiceId,
          company: companyId,
        }).session(session);
        if (!invoice || Math.abs(Number(invoice.totalAmount) - grandTotal) > 0.009) {
          throw Object.assign(new Error('The pending sale totals changed. Review or cancel the pending sale before retrying.'), {
            code: 'POS_PENDING_SALE_TOTAL_CHANGED',
          });
        }
        const savedLines = await dbClient().invoiceLine.findMany({
          where: { companyId: String(companyId), invoiceId: String(invoice._id) },
          orderBy: { lineOrder: 'asc' },
        });
        const savedItemLines = savedLines.filter((line) => line.isServiceLine !== true);
        const savedServiceLines = savedLines.filter((line) => line.isServiceLine === true);
        const serviceLineMatches = serviceChargeAmount > 0
          ? savedServiceLines.length === 1
            && Math.abs(Number(savedServiceLines[0].lineSubtotal) - serviceChargeAmount) <= 0.005
            && Math.abs(Number(savedServiceLines[0].lineTax) - serviceChargeTaxAmount) <= 0.005
            && Math.abs(Number(savedServiceLines[0].lineTotal) - serviceChargeAmount - serviceChargeTaxAmount) <= 0.005
            && savedServiceLines[0].serviceChargeExempt === true
          : savedServiceLines.length === 0;
        if (savedItemLines.length !== invoiceLines.length
          || savedItemLines.some((line, index) => !lineValuesMatch(line, invoiceLines[index]))
          || !serviceLineMatches) {
          throw Object.assign(new Error('The pending sale lines changed. Review or cancel the pending sale before retrying.'), {
            code: 'POS_PENDING_SALE_LINES_CHANGED',
          });
        }
        if (String(claimedRegister.systemTillType || '').toLowerCase() === 'pharmacy') {
          pharmacyStockReservation = await lockPharmacyPendingSaleReservation(
            postingClient,
            String(companyId),
            String(invoice._id),
          );
          if (pharmacyStockReservation.status !== 'reserved') {
            throw Object.assign(new Error('The Pharmacy stock reservation is no longer active.'), {
              code: 'POS_PHARMACY_RESERVATION_STATE_INVALID',
            });
          }
        }
        storedLinesForPosting = savedLines;
        invoice.status = paymentStatus;
        invoice.posPostingStatus = isV2Pending ? 'not_required' : 'pending';
        invoice.amountPaid = amountPaid;
        invoice.amountOutstanding = amountOutstanding;
        invoice.confirmedAt = saleConfirmedAt;
        invoice.confirmedBy = posCashierId;
        invoice.stockDeducted = true;
        invoice.autoConfirm = true;
        invoice.ebm = {
          ...(invoice.ebm || {}),
          fiscalEnvironment: fiscalMode,
          environment: fiscalMode,
          ebmStatus: autoFiscalSubmission ? 'pending' : 'not_submitted',
          retryCount: Number(invoice.ebm?.retryCount) || 0,
          paymentFlow: 'PAYMENTS_V2',
        };
        if (voucherQuote) invoice.posPricingSnapshot = voucherQuote.pricing;
        await invoice.save({ session });
      } else {
        invoice = await Invoice.create([{
          company: companyId,
          ...(offlineContext ? { referenceNo: offlineContext.receiptNumber } : {}),
          client: client._id,
          customerName: client.name,
          customerTin: buyerTin || client.taxId,
          customerAddress: client.contact?.address || client.address,
          lines: invoiceLines,
          status: paymentStatus,
          posOrigin: true,
          posPostingStatus: isV2Pending ? 'not_required' : 'pending',
          posCheckoutPayload: isV2Pending
            ? {
              ...pendingCheckoutPayload(req.body),
              ...(req.posRestaurantCheckout
                ? { restaurantCheckoutSnapshot: req.posRestaurantCheckout }
                : {}),
            }
            : {
              ...(req.body.pharmacyPatientId
                ? { pharmacyPatientId: String(req.body.pharmacyPatientId).slice(0, 24) }
                : {}),
              items: (Array.isArray(req.body.items) ? req.body.items : []).map((item) => ({
                ...(item.unitPrice != null ? { unitPrice: Number(item.unitPrice) } : {}),
                ...(item.catalogUnitPrice != null ? { catalogUnitPrice: Number(item.catalogUnitPrice) } : {}),
              })),
              ...(purchaseOrderNumber ? { purchaseOrderNumber } : {}),
              ...(salesperson ? { salespersonId: salesperson.id, salespersonName: salesperson.name } : {}),
              ...(buyerTin ? { buyerTin } : {}),
            },
          ...(isV2Pending ? {
            tillSessionId: String(activeTill._id),
            shiftId: String(activePosShift.id),
            cashierId: posCashierId,
            registerId: String(claimedRegister.id),
          } : {}),
          ebm: {
            fiscalEnvironment: fiscalMode,
            environment: fiscalMode,
            ebmStatus: isV2Pending ? 'not_submitted' : autoFiscalSubmission ? 'pending' : 'not_submitted',
            retryCount: 0,
            ...(isV2Pending ? { paymentFlow: 'PAYMENTS_V2' } : {}),
          },
          currencyCode: invoiceCurrency,
          ...(voucherQuote ? { posPricingSnapshot: voucherQuote.pricing } : {}),
          subtotal: subtotal,
          totalDiscount: totalDiscount,
          taxAmount: totalTax,
          totalAmount: grandTotal,
          grandTotal: grandTotal,
          ...(offlineContext ? { invoiceDate: offlineContext.saleCreatedAt } : {}),
          amountPaid: amountPaid,
          amountOutstanding: amountOutstanding,
          notes: notes || '',
          terms: terms || '',
          dueDate: dueDate || new Date(Date.now() + Math.max(0, customerCreditTermsDays) * 24 * 60 * 60 * 1000),
          createdBy: posCashierId,
          ...(isV2Pending ? {} : {
            confirmedAt: saleConfirmedAt,
            confirmedBy: posCashierId,
            confirmedDate: saleConfirmedAt,
          }),
          stockDeducted: !isV2Pending,
          autoConfirm: !isV2Pending,
        }], { session });

        invoice = invoice[0];
      }
      await validateAndRecordPharmacyCheckout({
        client: dbClient(),
        req,
        companyId: String(companyId),
        register: claimedRegister,
        items: req.body.items,
        invoiceId: String(invoice._id),
        pending: isV2Pending,
      });
      const voucherResult = voucherQuote || voucherTokens.length || req.posV2Completion?.voucherReservations
        ? await redeemPosVouchers(session, String(companyId), posCashierId, {
          tokens: voucherTokens,
          invoiceId: req.posV2Completion?.voucherReservations ? req.posV2Completion.invoiceId : String(invoice._id),
          cartInput: voucherCartInput,
          productsById: voucherProductsById,
          holdForPending: isV2Pending,
        })
        : null;
      if (Boolean(voucherQuote) !== Boolean(voucherResult)
        || voucherQuote && JSON.stringify(voucherQuote.pricing) !== JSON.stringify(voucherResult.pricing)) {
        throw Object.assign(new Error('Voucher pricing changed during checkout. Reapply the voucher and retry.'), {
          code: 'POS_VOUCHER_CART_CHANGED',
        });
      }
      // V2 checkout first creates a pending invoice. Keep its proforma open
      // until payment completion commits the real sale and its postings.
      if (proformaDocument && !isV2Pending) {
        const converted = await dbClient().$executeRawUnsafe(
          'UPDATE pos_non_posting_documents SET status = \'converted\', converted_invoice_id = $3, converted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2 AND document_type = \'PROFORMA\' AND status = \'open\' AND conversion_key = $4',
          String(proformaDocument.id), String(companyId), String(invoice._id), String(proformaDocument.conversionKey),
        );
        if (converted !== 1) throw Object.assign(new Error('The proforma could not be linked to the completed sale.'), { code: 'POS_PROFORMA_CONVERSION_FAILED' });
      }

      // Stored-value balances are locked and debited inside the sale transaction.
      // This prevents concurrent tills from spending the same balance twice.
      let storedValuePaid = 0;
      for (const tender of appliedPayments.filter((payment) => storedValueMethods.includes(payment.paymentMethod))) {
        const kind = tender.paymentMethod;
        if (req.posV2Completion
          && kind === 'gift_card'
          && v2StoredValuePaymentIds.has(String(tender.posPaymentId || ''))
          && tender.storedValueAccountId) {
          const redemptionRows = await dbClient().$queryRawUnsafe(
            'SELECT l.id, l.amount::text AS amount, l.reference, l.account_id AS "accountId" FROM pos_stored_value_ledger l JOIN pos_stored_value_accounts a ON a.id = l.account_id AND a.company_id = l.company_id AND a.kind = \'gift_card\' JOIN pos_payments p ON p.id = l.pos_payment_id AND p.company_id = l.company_id AND p.sale_id = l.invoice_id AND p.method = \'GIFT_CARD\' AND p.status = \'SUCCESS\' AND p.reference = a.code_suffix WHERE l.company_id = $1 AND l.account_id = $2 AND l.pos_payment_id = $3 AND l.invoice_id = $4 AND l.operation_type = \'REDEEM\'::"PosStoredValueOperation" AND l.kind = \'gift_card\' AND NOT EXISTS (SELECT 1 FROM pos_stored_value_ledger r WHERE r.company_id = l.company_id AND r.account_id = l.account_id AND r.pos_payment_id = l.pos_payment_id AND r.invoice_id = l.invoice_id AND r.operation_type = \'REFUND\'::"PosStoredValueOperation" AND r.kind = \'gift_card\') ORDER BY l.created_at ASC LIMIT 2',
            String(companyId),
            String(tender.storedValueAccountId),
            String(tender.posPaymentId),
            String(invoice._id),
          );
          const redemption = redemptionRows[0];
          if (redemptionRows.length !== 1
            || !redemption
            || !Number.isSafeInteger(Number(redemption.amount))
            || Number(redemption.amount) !== Number(tender.amount)) {
            throw Object.assign(new Error('The saved gift card balance record does not match this payment. Ask a manager to review the sale.'), {
              code: 'POS_GIFT_CARD_REDEMPTION_MISMATCH',
            });
          }
          storedValuePaid += tender.amount;
          tender.reference = String(redemption.reference || tender.reference || '');
          continue;
        }
        let accountRows;
        if (kind === 'loyalty') {
          accountRows = await dbClient().$queryRawUnsafe(
            'SELECT id, balance, currency_code AS "currencyCode", client_id AS "clientId", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND client_id = $2 AND kind = $3 AND is_active = TRUE FOR UPDATE',
            String(companyId), String(client._id), kind,
          );
        } else {
          const codeHash = createHash('sha256').update(String(tender.reference || '').replace(/\s+/g, '').toUpperCase()).digest('hex');
          accountRows = await dbClient().$queryRawUnsafe(
            'SELECT id, balance, currency_code AS "currencyCode", client_id AS "clientId", expires_at AS "expiresAt", code_suffix AS "codeSuffix" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = $3 AND is_active = TRUE FOR UPDATE',
            String(companyId), codeHash, kind,
          );
        }
        const storedAccount = accountRows?.[0];
        if (!storedAccount || storedAccount.expiresAt && new Date(storedAccount.expiresAt) <= new Date()) {
          const error = new Error(`${kind.replace('_', ' ')} account is unavailable or expired.`);
          error.code = 'POS_STORED_VALUE_UNAVAILABLE';
          throw error;
        }
        if (String(storedAccount.currencyCode).toUpperCase() !== String(invoiceCurrency).toUpperCase()) {
          const error = new Error(`${kind.replace('_', ' ')} must use ${invoiceCurrency}; cross-currency redemption is not supported.`);
          error.code = 'POS_STORED_VALUE_CURRENCY_MISMATCH';
          throw error;
        }
        if (storedAccount.clientId && String(storedAccount.clientId) !== String(client._id)) {
          const error = new Error('This store credit belongs to another customer.');
          error.code = 'POS_STORED_VALUE_CUSTOMER_MISMATCH';
          throw error;
        }
        const balance = Number(storedAccount.balance || 0);
        if (tender.amount > balance + 0.00005) {
          const error = new Error(`${kind.replace('_', ' ')} balance is ${balance.toFixed(2)} ${invoiceCurrency}; the tender exceeds the available balance.`);
          error.code = 'POS_STORED_VALUE_INSUFFICIENT';
          throw error;
        }
        const updatedRows = await dbClient().$queryRawUnsafe(
          'UPDATE pos_stored_value_accounts SET balance = balance - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND balance >= $1::numeric RETURNING balance',
          tender.amount, String(storedAccount.id), String(companyId),
        );
        if (!updatedRows.length) {
          const error = new Error(`${kind.replace('_', ' ')} balance changed during checkout. Refresh the balance and retry.`);
          error.code = 'POS_STORED_VALUE_BALANCE_CONFLICT';
          throw error;
        }
        await dbClient().$executeRawUnsafe(
          'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, invoice_id, kind, entry_type, amount, balance_after, reference, created_by_id, created_at) VALUES ($1, $2, $3, $4, $5, \'redeem\', $6, $7, $8, $9, CURRENT_TIMESTAMP)',
          randomBytes(12).toString('hex'), String(companyId), String(storedAccount.id), String(invoice._id), kind,
          tender.amount, Number(updatedRows[0].balance), kind === 'loyalty' ? null : String(storedAccount.codeSuffix || tender.reference.slice(-4)), posCashierId,
        );
        storedValuePaid += tender.amount;
        tender.storedValueAccountId = String(storedAccount.id);
        tender.reference = kind === 'loyalty' ? '' : String(storedAccount.codeSuffix || tender.reference.slice(-4));
      }

      const pointTenders = appliedPayments.filter((payment) => payment.paymentMethod === 'loyalty_points');
      if (pointTenders.length) {
        if (String(invoiceCurrency).toUpperCase() !== 'RWF') {
          throw Object.assign(new Error('Loyalty points can only be redeemed on RWF sales.'), { code: 'POS_LOYALTY_POINTS_CURRENCY_UNSUPPORTED' });
        }
        await dbClient().$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked',
          `${String(companyId)}:loyalty-customer:${String(client._id)}`,
        );
        const settingsRow = await dbClient().systemSettings.findUnique({
          where: { companyId: String(companyId) }, select: { posLoyaltySettings: true },
        });
        const pointValueRwf = Number(settingsRow?.posLoyaltySettings?.pointValueRwf ?? 1);
        if (!Number.isFinite(pointValueRwf) || pointValueRwf < 0.01) {
          throw Object.assign(new Error('The company loyalty point value is not configured correctly.'), { code: 'POS_LOYALTY_POINT_VALUE_INVALID' });
        }
        const totalRows = await dbClient().$queryRawUnsafe(
          `SELECT COALESCE(SUM(l.points), 0)::int AS balance
             FROM pos_customer_loyalty_ledger l
             JOIN clients c ON c.id = l.client_id AND c.company_id = l.company_id
            WHERE l.company_id = $1 AND (c.id = $2 OR c.merged_into_client_id = $2)`,
          String(companyId), String(client._id),
        );
        let pointsBalance = Number(totalRows[0]?.balance || 0);
        for (const [pointIndex, tender] of pointTenders.entries()) {
          const points = Math.round(Number(tender.amount) / pointValueRwf);
          if (!Number.isSafeInteger(points) || points <= 0 || Math.abs(points * pointValueRwf - Number(tender.amount)) > 0.005) {
            throw Object.assign(new Error(`The tender amount must be an exact multiple of RWF ${pointValueRwf.toFixed(2)} per point.`), { code: 'POS_LOYALTY_POINTS_AMOUNT_INVALID' });
          }
          if (points > pointsBalance) {
            throw Object.assign(new Error(`The customer has ${pointsBalance} loyalty points available.`), { code: 'POS_LOYALTY_POINTS_INSUFFICIENT' });
          }
          pointsBalance -= points;
          const idempotencyKey = `pos-sale:${String(invoice._id)}:loyalty-points:${pointIndex}`;
          const reason = `POS checkout redemption at RWF ${pointValueRwf.toFixed(2)} per point`;
          const requestHash = createHash('sha256').update(JSON.stringify({
            companyId: String(companyId), customerId: String(client._id), invoiceId: String(invoice._id),
            points: -points, pointValueRwf,
          })).digest('hex');
          await dbClient().$executeRawUnsafe(
            'INSERT INTO pos_customer_loyalty_ledger (id, company_id, client_id, entry_type, points, balance_after, invoice_id, reason, created_by_id, idempotency_key, request_hash, created_at) VALUES ($1, $2, $3, \'REDEEM\', $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)',
            randomBytes(12).toString('hex'), String(companyId), String(client._id), -points, pointsBalance,
            String(invoice._id), reason, String(posCashierId), idempotencyKey, requestHash,
          );
          await writePosAuditLog({
            companyId: String(companyId), registerId: String(registerId || ''), userId: String(posCashierId),
            event: 'CUSTOMER_LOYALTY_REDEEMED',
            metadata: {
              customerId: String(client._id), invoiceId: String(invoice._id), points,
              pointValueRwf, tenderAmountRwf: Number(tender.amount), balanceAfter: pointsBalance,
            },
            ip: requestIp(req),
          }, dbClient());
          tender.loyaltyPointsRedeemed = points;
          tender.loyaltyPointValueRwf = pointValueRwf;
          storedValuePaid += Number(tender.amount);
        }
      }

      // Loyalty wallet credit is a company-configured monetary reward, separate
      // from points. Existing companies default to the historical 1% rate.
      let loyaltyEarned = 0;
      let loyaltyAccountId = null;
      let loyaltyEarnRatePercent = 1;
      const qualifyingPaidSales = Math.max(0, paidAmount - storedValuePaid);
      if (clientId && clientId !== 'walk-in' && !client.isWalkIn && grandTotal > 0 && qualifyingPaidSales > 0) {
        const loyaltySettingsRow = await dbClient().systemSettings.findUnique({
          where: { companyId: String(companyId) },
          select: { posLoyaltySettings: true },
        });
        const loyaltySettings = loyaltySettingsRow?.posLoyaltySettings || {};
        const walletCreditEnabled = loyaltySettings.walletCreditEnabled !== false;
        loyaltyEarnRatePercent = Number(loyaltySettings.walletCreditEarnRatePercent ?? 1);
        if (walletCreditEnabled && Number.isFinite(loyaltyEarnRatePercent) && loyaltyEarnRatePercent > 0) {
          loyaltyEarned = roundMoney(netSales * Math.min(1, qualifyingPaidSales / grandTotal) * (loyaltyEarnRatePercent / 100));
        }
        if (loyaltyEarned > 0) {
          const walletRows = await dbClient().$queryRawUnsafe(
            'INSERT INTO pos_stored_value_accounts (id, company_id, client_id, kind, currency_code, balance, is_active, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, \'loyalty\', $4, $5, TRUE, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (company_id, client_id, kind, currency_code) DO UPDATE SET balance = pos_stored_value_accounts.balance + EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP RETURNING id, balance',
            randomBytes(12).toString('hex'), String(companyId), String(client._id), String(invoiceCurrency).toUpperCase(), loyaltyEarned, posCashierId,
          );
          const wallet = walletRows[0];
          loyaltyAccountId = String(wallet.id);
          await dbClient().$executeRawUnsafe(
            'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, invoice_id, kind, entry_type, amount, balance_after, reference, notes, created_by_id, created_at) VALUES ($1, $2, $3, $4, \'loyalty\', \'earn\', $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)',
            randomBytes(12).toString('hex'), String(companyId), loyaltyAccountId, String(invoice._id), loyaltyEarned, Number(wallet.balance), String(invoice.referenceNo), `${loyaltyEarnRatePercent}% of paid discounted pre-tax POS sales`, posCashierId,
          );
        }
      }
      if (promotion) {
        await dbClient().$executeRawUnsafe(
          'UPDATE invoices SET pos_promotion = $1::jsonb WHERE id = $2 AND company_id = $3',
          JSON.stringify({
            id: promotion.id,
            name: promotion.name,
            code: promotion.code,
            discountType: promotion.discountType,
            value: Number(promotion.value),
            discountAmount: totalDiscount,
            appliedAt: new Date().toISOString(),
          }),
          String(invoice._id), String(companyId),
        );
      }
      const linkedInvoice = await dbClient().$executeRawUnsafe(
        'UPDATE invoices SET till_session_id = $1, register_id = $2, shift_id = $5, cashier_id = $6 WHERE id = $3 AND company_id = $4',
        String(activeTill._id),
        String(isV2Pending || req.posV2Completion ? claimedRegister.id : activeTill.registerId || ''),
        String(invoice._id),
        String(companyId),
        String(activePosShift.id),
        posCashierId,
      );
      if (linkedInvoice !== 1) {
        const error = new Error('Could not link the POS sale to its cashier shift. The sale was not completed.');
        error.code = 'POS_TILL_LINK_FAILED';
        throw error;
      }

      if (isV2Pending) {
        if (String(claimedRegister.systemTillType || '').toLowerCase() === 'pharmacy') {
          await reservePharmacyPendingSale(postingClient, {
            companyId: String(companyId),
            invoiceId: String(invoice._id),
            registerId: String(claimedRegister.id),
            stockUpdates,
          });
        }
        const finalized = await dbClient().$executeRawUnsafe(
          'UPDATE pos_sale_requests SET invoice_id = $3, status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND request_key = $2 AND payload_hash = $4',
          String(companyId), requestKey, String(invoice._id), payloadHash,
        );
        if (finalized !== 1) {
          throw Object.assign(new Error('The pending POS sale could not be finalized.'), {
            code: 'POS_IDEMPOTENCY_FINALIZE_FAILED',
          });
        }
        createdPending = true;
        await writePosAuditLog({
          companyId,
          registerId: String(claimedRegister.id),
          userId: posCashierId,
          event: 'POS_SALE_PAYMENT_PENDING',
          metadata: {
            invoiceId: String(invoice._id),
            invoiceNumber: String(invoice.invoiceNumber || invoice.referenceNo || ''),
            amountDue: Number(invoice.totalAmount || invoice.grandTotal || 0),
            paymentFlow: 'PAYMENTS_V2',
            shiftId: String(activePosShift.id),
          },
          ip: requestIp(req),
        }, postingClient);
        return;
      }

      // 2. Deduct stock using proper inventory service (WAC/FIFO)
      const stockMovementCreates = [];
      const productUpdates = [];

      for (const stockUpdate of stockUpdates) {
        const { product, quantity, warehouseId: selectedWarehouseId, lineData } = stockUpdate;
        const stockLevel = stockLevelByProduct.get(String(product._id));
        const reserved = Number(stockLevel?.qty_reserved || 0);
        const quarantined = quarantinedByProduct.get(String(product._id)) || 0;
        const pharmacyReservationLine = pharmacyStockReservation?.lines.find((line) => (
          Number(line.lineOrder) === Number(lineData.lineOrder)
          && String(line.productId) === String(product._id)
          && String(line.warehouseId) === String(selectedWarehouseId)
        ));
        if (pharmacyStockReservation && (!pharmacyReservationLine
          || Math.abs(Number(pharmacyReservationLine.quantity) - Number(quantity)) > 0.0000001)) {
          throw Object.assign(new Error(`The Pharmacy stock reservation no longer matches ${product.name}.`), {
            code: 'POS_PHARMACY_RESERVATION_LINES_CHANGED',
          });
        }
        let actualAvailableStock = stockLevel
          ? Math.max(0, Number(stockLevel.qty_on_hand || 0) - reserved - quarantined)
          : 0;
        if (pharmacyStockReservation) {
          const stockLevelUpdate = await postingClient.$executeRawUnsafe(
            `UPDATE stock_levels
                SET qty_on_hand = qty_on_hand - $1::numeric,
                    qty_reserved = qty_reserved - $1::numeric,
                    last_movement_at = CURRENT_TIMESTAMP,
                    last_movement_type = 'dispatch',
                    updated_at = CURRENT_TIMESTAMP
              WHERE company_id = $2 AND product_id = $3 AND warehouse_id = $4
                AND qty_on_hand >= $1::numeric AND qty_reserved >= $1::numeric`,
            quantity,
            String(companyId),
            String(product._id),
            String(selectedWarehouseId),
          );
          if (stockLevelUpdate !== 1) {
            throw Object.assign(new Error(`Reserved Pharmacy stock changed before payment completion for ${product.name}.`), {
              code: 'POS_PHARMACY_RESERVATION_STOCK_CHANGED',
            });
          }
        } else if (offlineContext || (allowNegativeStock && stockUpdate.trackingType === 'none')) {
          const stockRows = await dbClient().$queryRawUnsafe(
            `INSERT INTO stock_levels (id, company_id, product_id, warehouse_id, qty_on_hand, qty_reserved, qty_on_order, avg_cost, total_value, last_movement_at, last_movement_type, created_at, updated_at) VALUES ($1, $2, $3, $4, -$5::numeric, 0, 0, $6::numeric, 0, CURRENT_TIMESTAMP, 'dispatch', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (company_id, product_id, warehouse_id) DO UPDATE SET qty_on_hand = stock_levels.qty_on_hand - $5::numeric, last_movement_at = CURRENT_TIMESTAMP, last_movement_type = 'dispatch', updated_at = CURRENT_TIMESTAMP RETURNING (qty_on_hand + $5::numeric) AS "previousStock", qty_on_hand AS "newStock", qty_reserved AS "reservedStock"`,
            randomBytes(12).toString('hex'), String(companyId), String(product._id), String(selectedWarehouseId),
            quantity, Number(product.averageCost) || 0,
          );
          const stockRow = stockRows[0];
          actualAvailableStock = Math.max(0, Number(stockRow.previousStock) - Number(stockRow.reservedStock) - quarantined);
          const shortage = Math.max(0, quantity - actualAvailableStock);
          if (shortage > 0 && offlineContext) {
            offlineConflicts.push({
              conflictType: 'stock',
              productId: String(product._id),
              productName: product.name,
              warehouseId: String(selectedWarehouseId),
              details: { quantity, available: actualAvailableStock, shortage },
            });
          }
        } else {
          const stockLevelUpdate = await StockLevel.updateMany(
            {
              company_id: companyId,
              product_id: product._id,
              warehouse_id: selectedWarehouseId,
              qty_reserved: reserved,
              qty_on_hand: { $gte: quantity + reserved },
            },
            {
              $inc: { qty_on_hand: -quantity },
              $set: { last_movement_at: new Date(), last_movement_type: 'dispatch' },
            },
          );
          if (!stockLevelUpdate.matchedCount) {
            const error = new Error(`Insufficient stock at the selected warehouse for ${product.name}`);
            error.code = 'WAREHOUSE_STOCK_CHANGED';
            error.productName = product.name;
            throw error;
          }
        }
        const trackingType = stockUpdate.trackingType || product.trackingType || 'none';
        let unitCost = 0;
        let cogsAmount = 0;

        let batchAllocations = [];
        if (trackingType === 'none') {
          if (offlineContext || allowNegativeStock) {
            const consumeResult = await inventoryService.consumeAvailable(
              companyId, product._id, quantity, { method: 'fifo', warehouse: selectedWarehouseId, session },
            );
            const fallbackUnitCost = Number(product.averageCost) || 0;
            cogsAmount = consumeResult.totalCost + consumeResult.shortfall * fallbackUnitCost;
            unitCost = quantity > 0 ? cogsAmount / quantity : fallbackUnitCost;
          } else try {
            const consumeResult = await inventoryService.consume(
              companyId,
              product._id,
              quantity,
              { method: 'fifo', warehouse: selectedWarehouseId, session }
            );

            if (consumeResult.allocations && consumeResult.allocations.length > 0) {
              const totalQty = consumeResult.allocations.reduce((sum, a) => sum + a.qty, 0);
              const totalCost = consumeResult.allocations.reduce((sum, a) => sum + (a.amount || a.qty * a.unitCost), 0);
              unitCost = totalQty > 0 ? totalCost / totalQty : (product.averageCost || 0);
            } else {
              unitCost = product.averageCost || 0;
            }
            cogsAmount = consumeResult.totalCost || (unitCost * quantity);
          } catch (consumeErr) {
            if (consumeErr && consumeErr.code === 'INSUFFICIENT_STOCK') {
              consumeErr.productName = product.name;
              throw consumeErr;
            }
            unitCost = product.averageCost || 0;
            cogsAmount = unitCost * quantity;
          }
        } else if (trackingType === 'batch') {
          const batchConsumption = pharmacyReservationLine
            ? await consumeReservedPharmacyBatches(postingClient, {
              companyId: String(companyId),
              productId: String(product._id),
              warehouseId: String(selectedWarehouseId),
              reservationLine: pharmacyReservationLine,
              session,
            })
            : offlineContext
            ? await consumeOfflineTrackedBatches(
              companyId,
              product._id,
              selectedWarehouseId,
              lineData.batchAllocations,
              lineData.batchSnapshot || offlineContext.snapshotData.products[String(product._id)]?.batches || [],
              offlineContext.saleCreatedAt,
              session,
            )
            : await consumeTrackedBatches(
              companyId, product._id, selectedWarehouseId, quantity, session,
            );
          batchAllocations = batchConsumption.allocations;
          unitCost = quantity > 0 ? batchConsumption.totalCost / quantity : 0;
          cogsAmount = batchConsumption.totalCost;
          if (offlineContext && batchConsumption.shortfall > 0) {
            const snapshotBatchById = new Map(
              (lineData.batchSnapshot || offlineContext.snapshotData.products[String(product._id)]?.batches || [])
                .map((batch) => [String(batch.id), batch]),
            );
            offlineConflicts.push({
              conflictType: 'batch',
              productId: String(product._id),
              productName: product.name,
              warehouseId: String(selectedWarehouseId),
              details: {
                quantity,
                available: quantity - batchConsumption.shortfall,
                shortage: batchConsumption.shortfall,
                reconstructedLegacyBatchAllocation: Boolean(lineData.reconstructedLegacyBatchAllocation),
                requestedBatchAllocations: lineData.batchAllocations.map((allocation) => {
                  const snapshotBatch = snapshotBatchById.get(String(allocation.batchId));
                  return {
                    batchId: String(allocation.batchId),
                    batchNo: String(snapshotBatch?.batchNo || ''),
                    quantity: Number(allocation.quantity),
                  };
                }),
                unavailableBatches: batchConsumption.unavailableBatches,
              },
            });
          }
          await inventoryService.reduceLayers(companyId, product._id, quantity, {
            session,
            warehouse: selectedWarehouseId,
          });
        } else if (trackingType === 'serial') {
          unitCost = offlineContext
            ? Number(offlineContext.snapshotData.products[String(product._id)]?.averageCost) || 0
            : (product.averageCost ? Number(product.averageCost.toString()) : 0);
          cogsAmount = unitCost * quantity;
          const serialNumbers = lineData.serialNumbers || [];
          const serialQuery = {
            company: companyId,
            product: product._id,
            warehouse: selectedWarehouseId,
            serialNo: { $in: serialNumbers },
            status: { $in: ['in_stock', 'returned'] },
          };
          const availableAtCommit = offlineContext && serialNumbers.length
            ? await StockSerialNumber.find(serialQuery).select('serialNo').session(session).lean()
            : null;
          if (offlineContext && availableAtCommit.length !== serialNumbers.length) {
            const found = new Set(availableAtCommit.map((serial) => String(serial.serialNo).toUpperCase()));
            offlineConflicts.push({
              conflictType: 'serial',
              productId: String(product._id),
              productName: product.name,
              warehouseId: String(selectedWarehouseId),
              details: {
                quantity,
                requestedSerialNumbers: serialNumbers,
                unavailableSerialNumbers: serialNumbers.filter((serial) => !found.has(serial)),
              },
            });
          } else {
            const serialUpdate = await StockSerialNumber.updateMany(
              serialQuery,
              { $set: { status: 'dispatched', dispatchedVia: invoice._id } },
              { session },
            );
            if (serialUpdate.modifiedCount !== serialNumbers.length) {
              const error = new Error(`One or more serial numbers for ${product.name} are no longer available`);
              error.code = 'POS_SERIAL_UNAVAILABLE';
              throw error;
            }
          }
        }

        const invoiceLine = storedLinesForPosting[stockUpdate.lineData.lineOrder];
        if (!invoiceLine || String(invoiceLine.productId || invoiceLine.product || '') !== String(product._id)) {
          throw new Error(`Could not match the saved invoice line for ${product.name} while recording its cost.`);
        }
        invoiceLine.unitCost = unitCost;
        invoiceLine.cogsAmount = cogsAmount;
        const invoiceLineCostUpdate = await dbClient().invoiceLine.updateMany({
          where: {
            invoiceId: String(invoice._id),
            companyId: String(companyId),
            lineOrder: stockUpdate.lineData.lineOrder,
            productId: String(product._id),
          },
          data: { unitCost, cogsAmount },
        });
        if (invoiceLineCostUpdate.count !== 1) {
          throw new Error(`Could not save the inventory cost for ${product.name} on invoice ${invoice.referenceNo}.`);
        }

        totalCOGS += cogsAmount;
        if (offlineContext || (allowNegativeStock && trackingType === 'none')) {
          await dbClient().$executeRawUnsafe(
            'UPDATE stock_levels SET total_value = total_value - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND product_id = $3 AND warehouse_id = $4',
            cogsAmount, String(companyId), String(product._id), String(selectedWarehouseId),
          );
        }

        const stockBefore = Number(product.currentStock) || 0;
        productUpdates.push({
          updateOne: {
            filter: { _id: product._id, company: companyId },
            update: { $inc: { currentStock: -quantity }, lastSaleDate: new Date() },
          },
        });

        stockMovementCreates.push({
          company: companyId,
          product: product._id,
          warehouse: selectedWarehouseId,
          type: 'out',
          reason: 'sale',
          quantity,
          previousStock: stockBefore,
          newStock: stockBefore - quantity,
          unitCost,
          totalCost: cogsAmount,
          referenceType: 'invoice',
          referenceDocument: invoice._id,
          referenceModel: 'Invoice',
          referenceNumber: invoice.referenceNo,
          batchNumber: batchAllocations.map((allocation) => `${allocation.batchNo}:${allocation.quantity}`).join(', ') || undefined,
          serialNumbers: offlineConflicts.some((conflict) => conflict.conflictType === 'serial'
            && conflict.productId === String(product._id)) ? [] : (lineData.serialNumbers || []),
          notes: `Direct sale - Invoice ${invoice.referenceNo}${lineData.reconstructedLegacyBatchAllocation
            ? ' (legacy offline batch allocation reconstructed at sync)'
            : ''}${offlineConflicts.some((conflict) => conflict.conflictType === 'serial'
              && conflict.productId === String(product._id)) ? ' (serial assignment pending manager resolution)' : ''}`,
          performedBy: posCashierId,
          movementDate: new Date(),
        });
      }

      // Batch update products and stock movements
      if (productUpdates.length > 0) {
        await Product.bulkWrite(productUpdates, { session });
      }
      if (stockMovementCreates.length > 0) {
        await StockMovement.insertMany(stockMovementCreates, { session });
      }
      if (pharmacyStockReservation) {
        await markPharmacyPendingSaleReservationConsumed(
          postingClient,
          String(companyId),
          String(invoice._id),
        );
      }
      const restaurantManagedLines = Array.isArray(req.posRestaurantCheckout?.lines)
        ? req.posRestaurantCheckout.lines.filter((line) => (
          line.stockMode === 'recipe' || Boolean(line.barStockProductId)
        ))
        : [];
      if (restaurantManagedLines.length) {
        const orderItemIds = restaurantManagedLines.map((line) => String(line.itemId || ''));
        if (orderItemIds.some((id) => !isObjectIdString(id))) {
          throw Object.assign(new Error('The Restaurant checkout is missing valid order item references for stock costing.'), {
            code: 'RESTAURANT_STOCK_COST_REFERENCE_INVALID',
          });
        }
        const commitments = await postingClient.restaurantStockCommitment.findMany({
          where: {
            companyId: String(companyId),
            orderItemId: { in: orderItemIds },
            status: 'committed',
          },
          select: { orderItemId: true, totalCost: true },
        });
        const costsByItemId = new Map();
        for (const commitment of commitments) {
          costsByItemId.set(
            commitment.orderItemId,
            (costsByItemId.get(commitment.orderItemId) || 0) + Number(commitment.totalCost || 0),
          );
        }
        for (const restaurantLine of restaurantManagedLines) {
          const itemId = String(restaurantLine.itemId);
          if (!costsByItemId.has(itemId)) {
            throw Object.assign(new Error('Restaurant recipe or bar stock costs are missing. Review stock commitments before completing payment.'), {
              code: 'RESTAURANT_STOCK_COST_MISSING',
            });
          }
          const lineOrder = req.posRestaurantCheckout.lines.indexOf(restaurantLine);
          const invoiceLine = storedLinesForPosting[lineOrder];
          if (!invoiceLine || String(invoiceLine.productId || invoiceLine.product || '') !== String(restaurantLine.productId)) {
            throw Object.assign(new Error('The Restaurant invoice line could not be matched to its stock commitment.'), {
              code: 'RESTAURANT_STOCK_COST_LINE_MISMATCH',
            });
          }
          const quantity = Number(restaurantLine.quantity);
          const cogsAmount = Number(costsByItemId.get(itemId).toFixed(2));
          if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(cogsAmount) || cogsAmount < 0) {
            throw Object.assign(new Error('The saved Restaurant stock cost is invalid.'), {
              code: 'RESTAURANT_STOCK_COST_INVALID',
            });
          }
          const unitCost = Number((cogsAmount / quantity).toFixed(6));
          invoiceLine.unitCost = unitCost;
          invoiceLine.cogsAmount = cogsAmount;
          const costUpdate = await postingClient.invoiceLine.updateMany({
            where: {
              invoiceId: String(invoice._id),
              companyId: String(companyId),
              lineOrder,
              productId: String(restaurantLine.productId),
            },
            data: { unitCost, cogsAmount },
          });
          if (costUpdate.count !== 1) {
            throw Object.assign(new Error('The Restaurant stock cost could not be saved to its invoice line.'), {
              code: 'RESTAURANT_STOCK_COST_SAVE_FAILED',
            });
          }
          totalCOGS += cogsAmount;
        }
      }
      if (offlineContext) {
        await dbClient().$executeRawUnsafe(
          'INSERT INTO pos_offline_sales (id, company_id, snapshot_id, offline_sale_id, request_key, cashier_id, device_id, register_id, warehouse_id, invoice_id, total, payload_hash, fiscal_mode, entitlement_version, reported_sale_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13, $14, $15::timestamptz)',
          randomBytes(12).toString('hex'), String(companyId), offlineContext.snapshotId,
          offlineContext.offlineSaleId, requestKey || offlineContext.operationId, String(req.user.id), String(req.body.deviceId),
          String(requestedRegisterId), String(warehouseId), String(invoice._id), grandTotal,
          payloadHash, offlineContext.fiscalMode, offlineContext.entitlementVersion,
          offlineContext.saleCreatedAt,
        );
        const escalationAt = new Date(
          offlineContext.saleCreatedAt.getTime()
          + Math.max(1, Number(offlineContext.snapshotData.escalationDays) || 3) * 24 * 60 * 60 * 1000,
        );
        for (const conflict of offlineConflicts) {
          await dbClient().$executeRawUnsafe(
            'INSERT INTO pos_offline_conflicts (id, company_id, offline_sale_id, invoice_id, product_id, warehouse_id, conflict_type, details, escalation_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)',
            randomBytes(12).toString('hex'), String(companyId), offlineContext.offlineSaleId,
            String(invoice._id), conflict.productId, conflict.warehouseId, conflict.conflictType,
            JSON.stringify({ productName: conflict.productName, ...conflict.details }), escalationAt,
          );
        }
      }

      const buildContext = {
        companyId: String(companyId),
        userId: String(req.user.id),
        invoice: {
          id: String(invoice._id),
          referenceNo: invoice.referenceNo,
          invoiceDate: invoice.invoiceDate,
          ebm: invoice.ebm,
        },
        register: {
          id: String(claimedRegister.id || claimedRegister._id),
          systemTillType: claimedRegister.systemTillType,
        },
        tenders: appliedPayments,
        lines: storedLinesForPosting,
        totalAmount: grandTotal,
        subtotal,
        totalDiscount,
        taxAmount: totalTax,
        amountPaid,
        amountOutstanding,
        cogsAmount: totalCOGS,
        loyaltyEarned,
        paymentFlow: req.posV2Completion ? 'PAYMENTS_V2' : 'LEGACY',
      };
      let postingBuild;
      let posting;
      try {
        postingBuild = await buildPosSaleJournalEntries(buildContext);
      } catch (error) {
        if (!error?.accountingPostingFailure) throw error;
        posting = await posAccountingPostingService.enqueueSaleBuildRetry({
          tx: postingClient,
          companyId,
          userId: req.user.id,
          sourceId: String(invoice._id),
          buildContext,
          error,
        });
        postingBuild = { journalEntries: [], salesAccount: null, taxAccount: null };
      }
      const { journalEntries, salesAccount, taxAccount: vatAccount } = postingBuild;
      for (const line of journalEntries.flatMap((entry) => entry.lines)) {
        financialAccountCodes.add(line.accountCode);
      }

      if (!posting) {
        posting = await posAccountingPostingService.postOrQueue({
          tx: postingClient,
          companyId,
          userId: req.user.id,
          sourceType: 'pos_sale',
          sourceId: String(invoice._id),
          entries: journalEntries,
          metadata: {
            chequesInHandAccountCode: postingBuild.accounts?.chequesInHand || null,
          },
        });
      }
      const createdEntries = posting.entries || [];
      invoice.revenueJournalEntry = createdEntries[0]?._id || createdEntries[0]?.id || null;
      invoice.cogsJournalEntry = req.posV2Completion
        ? null
        : createdEntries[1]?._id || createdEntries[1]?.id || null;
      invoice.posPostingStatus = posting.status;
      await invoice.save({ session });
      await postingClient.$executeRawUnsafe(
        `UPDATE pos_stored_value_ledger
         SET posting_status = $1,
             journal_entry_id = COALESCE($2, journal_entry_id)
         WHERE company_id = $3 AND invoice_id = $4 AND entry_type IN ('redeem', 'earn')`,
        posting.status,
        invoice.revenueJournalEntry,
        String(companyId),
        String(invoice._id),
      );

      for (const [tenderIndex, tender] of appliedPayments.entries()) {
        if (tender.paymentMethod !== 'cheque') continue;
        await postingClient.posCheque.create({
          data: {
            id: randomBytes(12).toString('hex'),
            companyId: String(companyId),
            invoiceId: String(invoice._id),
            paymentId: tender.posPaymentId ? String(tender.posPaymentId) : null,
            tenderIndex,
            reference: String(tender.reference || ''),
            amount: tender.amount,
            status: 'in_hand',
            chequesInHandAccountCode: postingBuild.accounts?.chequesInHand || null,
            salePostingStatus: posting.status,
            saleJournalEntryId: invoice.revenueJournalEntry || null,
          },
        });
      }

      // 4. Add payment record if provided
      if (appliedPayments.length > 0) {
        const firstCashPayment = appliedPayments.findIndex((tender) => tender.paymentMethod === 'cash');
        const savedPayments = appliedPayments.map((tender, index) => ({
          amount: tender.amount,
          paymentMethod: tender.paymentMethod,
          reference: tender.reference || '',
          ...(tender.provider ? { provider: tender.provider } : {}),
          ...(tender.providerName ? { providerName: tender.providerName } : {}),
          bankAccountId: tender.bankAccountId || null,
          ...(tender.storedValueAccountId ? { storedValueAccountId: tender.storedValueAccountId } : {}),
          ...(tender.loyaltyPointsRedeemed ? { loyaltyPointsRedeemed: tender.loyaltyPointsRedeemed, loyaltyPointValueRwf: tender.loyaltyPointValueRwf } : {}),
          ...(changeDue > 0 && tender.paymentMethod === 'cash' && index === firstCashPayment
            ? { receivedAmount: cashTendered, changeGiven: changeDue }
            : {}),
          paidDate: new Date(),
          recordedBy: posCashierId,
        }));
        // Preserve change details even when non-cash tenders cover the invoice
        // and the cash portion is returned completely as change.
        if (changeDue > 0 && firstCashPayment < 0) {
          const cashTender = normalizedPayments.find((tender) => tender.paymentMethod === 'cash');
          savedPayments.push({
            amount: 0,
            paymentMethod: 'cash',
            reference: cashTender?.reference || '',
            bankAccountId: null,
            receivedAmount: cashTendered,
            changeGiven: changeDue,
            paidDate: new Date(),
            recordedBy: posCashierId,
          });
        }
        invoice.payments.push(...savedPayments);
        await invoice.save({ session });

        // Bank transactions are created from the posted journal line by
        // JournalService. Do not create a second, unlinked transaction here.
      }

      const cashPaidAmount = appliedPayments.filter((tender) => tender.paymentMethod === 'cash')
        .reduce((sum, tender) => sum + tender.amount, 0);
      if (cashPaidAmount > 0) {
        const activity = {
          type: 'cash_sale',
          amount: cashPaidAmount,
          invoiceId: String(invoice._id),
          reference: invoice.referenceNo,
          recordedBy: posCashierId,
          recordedAt: new Date().toISOString(),
        };
        const updatedTill = await dbClient().$executeRawUnsafe(
          'UPDATE till_sessions SET expected_cash = expected_cash + $1::numeric, cash_activity = cash_activity || $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE company_id = $3 AND id = $4 AND opened_by = $5 AND status = \'open\'',
          cashPaidAmount, JSON.stringify([activity]), String(companyId), String(activeTill._id), String(activeTill.openedById || activeTill.openedBy),
        );
        if (updatedTill !== 1) {
          const error = new Error('The till closed while this cash sale was being recorded. No sale was completed.');
          error.code = 'POS_TILL_SESSION_CHANGED';
          throw error;
        }
      }

      // The company walk-in customer is protected from all updates by the
      // database. Keep purchase aggregates only for mutable named customers.
      if (!client.isWalkIn) {
        client.totalPurchases = (client.totalPurchases || 0) + grandTotal;
        client.lastPurchaseDate = new Date();
        await client.save({ session });
      }
      if (customerCreditLedgerData) {
        const creditEntryKey = `POSSALE:${String(invoice._id)}`;
        const creditRequestHash = createHash('sha256').update(JSON.stringify({ invoiceId: String(invoice._id), clientId: customerCreditLedgerData.clientId, amount: customerCreditLedgerData.amount })).digest('hex');
        await dbClient().posCustomerCreditLedger.create({
          data: {
            id: randomBytes(12).toString('hex'),
            companyId: String(companyId),
            clientId: customerCreditLedgerData.clientId,
            entryType: 'CHARGE',
            direction: 'increase',
            amount: customerCreditLedgerData.amount,
            balanceAfter: customerCreditLedgerData.clientBalanceAfter,
            invoiceId: String(invoice._id),
            dueDate: invoice.dueDate || null,
            reason: 'POS credit sale',
            createdById: String(req.user.id),
            idempotencyKey: creditEntryKey,
            requestHash: creditRequestHash,
          },
        });
      }
      if (v2CreditLedgerData) {
        await dbClient().arTransactionLedger.create({
          data: {
            id: randomBytes(12).toString('hex'),
            companyId: String(companyId),
            clientId: v2CreditLedgerData.clientId,
            invoiceId: String(invoice._id),
            transactionType: 'invoice_created',
            transactionDate: invoice.invoiceDate || saleConfirmedAt,
            referenceNo: invoice.referenceNo,
            description: `POS credit sale - Invoice ${invoice.referenceNo}`,
            amount: v2CreditLedgerData.amount,
            direction: 'increase',
            invoiceBalanceAfter: v2CreditLedgerData.amount,
            clientBalanceAfter: v2CreditLedgerData.clientBalanceAfter,
            sourceType: 'invoice',
            sourceId: String(invoice._id),
            sourceReference: invoice.referenceNo,
            journalEntryId: createdEntries[0]?._id || createdEntries[0]?.id || null,
            metadata: {
              paymentFlow: 'PAYMENTS_V2',
              paymentIds: req.posV2Completion.creditPaymentIds || [],
            },
            createdById: String(req.user.id),
            fiscalYear: new Date(invoice.invoiceDate || saleConfirmedAt).getFullYear(),
            accountingPeriod: (() => {
              const date = new Date(invoice.invoiceDate || saleConfirmedAt);
              return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            })(),
          },
        });
      }
      if (req.posV2Completion) {
        const finalizedInvoice = await dbClient().$executeRawUnsafe(
          'UPDATE invoices SET pos_completion_key = $1, pos_checkout_payload = NULL WHERE id = $2 AND company_id = $3 AND status IN (\'fully_paid\', \'partially_paid\')',
          req.posV2Completion.completionKey,
          String(invoice._id),
          String(companyId),
        );
        if (finalizedInvoice !== 1) {
          throw Object.assign(new Error('The POS sale completion receipt could not be finalized.'), {
            code: 'POS_IDEMPOTENCY_FINALIZE_FAILED',
          });
        }
      }
      if (requestKey) {
        const finalized = await dbClient().$executeRawUnsafe(
          'UPDATE pos_sale_requests SET invoice_id = $3, status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND request_key = $2 AND payload_hash = $4',
          String(companyId), requestKey, String(invoice._id), payloadHash,
        );
        if (finalized !== 1) {
          const error = new Error('The POS checkout receipt could not be finalized.');
          error.code = 'POS_IDEMPOTENCY_FINALIZE_FAILED';
          throw error;
        }
      }
      if (req.posV2Completion && autoFiscalSubmission && invoice.fiscalMode !== 'none') {
        const txDb = dbClient();
        const registerId = String(claimedRegister.id);
        const shiftId = String(activePosShift.id);
        await require('../services/posEbmTenantGuard').assertPosEbmTenantContext(txDb, {
          companyId,
          invoiceId: invoice._id,
          registerId,
          shiftId,
        });
        const receiptKey = {
          companyId: String(companyId),
          documentType: 'pos',
          documentId: String(invoice._id),
          salesTyCd: 'N',
          rcptTyCd: 'S',
        };
        const existingOutbox = await txDb.ebmSubmissionQueue.findFirst({ where: receiptKey });
        if (existingOutbox) {
          fiscalOutboxId = existingOutbox.id;
          if (existingOutbox.signedAt || existingOutbox.ebmStatus === 'submitted') return;
        } else {
          const outboxId = randomBytes(12).toString('hex');
          let fiscalPayload = null;
          let preparationError = null;
          try {
            const prepared = await FiscalService.prepareV2SaleSubmission(invoice._id, {
              companyId,
              modifierUserId: posCashierId || req.user._id,
              journalLines: createdEntries[0]?.lines || journalEntries[0]?.lines || [],
              salesAccountCode: salesAccount,
              taxAccountCode: vatAccount,
            });
            fiscalPayload = prepared.payload;
          } catch (error) {
            preparationError = error;
          }
          const pending = !!fiscalPayload;
          const payload = fiscalPayload || {};
          const payloadHash = pending
            ? createHash('sha256').update(JSON.stringify(payload)).digest('hex')
            : null;
          const environment = String(fiscalMode || 'sandbox');
          const endpoint = await FiscalService.getSaleSubmissionEndpoint(companyId);
          const createdOutbox = await txDb.ebmSubmissionQueue.create({
            data: {
              id: outboxId,
              ...receiptKey,
              endpoint,
              operationKey: 'default',
              correlationId: `sales:${invoice._id}`,
              environment,
              payload,
              ebmStatus: pending ? 'pending' : 'failed',
              retryCount: 0,
              maxRetries: 5,
              nextRetryAt: pending ? new Date() : null,
              lastAttemptAt: null,
              lastError: preparationError
                ? { code: String(preparationError.code || 'EBM_V2_PAYLOAD_PREPARATION_FAILED'), message: String(preparationError.message || 'Fiscal payload preparation failed.').slice(0, 500) }
                : {},
              attempts: [],
              isRetryable: pending,
              registerId,
              shiftId,
              cashierId: String(posCashierId),
              requestPayloadHash: payloadHash,
            },
          });
          if (!pending) {
            await txDb.ebmAlert.create({ data: {
              id: randomBytes(12).toString('hex'), companyId: String(companyId), queueId: createdOutbox.id,
              documentType: 'pos', documentId: String(invoice._id), endpoint,
              operationKey: 'default', attemptsMade: 0,
              lastErrorMessage: String(preparationError?.message || 'Fiscal payload preparation failed.').slice(0, 1000),
              lastErrorCode: String(preparationError?.code || 'EBM_V2_PAYLOAD_PREPARATION_FAILED'),
              payload: {}, status: 'open',
            } });
            await writePosAuditLog({
              companyId, registerId, userId: posCashierId, event: 'EBM_V2_NEEDS_REVIEW',
              metadata: { submissionId: createdOutbox.id, before: { ebmStatus: null }, after: { ebmStatus: 'failed', code: preparationError?.code || 'EBM_V2_PAYLOAD_PREPARATION_FAILED' } },
            }, txDb);
          }
          fiscalOutboxId = createdOutbox.id;
        }
      }

      // A sale's financial, stock, and tender effects commit with exactly one
      // completion event. Idempotent replays return before opening this path.
      await writePosAuditLog({
        companyId,
        registerId: String(claimedRegister?.id || activeTill?.registerId || ''),
        userId: posCashierId,
        event: 'POS_SALE_COMPLETED',
        metadata: {
          invoiceId: String(invoice._id),
          invoiceNumber: String(invoice.invoiceNumber || invoice.referenceNo || ''),
          total: Number(invoice.totalAmount || invoice.grandTotal || invoice.total || 0),
          paid: Number(invoice.amountPaid || 0),
          outstanding: Number(invoice.amountOutstanding || 0),
          paymentFlow: req.posV2Completion ? 'PAYMENTS_V2' : 'LEGACY',
          shiftId: String(activePosShift?.id || ''),
          fiscalSubmissionId: fiscalOutboxId,
          offline: Boolean(offlineContext),
        },
        ip: requestIp(req),
      }, postingClient);
    }, { maxWait: 10000, timeout: 90000 });

    if (completionReplayed) {
      const completedInvoice = await Invoice.findOne({ _id: req.posV2Completion.invoiceId, company: companyId })
        .populate('client lines.product createdBy');
      return res.json({ success: true, replayed: true, data: completedInvoice });
    }

    if (createdPending) {
      await invoice.populate('client lines.product createdBy');
      return res.status(201).json({
        success: true,
        message: 'Sale saved. Record cash payment to complete the invoice.',
        data: invoice,
        paymentRequired: true,
      });
    }

    // Journal posting used the outer sale transaction, so refresh reporting
    // and bank balance caches only after all records have committed.
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
      await Promise.all([...financialAccountCodes].map((accountCode) =>
        BankAccount.invalidateCacheForLedgerAccount(companyId, accountCode),
      ));
    } catch (cacheError) {
      console.error('[createDirectSale] Failed to invalidate financial caches:', cacheError.message);
    }

    // Populate response
    await invoice.populate('client lines.product createdBy');

    if (autoFiscalSubmission && req.posV2Completion && fiscalOutboxId) {
      // The queue row committed with the sale. Dispatch is only a fast path;
      // database recovery can find the same durable pending row after a crash.
      try {
        await FiscalService.submitInvoiceAsync(invoice._id, {
          companyId,
          modifierUserId: posCashierId || req.user._id,
          outboxId: fiscalOutboxId,
        });
      } catch (fiscalDispatchError) {
        console.error('[createDirectSale] EBM submission dispatch failed after sale commit:', fiscalDispatchError.message);
      }
    } else if (autoFiscalSubmission && !req.posV2Completion) {
      // Fiscal communication must not roll back a completed sale. The service
      // records failures and retryable payloads in the durable EBM queue.
      try {
        await FiscalService.submitInvoiceAsync(invoice._id, { companyId, modifierUserId: posCashierId || req.user._id });
      } catch (fiscalDispatchError) {
        console.error('[createDirectSale] EBM submission dispatch failed after sale commit:', fiscalDispatchError.message);
      }
    }

    // Delivery/alert failures are isolated from the already committed sale.
    await sendDirectSaleEmail(invoice, companyId, { explicit: !!req.body.sendEmail });
    try {
      await notificationDeliveryService.sendLargeOrderAlert(invoice, companyId);
    } catch (alertError) {
      console.error('[Direct Sale Large Order Alert] Failed:', alertError.message || alertError);
    }

    res.status(201).json({
      success: true,
      message: 'Direct sale completed successfully',
      data: invoice,
      changeDue,
      ...(offlineContext ? { offlineConflictCount: offlineConflicts.length } : {}),
    });

  } catch (error) {
    // The database commit and HTTP response are separate events. A socket,
    // response serialization, or post-commit side-effect can fail after the
    // invoice, payment, stock, and idempotency receipt have committed. Resolve
    // that outcome from the durable receipt for every failure, not only unique
    // constraint races, so the cashier sees the committed sale on this attempt.
    if (requestKey && payloadHash) {
      try {
        if (await replayPosSaleIfPresent(req, res, { companyId, requestKey, payloadHash })) return;
      } catch (replayError) {
        console.error('[createDirectSale] Could not resolve checkout receipt after failure:', replayError);
        return next(replayError);
      }
    }
    if (String(error?.code || '').startsWith('PHARMACY_')) {
      return res.status(Number(error.statusCode) || 409).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    if (error?.accountingPostingFailure || error?.code === 'POS_ACCOUNTING_POST_FAILED') {
      if (req.posV2Completion) {
        try {
          const updated = await dbClient().$executeRawUnsafe(
            'UPDATE invoices SET pos_posting_status = $1 WHERE id = $2 AND company_id = $3 AND pos_origin = TRUE AND revenue_journal_entry_id IS NULL',
            'failed', String(req.posV2Completion.invoiceId), String(companyId),
          );
          if (updated !== 1) {
            throw new Error('The failed POS posting status could not be saved for the pending sale.');
          }
        } catch (statusError) {
          console.error('[createDirectSale] Could not persist failed POS posting status:', statusError);
          return next(statusError);
        }
      }
      if (['POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED', 'POS_PAYMENT_ACCOUNT_MAPPING_INVALID'].includes(error?.code)) {
        return res.status(400).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      console.error('[createDirectSale] Accounting posting failed; sale rolled back:', error);
      return res.status(503).json({
        success: false,
        code: 'POS_ACCOUNTING_POST_FAILED',
        message: 'The sale could not be completed because its accounting records were not posted. No sale or stock changes were saved. Please retry or contact an administrator.',
      });
    }
    if (error?.code === 'POS_PAYMENT_ACCOUNT_REQUIRED' || error?.code === 'POS_PAYMENT_ACCOUNT_INVALID') {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    if (['POS_CREDIT_APPROVAL_REQUIRED', 'POS_CREDIT_APPROVAL_INVALID'].includes(error?.code)) {
      try {
        await writePosAuditLog({
          companyId: String(companyId),
          registerId: String(req.posAuthContext?.register?.id || req.body?.registerId || ''),
          userId: String(req.user?.id || ''),
          event: 'APPROVAL_DENIED',
          metadata: {
            action: 'CREDIT_OVER_LIMIT',
            saleId: String(req.posV2Completion?.invoiceId || ''),
            reason: error.code,
          },
          ip: requestIp(req),
        }, dbClient());
      } catch (auditError) {
        return next(auditError);
      }
    }
    if (['POS_WALKIN_CREDIT_NOT_ALLOWED', 'POS_CREDIT_LIMIT_EXCEEDED', 'POS_CLIENT_NOT_FOUND'].includes(error?.code)) {
      return res.status(error.code === 'POS_CLIENT_NOT_FOUND' ? 404 : 409).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    if ([
      'POS_CREDIT_CUSTOMER_REQUIRED',
      'POS_CUSTOMER_OVERDUE',
      'POS_CREDIT_ALLOCATION_MISMATCH',
      'POS_CREDIT_APPROVAL_INVALID',
      'POS_GIFT_CARD_REDEMPTION_MISMATCH',
    ].includes(error?.code)) {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    if (error?.code === 'POS_CREDIT_APPROVAL_REQUIRED') {
      return res.status(403).json({
        success: false,
        code: error.code,
        message: error.message,
        approvalContext: error.approvalContext,
      });
    }
    if (error?.code === 'POS_ZERO_VALUE_SALE') {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    if (String(error?.code || '').startsWith('POS_VOUCHER_')) {
      const status = error.code === 'POS_VOUCHER_LOOKUP_LOCKED'
        ? 429
        : ['POS_VOUCHER_INVALID', 'POS_VOUCHER_SETTINGS_INVALID', 'POS_VOUCHER_RESERVATION_INVALID'].includes(error.code)
          ? 400
          : error.code.endsWith('_NOT_FOUND')
            ? 404
            : 409;
      return res.status(status).json({ success: false, code: error.code, message: error.message });
    }
    if ([
      'POS_SHIFT_REQUIRED',
      'POS_TILL_SHIFT_LINK_MISSING',
      'POS_PENDING_SALE_NOT_FOUND',
      'POS_PENDING_SALE_TOTAL_CHANGED',
      'POS_PENDING_SALE_LINES_CHANGED',
      'POS_SALE_NOT_PENDING',
      'POS_IDEMPOTENCY_FINALIZE_FAILED',
    ].includes(error?.code)) {
      return res.status(409).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === 'PERIOD_CLOSED') {
      return res.status(409).json({ success: false, code: error.code, message: error.message });
    }
    if (error && error.code === 'WAREHOUSE_STOCK_CHANGED') {
      return res.status(409).json({
        success: false,
        code: 'ERR_INSUFFICIENT_STOCK',
        message: `Stock at the selected warehouse changed while this sale was being processed${error.productName ? ` for ${error.productName}` : ''}. Refresh the POS and try again.`,
      });
    }
    if (error && error.code === 'INSUFFICIENT_STOCK') {
      // The on-hand check already passed, so this is a costing gap: the product
      // has stock but no purchase/opening-stock cost layers covering it.
      const product = error.productName ? ` for ${error.productName}` : '';
      const costed = error.costedQty != null && error.requested != null
        ? ` Only ${error.costedQty} of ${error.requested} units have a recorded cost.`
        : '';
      return res.status(409).json({
        success: false,
        code: 'ERR_INSUFFICIENT_STOCK',
        message: `Cannot cost the sale${product}.${costed} Record opening stock or a purchase for it, then retry.`
      });
    }
    next(error);
  }
};

exports.getCheckoutPaymentFlow = async (req, res, next) => {
  try {
    const posContext = req.posAuthContext;
    const companyId = String(posContext?.company?.id || '');
    const register = posContext?.register;
    if (!companyId || !register?.id) throw registerClaimRequiredError();

    const settings = await posPaymentService.getPaymentSettings(companyId);
    const cashierId = String(posContext.session?.userId || '');
    const [discountSettingsRow, roleAssignments] = await Promise.all([
      dbClient().systemSettings.findUnique({
        where: { companyId },
        select: { posDiscountSettings: true },
      }),
      cashierId
        ? dbClient().userRole.findMany({
          where: { userId: cashierId, role: { is: { OR: [{ companyId }, { companyId: null }] } } },
          select: { roleId: true },
        })
        : [],
    ]);
    const discountSettings = normalizeStoredDiscountSettings(
      discountSettingsRow?.posDiscountSettings || DEFAULT_DISCOUNT_SETTINGS,
    );
    const tillFeatures = getTillTypeFeatures(discountSettings, register.systemTillType);
    return res.json({
      success: true,
      data: {
        registerId: String(register.id),
        paymentFlow: posPaymentService.resolvePaymentFlow(settings, String(register.id)),
        methods: posPaymentService.resolveEnabledMethods(
          settings,
          String(register.id),
          String(register.systemTillType || 'retail'),
        )
          .filter((method) => method !== 'CREDIT' || tillFeatures.customerCredit),
        effectivePaymentMethods: posPaymentService.getEffectiveMethodRegistry(settings, {
          registerId: String(register.id),
          tillType: String(register.systemTillType || 'retail'),
        }).methods,
        manualMobileMoneyMode: settings.manualMobileMoneyMode,
        manualMobileMoneyReceivers: settings.manualMobileMoneyReceivers,
        discountLimits: getApplicableDiscountLimits(
          discountSettings,
          roleAssignments.map((assignment) => assignment.roleId),
          register.discountLabel || null,
        ),
        discountReasons: discountSettings.discountReasons,
        features: tillFeatures,
        registerDiscountLabel: register.discountLabel || null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Get products for POS with stock availability
 * @route   GET /api/sales-legacy/products
 * @access  Private
 */
exports.getPosProducts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { search, warehouseId, category, limit = 50, cursor: rawCursor } = req.query;
    if (warehouseId) {
      const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: { $ne: false } });
      if (!warehouse) {
        return res.status(404).json({ success: false, message: 'Warehouse not found' });
      }
    }
    const resultLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    let cursor = null;
    if (rawCursor) {
      try {
        if (String(rawCursor).length > 2048) throw new Error('Cursor too long');
        cursor = JSON.parse(Buffer.from(String(rawCursor), 'base64url').toString('utf8'));
        if (!cursor || typeof cursor.name !== 'string' || cursor.name.length > 1000
          || !isObjectIdString(cursor.id)) throw new Error('Invalid cursor shape');
      } catch {
        return res.status(400).json({ success: false, code: 'INVALID_CURSOR', message: 'The product page cursor is invalid.' });
      }
    }
    const toNumber = (value) => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'object' && value.$numberDecimal) return Number(value.$numberDecimal) || 0;
      if (typeof value.toString === 'function') return Number(value.toString()) || 0;
      return Number(value) || 0;
    };

    const filters = [{ company: companyId, isActive: true }];
    
    if (search && String(search).trim()) {
      const term = escapeRegex(String(search).trim());
      const alternateBarcodeMatches = await dbClient().product.findMany({
        where: {
          companyId: String(companyId),
          isActive: true,
          alternateBarcodes: { has: String(search).trim().toUpperCase() },
        },
        select: { id: true },
        take: 100,
      });
      // Prefix predicates keep the B-tree/trigram indexes usable for the hot
      // POS lookup. Barcode and SKU also get exact-match clauses so scans and
      // scanner input resolve without a leading-wildcard substring query.
      const searchTerms = [
        { barcode: { $regex: `^${term}$`, $options: 'i' } },
        { sku: { $regex: `^${term}$`, $options: 'i' } },
        { barcode: { $regex: `^${term}`, $options: 'i' } },
        { sku: { $regex: `^${term}`, $options: 'i' } },
        { name: { $regex: `^${term}`, $options: 'i' } },
      ];
      if (alternateBarcodeMatches.length) {
        searchTerms.push({ _id: { $in: alternateBarcodeMatches.map((product) => product.id) } });
      }
      if (isObjectIdString(search)) searchTerms.push({ _id: String(search).trim() });
      filters.push({ $or: searchTerms });
    }
    if (category) filters.push({ category });
    if (String(req.query.pharmacyOnly || '').toLowerCase() === 'true') {
      filters.push({
        'customFields.pharmacy.prescriptionStatus': { $in: ['OTC', 'PRESCRIPTION', 'RESTRICTED'] },
      });
    }
    if (cursor) {
      filters.push({
        $or: [
          { name: { $gt: cursor.name } },
          { name: cursor.name, _id: { $gt: cursor.id } },
        ],
      });
    }
    const query = filters.length === 1 ? filters[0] : { $and: filters };

    // Keyset pagination uses the indexed sort key and a single look-ahead row.
    // It avoids a full matching-row count and work proportional to page depth.
    const fetchedProducts = await Product.find(query)
      .select('name sku sellingPrice unit taxRate taxCode currentStock averageCost barcode alternateBarcodes imageUrl imageUrls category isNoDiscount isStockable trackingType trackSerialNumbers trackBatch customFields')
      .populate('category')
      .sort({ name: 1, _id: 1 })
      .limit(resultLimit + 1);
    const hasMore = fetchedProducts.length > resultLimit;
    const products = hasMore ? fetchedProducts.slice(0, resultLimit) : fetchedProducts;
    const lastProduct = products[products.length - 1];
    const nextCursor = hasMore && lastProduct
      ? Buffer.from(JSON.stringify({ name: lastProduct.name, id: String(lastProduct._id) })).toString('base64url')
      : null;

    // Resolve category IDs explicitly as well as using populate below. The
    // till must never render an opaque foreign key as a category chip label.
    const productCategoryIds = [...new Set(products.map((product) => {
      const category = product.category;
      return String(category && typeof category === 'object'
        ? (category.id || category._id || category.categoryId || '')
        : (category || ''));
    }).filter(isObjectIdString))];
    const categoryRows = productCategoryIds.length
      ? await dbClient().category.findMany({
        where: { companyId: String(companyId), id: { in: productCategoryIds } },
        select: { id: true, name: true, isNoDiscount: true },
      })
      : [];
    const categoryById = new Map(categoryRows.map((category) => [String(category.id).trim(), category]));

    const [warehouseStockLevels, priceListPricing, transferVisibility, quarantinedRows, availabilityWarehouses] = await Promise.all([
      warehouseId && products.length
      ? StockLevel.find({
          company_id: companyId,
          warehouse_id: warehouseId,
          product_id: { $in: products.map((product) => product._id) },
        }).lean()
      : [],
      getWarehousePriceListPrices(companyId, warehouseId, products.map((product) => product._id)),
      getWarehouseTransferVisibility(companyId, warehouseId, products.map((product) => product._id)),
      products.length
        ? dbClient().stockBatch.groupBy({
          by: ['productId', 'warehouseId'],
          where: {
            companyId: String(companyId),
            productId: { in: products.map((product) => String(product._id)) },
            ...(warehouseId ? { warehouseId: String(warehouseId) } : {}),
            isQuarantined: true,
            qtyOnHand: { gt: 0 },
          },
          _sum: { qtyOnHand: true },
        })
        : [],
      dbClient().warehouse.findMany({
        where: { companyId: String(companyId), isActive: true },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
        take: 100,
      }),
    ]);
    const allWarehouseLevels = products.length && availabilityWarehouses.length
      ? await StockLevel.find({
          company_id: companyId,
          warehouse_id: { $in: availabilityWarehouses.map((warehouse) => warehouse.id) },
          product_id: { $in: products.map((product) => product._id) },
        }).lean()
      : [];
    const allLevelsByProduct = new Map();
    for (const level of allWarehouseLevels) {
      const productKey = String(level.product_id);
      const levels = allLevelsByProduct.get(productKey) || new Map();
      levels.set(String(level.warehouse_id), level);
      allLevelsByProduct.set(productKey, levels);
    }
    const warehouseStockByProduct = new Map(
      warehouseStockLevels.map((level) => [String(level.product_id), level]),
    );
    const quarantinedByProductWarehouse = new Map(quarantinedRows.map((row) => [`${String(row.productId)}:${String(row.warehouseId)}`, Number(row._sum?.qtyOnHand || 0)]));
    const quarantinedByProduct = new Map(quarantinedRows
      .filter((row) => !warehouseId || String(row.warehouseId) === String(warehouseId))
      .map((row) => [String(row.productId), Number(row._sum?.qtyOnHand || 0)]));

    // Enhance with availability info
    const enhancedProducts = products.map(p => {
      const stockLevel = warehouseStockByProduct.get(String(p._id));
      const onHandStock = warehouseId ? toNumber(stockLevel?.qty_on_hand) : toNumber(p.currentStock);
      const reservedStock = warehouseId ? toNumber(stockLevel?.qty_reserved) : toNumber(p.qtyReserved);
      const quarantinedStock = quarantinedByProduct.get(String(p._id)) || 0;
      const currentStock = Math.max(0, onHandStock - reservedStock - quarantinedStock);
      const customFields = p.customFields && typeof p.customFields === 'object' && !Array.isArray(p.customFields)
        ? p.customFields
        : {};
      const pharmacyFields = customFields.pharmacy && typeof customFields.pharmacy === 'object' && !Array.isArray(customFields.pharmacy)
        ? customFields.pharmacy
        : null;
      const pharmacyStatus = String(pharmacyFields?.prescriptionStatus || 'OTC').trim().toUpperCase();
      const pharmacy = pharmacyFields && ['OTC', 'PRESCRIPTION', 'RESTRICTED'].includes(pharmacyStatus)
        ? {
          genericName: String(pharmacyFields.genericName || '').trim().slice(0, 180),
          strength: String(pharmacyFields.strength || '').trim().slice(0, 80),
          dosageForm: String(pharmacyFields.dosageForm || '').trim().slice(0, 48),
          prescriptionStatus: pharmacyStatus,
          controlled: pharmacyFields.restrictedStatus === true || pharmacyStatus === 'RESTRICTED',
        }
        : null;
      return {
        _id: p._id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        alternateBarcodes: Array.isArray(p.alternateBarcodes) ? p.alternateBarcodes : [],
        imageUrl: p.imageUrl || null,
        imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls : [],
        sellingPrice: effectivePrice(String(p._id), toNumber(p.sellingPrice), priceListPricing.priceByProduct),
        standardSellingPrice: toNumber(p.sellingPrice),
        unit: p.unit,
        taxRate: resolveProductTaxRate(p),
        taxCode: p.taxCode || (resolveProductTaxRate(p) > 0 ? 'B' : 'A'),
        currentStock,
        onHandStock,
        reservedStock,
        quarantinedStock,
        isStockable: p.isStockable !== false,
        averageCost: toNumber(p.averageCost),
        // Till filters need a human-readable category. Product.find() selects
        // only the category foreign key unless the relation is populated.
        category: p.category && typeof p.category === 'object'
          ? (p.category.name || categoryById.get(String(p.category.id || p.category._id || p.category.categoryId || '').trim())?.name || null)
          : (categoryById.get(String(p.category || '').trim())?.name || (isObjectIdString(p.category) ? null : p.category)),
        isNoDiscount: Boolean(p.isNoDiscount),
        wholesale: normalizeWholesaleConfig(p),
        warehouseAvailability: availabilityWarehouses.map((warehouse) => {
          const level = allLevelsByProduct.get(String(p._id))?.get(String(warehouse.id));
          const onHand = toNumber(level?.qty_on_hand);
          const reserved = toNumber(level?.qty_reserved);
          const quarantined = quarantinedByProductWarehouse.get(`${String(p._id)}:${String(warehouse.id)}`) || 0;
          return {
            warehouseId: String(warehouse.id), warehouseName: warehouse.name, warehouseCode: warehouse.code || '',
            onHand, reserved, available: Math.max(0, onHand - reserved - quarantined),
          };
        }),
        categoryNoDiscount: Boolean(p.category && typeof p.category === 'object' && p.category.isNoDiscount)
          || Boolean(categoryById.get(String(p.category?.id || p.category?._id || p.category || '').trim())?.isNoDiscount),
        isAvailable: currentStock > 0 || p.isStockable === false,
        incomingTransfers: transferVisibility[String(p._id)]?.incoming || [],
        outgoingTransfers: transferVisibility[String(p._id)]?.outgoing || [],
        trackingType: p.trackingType === 'serial' || p.trackSerialNumbers
          ? 'serial'
          : p.trackingType === 'batch' || p.trackBatch ? 'batch' : (p.trackingType || 'none'),
        pharmacy,
      };
    });

    res.json({
      success: true,
      pagination: {
        limit: resultLimit,
        hasMore,
        nextCursor,
      },
      data: enhancedProducts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get saleable serial numbers for a POS product in the selected warehouse
 * @route   GET /api/sales-legacy/products/:productId/serial-numbers
 * @access  Private
 */
exports.getPosAvailableSerialNumbers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;
    const { warehouseId } = req.query;

    if (!isObjectIdString(productId) || !isObjectIdString(warehouseId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid product and warehouse are required.',
      });
    }

    const [product, warehouse] = await Promise.all([
      Product.findOne({
        _id: productId,
        company: companyId,
        isActive: true,
        $or: [
          { trackingType: 'serial' },
          { trackSerialNumbers: true },
        ],
      }).select('_id'),
      Warehouse.findOne({
        _id: warehouseId,
        company: companyId,
        isActive: { $ne: false },
      }).select('_id'),
    ]);

    if (!product) {
      return res.status(404).json({ success: false, message: 'Serial-tracked product not found.' });
    }
    if (!warehouse) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const serialNumbers = await StockSerialNumber.find({
      company: companyId,
      product: productId,
      warehouse: warehouseId,
      status: { $in: ['in_stock', 'returned'] },
    })
      .select('_id serialNo')
      .sort({ serialNo: 1 })
      .lean();

    return res.status(200).json({ success: true, data: serialNumbers });
  } catch (error) {
    return next(error);
  }
};

/**
 * @deprecated Receipt printing lives on posController.getReceipt and is mounted
 * at GET /api/sales-legacy/receipt/:invoiceId (and the retired /api/pos alias).
 */
exports.getReceipt = require('./posController').getReceipt;

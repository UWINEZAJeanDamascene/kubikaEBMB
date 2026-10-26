const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Company = require('../models/Company');
const { prisma } = require('../lib/prisma');
const ebmService = require('./ebmService');
const { VSDC_ENDPOINTS } = ebmService;
const { assertPharmacyInsurance } = require('./ebmOperationPolicy');
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');
const { validateWarehouseInsuranceConfig } = require('../utils/warehouseInsuranceConfig');

const REGISTERED = 'registered';
const FAILED = 'failed';
const NOT_REGISTERED = 'not_registered';
const BLOCKED = 'blocked';
const PENDING = 'pending';
const REJECTED = 'rejected';
const OUTCOME_UNKNOWN = 'outcome_unknown';
const MOCK = 'mock';
const ACCEPTED = 'accepted';

function clean(value, max = 60, fallback = '') {
  const text = String(value || fallback || '').trim();
  return text.slice(0, max);
}

function cleanDiagnosticMessage(value) {
  return clean(value, 500)
    .replace(/((?:pwd|password|passcode|token|secret|authorization|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

function normalizeTin(value) {
  const tin = typeof value === 'string' ? value.trim() : '';
  return /^\d{9}$/.test(tin) ? tin : '';
}

function normalizeBranchId(value) {
  const branchId = String(value || '00').trim();
  if (!/^\d{1,2}$/.test(branchId)) {
    const error = new Error('RRA branch ID must contain one or two digits.');
    error.code = 'EBM_BRANCH_ID_INVALID';
    error.statusCode = 422;
    throw error;
  }
  return branchId.padStart(2, '0');
}

async function assertUniqueBranchMapping(companyId, branchId) {
  const branches = await prisma.warehouse.findMany({
    where: { companyId: String(companyId), rraBranchId: branchId },
    select: { id: true },
    take: 2,
  });
  if (branches.length > 1) {
    const error = new Error(`More than one warehouse in this company is mapped to RRA branch ${branchId}. Keep one unique mapping before continuing.`);
    error.code = 'EBM_BRANCH_MAPPING_AMBIGUOUS';
    error.statusCode = 409;
    throw error;
  }
}

function actor(user, fallbackName = 'System') {
  const idSource = user?._id || user?.id || user?.email || user?.name || 'system';
  return {
    id: String(idSource).trim(),
    name: String(user?.name || fallbackName).trim(),
  };
}

function requireBranchAuditActor(user) {
  const id = String(user?._id || user?.id || '').trim();
  const name = String(user?.name || '').trim();
  if (!id || !name) {
    const error = new Error('A real registrant ID and name are required for the RRA branch-information request.');
    error.code = 'EBM_BRANCH_AUDIT_ACTOR_REQUIRED';
    error.statusCode = 422;
    throw error;
  }
  return { id, name };
}

function getCompanyTin(company) {
  const tin = normalizeTin(company?.tax_identification_number || company?.registration_number || company?.tin);
  if (!tin) {
    const error = new Error('Company TIN must be a 9 digit value before submitting EBM branch data');
    error.code = 'EBM_COMPANY_TIN_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  return tin;
}

function buildBranchUserPayload(company, branchId, user, registrar = null, credentials = {}) {
  const tin = getCompanyTin(company);
  const regr = requireBranchAuditActor(registrar);
  const userIdentifier = String(user.email || '').trim();
  if (!userIdentifier || userIdentifier.length > 20) {
    const error = new Error('A stable user email of at most 20 characters is required for the RRA userId field.');
    error.code = 'EBM_BRANCH_USER_ID_INVALID';
    error.statusCode = 422;
    throw error;
  }
  if (typeof credentials.password !== 'string' || !credentials.password.trim()) {
    const error = new Error('An approved secure RRA password source is required; the application password is never reused.');
    error.code = 'EBM_BRANCH_USER_CREDENTIAL_SOURCE_UNCONFIGURED';
    error.statusCode = 409;
    throw error;
  }
  return {
    companyId: company._id,
    tin,
    bhfId: normalizeBranchId(branchId),
    userId: userIdentifier,
    userNm: String(user.name || '').trim(),
    pwd: credentials.password,
    adrs: user.address || null,
    cntc: user.phone || null,
    ...(typeof credentials.authCd === 'string' && credentials.authCd.trim() ? { authCd: credentials.authCd.trim() } : {}),
    remark: null,
    useYn: user.isActive === false ? 'N' : 'Y',
    regrId: regr.id,
    regrNm: regr.name,
    modrId: regr.id,
    modrNm: regr.name,
  };
}

function markUserBranchStatus(user, branchId, status, details = {}) {
  const current = Array.isArray(user.ebmBranchUsers) ? user.ebmBranchUsers : [];
  const next = current.filter((item) => item.branchId !== branchId);
  next.push({
    branchId,
    status,
    lastAttemptAt: new Date().toISOString(),
    ...(details.mode ? { mode: details.mode } : {}),
    ...(details.actorId ? { actorId: String(details.actorId) } : {}),
    ...(details.resultCd ? { resultCd: String(details.resultCd) } : {}),
    ...(details.resultDt ? { resultDt: String(details.resultDt) } : {}),
    ...(details.resultMsg ? { resultMsg: cleanDiagnosticMessage(details.resultMsg) } : {}),
    ...(details.requestId ? { requestId: String(details.requestId) } : {}),
    ...(details.error ? { error: clean(details.error, 500) } : {}),
  });
  return next;
}

function buildBranchCustomerPayload(company, branchId, client, registrar = null) {
  const tin = getCompanyTin(company);
  const regr = requireBranchAuditActor(registrar);
  const contact = client.contact || {};
  const custTin = normalizeTin(client.taxId || client.tin || client.tax_identification_number);
  const address = contact.address || [contact.city, contact.state, contact.country].filter(Boolean).join(', ');
  return {
    companyId: company._id,
    tin,
    bhfId: normalizeBranchId(branchId),
    custNo: client.code || '',
    custTin,
    custNm: client.name || '',
    adrs: address || null,
    telNo: contact.phone || null,
    email: contact.email || null,
    faxNo: contact.fax || null,
    useYn: client.isActive === false ? 'N' : 'Y',
    regrId: regr.id,
    regrNm: regr.name,
    modrId: regr.id,
    modrNm: regr.name,
  };
}

function buildBranchInsurancePayload(company, branchId, insurance, registrar = null) {
  const tin = getCompanyTin(company);
  const regr = requireBranchAuditActor(registrar);
  return sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
    tin,
    bhfId: normalizeBranchId(branchId),
    isrccCd: insurance.isrccCd,
    isrccNm: insurance.isrccNm,
    isrcRt: insurance.isrcRt,
    useYn: insurance.useYn,
    regrId: regr.id,
    regrNm: regr.name,
    modrId: regr.id,
    modrNm: regr.name,
  });
}

function markClientBranchStatus(client, branchId, status, details = {}) {
  const normalized = normalizeBranchId(branchId);
  const current = Array.isArray(client.ebmBranchCustomers) ? client.ebmBranchCustomers : [];
  const next = current.filter((item) => item.branchId !== normalized);
  next.push({
    branchId: normalized,
    status,
    lastAttemptAt: new Date(),
    ...(status === REGISTERED || status === ACCEPTED ? { submittedAt: new Date() } : {}),
    ...(details.mode ? { mode: details.mode } : {}),
    ...(details.resultCd ? { resultCd: details.resultCd } : {}),
    ...(details.resultDt ? { resultDt: details.resultDt } : {}),
    ...(details.resultMsg ? { resultMsg: cleanDiagnosticMessage(details.resultMsg) } : {}),
    ...(details.requestId ? { requestId: String(details.requestId) } : {}),
    ...(details.error ? { error: clean(details.error, 500) } : {}),
  });
  client.ebmBranchCustomers = next;
}

class EBMBranchService {
  static async getBranchInsuranceStatus(companyId) {
    const warehouses = await prisma.warehouse.findMany({
      where: { companyId: String(companyId) },
      select: {
        id: true,
        ebmInsuranceSubmitted: true,
        ebmInsuranceSubmissions: true,
      },
    });
    return warehouses.map((warehouse) => ({
      warehouseId: warehouse.id,
      submitted: Boolean(warehouse.ebmInsuranceSubmitted),
      records: (Array.isArray(warehouse.ebmInsuranceSubmissions) ? warehouse.ebmInsuranceSubmissions : [])
        .map((submission) => ({
          branchId: submission.branchId || warehouse.rraBranchId || null,
          isrccCd: submission.isrccCd,
          status: submission.status,
          code: submission.code ?? null,
          error: cleanDiagnosticMessage(submission.error),
          resultCd: submission.resultCd ?? null,
          resultMsg: cleanDiagnosticMessage(submission.resultMsg),
          resultDt: submission.resultDt ?? null,
          requestId: submission.requestId ?? null,
          mode: submission.mode ?? null,
          lastAttemptAt: submission.lastAttemptAt ?? null,
        })),
    }));
  }

  static async getBranchCustomerStatus(companyId, clientId) {
    const client = await prisma.client.findFirst({
      where: { id: String(clientId), companyId: String(companyId) },
      select: { ebmBranchCustomers: true },
    });
    if (!client) {
      const error = new Error('Client not found');
      error.statusCode = 404;
      throw error;
    }
    return (Array.isArray(client.ebmBranchCustomers) ? client.ebmBranchCustomers : []).map((submission) => ({
      branchId: submission.branchId,
      status: submission.status,
      mode: submission.mode ?? null,
      submittedAt: submission.submittedAt ?? null,
      lastAttemptAt: submission.lastAttemptAt ?? null,
      resultCd: submission.resultCd ?? null,
      resultMsg: cleanDiagnosticMessage(submission.resultMsg),
      resultDt: submission.resultDt ?? null,
      requestId: submission.requestId ?? null,
      error: cleanDiagnosticMessage(submission.error),
    }));
  }

  static async isBranchRegistered(companyId, branchId) {
    const normalizedBranchId = normalizeBranchId(branchId);
    await assertUniqueBranchMapping(companyId, normalizedBranchId);
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: normalizedBranchId,
      ebmRegistrationStatus: REGISTERED,
      ebmRegistrationMode: ebmService.mode,
    }).lean();
    return !!branch;
  }

  static async ensureBranchRegistered({ companyId, branchId, mode }) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const { EBMServiceError } = require('./ebmService');
    await assertUniqueBranchMapping(companyId, normalizedBranchId);

    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: normalizedBranchId,
    }).lean();

    if (!branch) {
      throw new EBMServiceError(
        `No warehouse is mapped to RRA branch ${normalizedBranchId}. Open Warehouses, set the RRA Branch ID on the warehouse (use 00 for the head office), then register the branch.`,
        { code: 'EBM_BRANCH_NOT_MAPPED', mode, retryable: false },
      );
    }

    if (branch.ebmRegistrationStatus === REGISTERED
      && branch.ebmRegistrationMode === mode) return;

    // Register inline rather than in the background so the caller sees why it failed
    // instead of a generic "not registered" that never resolves.
    try {
      await this.registerBranchById(companyId, normalizedBranchId);
      if (mode === MOCK) return;
    } catch (error) {
      throw new EBMServiceError(
        `EBM branch ${normalizedBranchId} could not be registered with RRA: ${error.message}`,
        { code: 'EBM_BRANCH_NOT_REGISTERED', mode, retryable: false },
      );
    }
  }

  static async registerBranchById(companyId, branchId, userId = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    await assertUniqueBranchMapping(companyId, normalizedBranchId);
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId });
    if (!branch) {
      const error = new Error(`Branch ${branchId} not found`);
      error.statusCode = 404;
      throw error;
    }
    return this.registerBranch(companyId, branch, userId);
  }

  static async verifyBranchExists(companyId, branch, company) {
    const tin = getCompanyTin(company);
    const branchId = normalizeBranchId(branch.rraBranchId);
    const response = await ebmService.selectBranches({
      companyId,
      tin,
      bhfId: branchId,
      lastReqDt: '20191130000000',
    });
    const list = response?.data?.bhfList || response?.raw?.data?.bhfList || [];
    const match = list.find((item) => typeof item?.bhfId === 'string'
      && /^\d{1,2}$/.test(item.bhfId.trim())
      && item.bhfId.trim().padStart(2, '0') === branchId);
    if (!match) {
      const error = new Error(`RRA VSDC branch ${branchId} was not returned by /branches/selectBranches`);
      error.code = 'EBM_BRANCH_NOT_FOUND_AT_RRA';
      error.statusCode = 400;
      throw error;
    }
    return match;
  }

  static async registerBranch(companyId, branch, userId = null) {
    const company = await Company.findById(companyId).lean();
    if (!company) throw new Error('Company not found');

    const mode = ebmService.mode;
    const isMockMode = mode === MOCK;
    if (!isMockMode) branch.ebmLastAttemptAt = new Date();
    try {
      await this.verifyBranchExists(companyId, branch, company);
    } catch (error) {
      if (!isMockMode) {
        branch.ebmRegistrationStatus = FAILED;
        branch.ebmRegistrationError = error.message || 'Branch registration failed';
        await branch.save();
      }
      throw error;
    }

    if (!isMockMode) {
      branch.ebmRegistrationStatus = REGISTERED;
      branch.ebmRegistrationMode = mode;
      branch.ebmRegisteredAt = new Date();
      branch.ebmRegistrationError = null;
      await branch.save();
    }

    try {
      if (ebmService.isBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_BRANCH_USER)) {
        await this.submitBranchUsers(companyId, branch.rraBranchId, userId);
      }
      if (ebmService.isBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE)) {
        await this.submitBranchInsurance(companyId, branch.rraBranchId);
      }
    } catch (error) {
      if (!isMockMode) {
        branch.ebmRegistrationError = error.message || 'Branch information submission failed';
        await branch.save();
      }
      throw error;
    }

    return branch;
  }

  static async submitBranchUsers(companyId, branchId, registrar = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    await assertUniqueBranchMapping(companyId, normalizedBranchId);
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: normalizedBranchId,
    }).lean();
    if (!branch) {
      const error = new Error(`No warehouse in this company is mapped to RRA branch ${normalizedBranchId}.`);
      error.code = 'EBM_BRANCH_NOT_MAPPED';
      error.statusCode = 409;
      throw error;
    }

    const assignedUsers = await prisma.user.findMany({
      where: { companyId: String(companyId), branchId: String(branch._id) },
    });
    const featureEnabled = ebmService.isBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_BRANCH_USER);
    const branchReady = branch.ebmRegistrationStatus === REGISTERED
      && branch.ebmRegistrationMode === ebmService.mode;
    const blockedCode = !branchReady
      ? 'EBM_BRANCH_NOT_REGISTERED'
      : featureEnabled
        ? 'EBM_BRANCH_USER_CREDENTIAL_SOURCE_UNCONFIGURED'
        : 'EBM_BRANCH_USER_CONTRACT_BLOCKED';
    const blockedMessage = !branchReady
      ? `RRA branch ${normalizedBranchId} must be registered and verified before its users can be submitted.`
      : featureEnabled
        ? 'RRA branch-user submission remains blocked until an approved secure pwd source and RRA-approved <=20-character user/registrar identifier sources are configured; optional authCd is omitted.'
        : 'RRA branch-user submission is disabled pending secure pwd provisioning, identifier semantics, and sandbox acceptance.';

    for (const user of assignedUsers) {
      const ebmBranchUsers = markUserBranchStatus(user, normalizedBranchId, BLOCKED, {
        mode: ebmService.mode,
        actorId: registrar?._id || registrar?.id || registrar,
        error: `${blockedCode}: ${blockedMessage}`,
      });
      await prisma.user.update({
        where: {
          id: user.id,
          companyId: String(companyId),
          branchId: String(branch._id),
        },
        data: { ebmBranchUsers },
      });
    }

    return {
      branchId: normalizedBranchId,
      status: BLOCKED,
      code: blockedCode,
      message: blockedMessage,
      affectedUsers: assignedUsers.length,
    };
  }

  static async submitBranchInsurance(companyId, branchId, registrar = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    await assertUniqueBranchMapping(companyId, normalizedBranchId);
    const branch = await Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId });
    if (!branch) {
      const error = new Error(`No warehouse in this company is mapped to RRA branch ${normalizedBranchId}.`);
      error.code = 'EBM_BRANCH_NOT_MAPPED';
      error.statusCode = 404;
      throw error;
    }
    const company = await Company.findById(companyId).lean();
    if (!company) {
      const error = new Error('Company not found.');
      error.code = 'COMPANY_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    const insuranceList = validateWarehouseInsuranceConfig(
      Array.isArray(branch.ebmInsurances) ? branch.ebmInsurances : [],
    );

    const insuranceApplicableProductExists = await Product.exists({
      company: companyId,
      'ebm.isrcAplcbYn': 'Y',
      isActive: { $ne: false },
    });

    if (insuranceList.length > 0 || insuranceApplicableProductExists) {
      assertPharmacyInsurance(company);
    }

    if (insuranceApplicableProductExists && insuranceList.length === 0) {
      const error = new Error('EBM branch insurance list is required for insurance-applicable products');
      error.code = 'EBM_BRANCH_INSURANCE_REQUIRED';
      error.statusCode = 400;
      throw error;
    }

    if (insuranceList.length === 0) {
      await prisma.warehouse.update({
        where: { id: String(branch._id), companyId: String(companyId) },
        data: { ebmInsuranceSubmitted: false, ebmInsuranceSubmissions: [] },
      });
      return { branchId: normalizedBranchId, status: 'not_configured', records: [] };
    }

    const contractMessage = 'RRA branch-insurance submission is blocked pending confirmation of per-record versus batch behavior, the precision/range for NUMBER length 3 isrcRt, and handling of inactive records. The endpoint path matches the PDF. No request was sent.';
    const branchReady = branch.ebmRegistrationStatus === REGISTERED
      && branch.ebmRegistrationMode === ebmService.mode;
    const records = insuranceList.map((insurance) => {
      let payloadError = null;
      try {
        buildBranchInsurancePayload(company, normalizedBranchId, insurance, registrar);
      } catch (error) {
        payloadError = error.message;
      }
      const error = !branchReady
        ? `RRA branch ${normalizedBranchId} must be registered and verified before its insurance can be submitted.`
        : payloadError || contractMessage;
      return {
        branchId: normalizedBranchId,
        isrccCd: insurance.isrccCd,
        status: BLOCKED,
        code: !branchReady
          ? 'EBM_BRANCH_NOT_REGISTERED'
          : payloadError
            ? 'EBM_BRANCH_INSURANCE_PAYLOAD_INVALID'
            : 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
        error,
        mode: ebmService.mode,
        lastAttemptAt: new Date().toISOString(),
        actorId: String(registrar?._id || registrar?.id || registrar || ''),
      };
    });
    await prisma.warehouse.update({
      where: { id: String(branch._id), companyId: String(companyId) },
      data: {
        ebmInsuranceSubmitted: false,
        ebmInsuranceSubmissions: records,
      },
    });
    return {
      branchId: normalizedBranchId,
      status: BLOCKED,
      code: records.some((record) => record.code === 'EBM_BRANCH_NOT_REGISTERED')
        ? 'EBM_BRANCH_NOT_REGISTERED'
        : records.some((record) => record.code === 'EBM_BRANCH_INSURANCE_PAYLOAD_INVALID')
          ? 'EBM_BRANCH_INSURANCE_PAYLOAD_INVALID'
          : 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
      message: records.find((record) => record.code !== 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED')?.error || contractMessage,
      records,
      dispatched: false,
    };
  }

  static async saveBranchCustomer(companyId, clientId, branchId = '00', registrarUser = null) {
    const normalizedBranchId = normalizeBranchId(branchId);
    const [company, client] = await Promise.all([
      Company.findById(companyId).lean(),
      Client.findOne({ _id: clientId, company: companyId }),
    ]);
    if (!company) throw new Error('Company not found');
    if (!client) {
      const error = new Error('Client not found');
      error.statusCode = 404;
      throw error;
    }

    const previousStatus = (Array.isArray(client.ebmBranchCustomers) ? client.ebmBranchCustomers : [])
      .find((item) => item.branchId === normalizedBranchId);
    if (previousStatus && ['registered', ACCEPTED, PENDING, OUTCOME_UNKNOWN].includes(previousStatus.status)) {
      const error = new Error(previousStatus.status === OUTCOME_UNKNOWN
        ? 'The previous RRA branch-customer request may have been accepted. Reconcile its outcome before retrying; the contract does not guarantee idempotent saves.'
        : previousStatus.status === PENDING
          ? 'A branch-customer request is still pending. Reconcile its outcome before retrying.'
        : 'This branch customer already has an accepted submission. The RRA contract does not define update/upsert behavior, so a duplicate save is blocked.');
      error.code = previousStatus.status === OUTCOME_UNKNOWN
        ? 'EBM_BRANCH_CUSTOMER_OUTCOME_NEEDS_RECONCILIATION'
        : previousStatus.status === PENDING
          ? 'EBM_BRANCH_CUSTOMER_SUBMISSION_PENDING'
          : 'EBM_BRANCH_CUSTOMER_ALREADY_ACCEPTED';
      error.statusCode = 409;
      error.retryable = false;
      throw error;
    }

    let acceptedResponse;
    try {
      ebmService.assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, ebmService.mode);
      await assertUniqueBranchMapping(companyId, normalizedBranchId);
      const branch = await Warehouse.findOne({
        company: companyId,
        rraBranchId: normalizedBranchId,
      }).lean();
      if (!branch) {
        const error = new Error(`No warehouse in this company is mapped to RRA branch ${normalizedBranchId}.`);
        error.code = 'EBM_BRANCH_NOT_MAPPED';
        error.statusCode = 409;
        throw error;
      }
      const branchReady = ebmService.mode === MOCK
        || (branch.ebmRegistrationStatus === REGISTERED
          && branch.ebmRegistrationMode === ebmService.mode);
      if (!branchReady) {
        const error = new Error(`RRA branch ${normalizedBranchId} must be verified before saving a branch customer.`);
        error.code = 'EBM_BRANCH_NOT_REGISTERED';
        error.statusCode = 409;
        throw error;
      }

      const payload = buildBranchCustomerPayload(company, normalizedBranchId, client, registrarUser);
      const duplicate = await Client.findOne({
        company: companyId,
        code: payload.custNo,
        _id: { $ne: client._id },
      }).select('_id').lean();
      if (duplicate) {
        const error = new Error(`Customer number ${payload.custNo} is already mapped to another client in this company. Assign a unique code of at most 9 characters; values are never truncated.`);
        error.code = 'EBM_BRANCH_CUSTOMER_NUMBER_CONFLICT';
        error.statusCode = 409;
        throw error;
      }

      markClientBranchStatus(client, normalizedBranchId, PENDING, {
        mode: ebmService.mode,
        actorId: registrarUser?._id || registrarUser?.id,
      });
      await client.save();

      acceptedResponse = await ebmService.saveBranchCustomer(payload);
      const status = acceptedResponse.mode === MOCK ? MOCK : ACCEPTED;
      markClientBranchStatus(client, normalizedBranchId, status, acceptedResponse);
      await client.save();
      return { client, payload, response: acceptedResponse };
    } catch (error) {
      if (acceptedResponse) {
        markClientBranchStatus(
          client,
          normalizedBranchId,
          acceptedResponse.mode === MOCK ? MOCK : ACCEPTED,
          acceptedResponse,
        );
        await client.save();
        throw error;
      }
      const resultCd = error.resultCd || error.response?.resultCd;
      const resultMsg = cleanDiagnosticMessage(error.response?.resultMsg || error.resultMsg);
      const resultDt = error.response?.resultDt;
      const safeErrorMessage = cleanDiagnosticMessage(error.message || 'Branch customer submission failed');
      const status = error.code === 'EBM_BRANCH_CUSTOMER_CONTRACT_BLOCKED'
        ? BLOCKED
        : error.dispatched === true && resultCd && resultCd !== '000'
          ? REJECTED
          : error.dispatched === true
            ? OUTCOME_UNKNOWN
            : FAILED;
      if (error && typeof error === 'object') {
        const originalMessage = error.message;
        error.message = safeErrorMessage;
        if (typeof error.stack === 'string' && originalMessage) {
          error.stack = error.stack.replace(originalMessage, safeErrorMessage);
        }
        error.cause = undefined;
        error.payload = undefined;
        error.resultMsg = resultMsg;
        if (error.response && typeof error.response === 'object') {
          error.response = {
            ...(resultCd ? { resultCd: String(resultCd) } : {}),
            ...(resultMsg ? { resultMsg } : {}),
            ...(resultDt ? { resultDt: String(resultDt) } : {}),
          };
        }
      }
      markClientBranchStatus(client, normalizedBranchId, status, {
        error: safeErrorMessage,
        mode: error.mode || ebmService.mode,
        resultCd,
        resultMsg,
        resultDt,
        requestId: error.requestId,
      });
      await client.save();
      throw error;
    }
  }
}

module.exports = EBMBranchService;
module.exports.BRANCH_EBM_STATUSES = { REGISTERED, FAILED, NOT_REGISTERED };
module.exports.__test__ = {
  buildBranchUserPayload,
  markUserBranchStatus,
  buildBranchCustomerPayload,
  buildBranchInsurancePayload,
  normalizeBranchId,
  normalizeTin,
  markClientBranchStatus,
  cleanDiagnosticMessage,
};
module.exports.sanitizeDiagnosticMessage = cleanDiagnosticMessage;

'use strict';

const { randomBytes } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const JournalService = require('../services/journalService');
const posAccountingProfileService = require('../services/posAccountingProfileService');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const {
  allocateClaimLines,
  centsToAmount,
  claimBalance,
  moneyCents,
} = require('../services/posPharmacyInsuranceService');

const ID_PATTERN = /^[0-9a-f]{24}$/i;

function context(req) {
  const auth = req.posAuthContext;
  return {
    companyId: String(auth?.company?.id || ''),
    registerId: String(auth?.register?.id || ''),
    userId: String(auth?.user?.id || ''),
  };
}

async function resolveInsuranceAccount(companyId, registerId, profileKey, moduleName, mappingKey, fallback) {
  const profile = await posAccountingProfileService.getProfile(String(companyId));
  const scope = { tillType: 'pharmacy', registerId: String(registerId) };
  return posAccountingProfileService.resolveAccount(profile, profileKey, scope)
    || JournalService.getMappedAccountCode(companyId, moduleName, mappingKey, fallback);
}

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function text(value, field, max, { required = false, min = 0 } = {}) {
  const result = String(value ?? '').normalize('NFKC').trim();
  if ((required && !result) || result.length > max || result.length < min || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw Object.assign(new TypeError(`${field} must be ${required ? 'provided and ' : ''}between ${min} and ${max} characters.`), {
      statusCode: 400,
      code: 'PHARMACY_INSURANCE_INPUT_INVALID',
    });
  }
  return result || null;
}

function validId(value, field) {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    throw Object.assign(new TypeError(`${field} is not valid.`), {
      statusCode: 400,
      code: 'PHARMACY_INSURANCE_ID_INVALID',
    });
  }
  return id;
}

function validDate(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) {
      throw Object.assign(new TypeError(`${field} is required.`), {
        statusCode: 400,
        code: 'PHARMACY_INSURANCE_DATE_INVALID',
      });
    }
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new TypeError(`${field} must be a valid date.`), {
      statusCode: 400,
      code: 'PHARMACY_INSURANCE_DATE_INVALID',
    });
  }
  return date;
}

function handledError(res, error) {
  if (!error?.statusCode) return false;
  fail(res, error.statusCode, error.code || 'PHARMACY_INSURANCE_REQUEST_INVALID', error.message);
  return true;
}

async function assertPatient(tx, companyId, registerId, patientId) {
  const patient = await tx.pharmacyPatient.findFirst({
    where: { id: patientId, companyId, registerId },
    select: { id: true, fullName: true, patientCode: true },
  });
  if (!patient) {
    throw Object.assign(new Error('The patient is not available on this Pharmacy register.'), {
      statusCode: 404,
      code: 'PHARMACY_PATIENT_NOT_FOUND',
    });
  }
  return patient;
}

async function loadActiveMember(tx, { companyId, registerId, patientId, memberId }) {
  const member = await tx.pharmacyInsuranceMember.findFirst({
    where: {
      id: memberId,
      companyId,
      patientId,
      patient: { registerId },
      status: 'active',
      provider: { isActive: true },
    },
    include: { provider: true },
  });
  if (!member) {
    throw Object.assign(new Error('Verify an active insurance membership before checking coverage.'), {
      statusCode: 409,
      code: 'PHARMACY_INSURANCE_MEMBER_NOT_ACTIVE',
    });
  }
  const today = new Date();
  if (member.effectiveFrom && member.effectiveFrom > today
    || member.effectiveTo && member.effectiveTo < today) {
    throw Object.assign(new Error('The insurance membership is outside its recorded coverage dates.'), {
      statusCode: 409,
      code: 'PHARMACY_INSURANCE_MEMBER_OUTSIDE_DATES',
    });
  }
  return member;
}

exports.listProviders = async (req, res, next) => {
  try {
    const { companyId } = context(req);
    if (!companyId) return fail(res, 401, 'POS_SESSION_INVALID', 'Sign in to this Pharmacy register again.');
    const providers = await dbClient().pharmacyInsuranceProvider.findMany({
      where: { companyId, isActive: true },
      select: { id: true, code: true, name: true, requiresPreauthorization: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, data: { providers, verificationMode: 'manual' } });
  } catch (error) {
    return next(error);
  }
};

exports.listMembers = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const patientId = validId(req.params.patientId, 'Patient ID');
    await assertPatient(dbClient(), companyId, registerId, patientId);
    const members = await dbClient().pharmacyInsuranceMember.findMany({
      where: { companyId, patientId },
      include: { provider: { select: { id: true, code: true, name: true, requiresPreauthorization: true } } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return res.json({ success: true, data: { members } });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.createMember = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const patientId = validId(req.params.patientId, 'Patient ID');
    const providerId = validId(req.body?.providerId, 'Insurer');
    const memberNumber = text(req.body?.memberNumber, 'Member number', 100, { required: true, min: 2 });
    const policyNumber = text(req.body?.policyNumber, 'Policy number', 100);
    const groupNumber = text(req.body?.groupNumber, 'Group number', 100);
    const relationshipToHolder = text(req.body?.relationshipToHolder, 'Relationship', 40);
    const effectiveFrom = validDate(req.body?.effectiveFrom, 'Coverage start date');
    const effectiveTo = validDate(req.body?.effectiveTo, 'Coverage end date');
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      return fail(res, 400, 'PHARMACY_INSURANCE_DATE_RANGE_INVALID', 'Coverage end date must be on or after the start date.');
    }
    const patient = await assertPatient(dbClient(), companyId, registerId, patientId);
    const provider = await dbClient().pharmacyInsuranceProvider.findFirst({
      where: { id: providerId, companyId, isActive: true },
      select: { id: true, code: true },
    });
    if (!provider) return fail(res, 404, 'PHARMACY_INSURANCE_PROVIDER_NOT_FOUND', 'Choose an active insurer for this membership.');
    const member = await dbClient().pharmacyInsuranceMember.create({
      data: {
        id: randomBytes(12).toString('hex'),
        companyId,
        providerId,
        patientId,
        memberNumber,
        policyNumber,
        groupNumber,
        relationshipToHolder,
        effectiveFrom,
        effectiveTo,
        createdById: userId,
      },
      include: { provider: { select: { id: true, code: true, name: true, requiresPreauthorization: true } } },
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_MEMBER_CREATED',
      metadata: { patientId: patient.id, memberId: member.id, providerId: provider.id },
      ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { member } });
  } catch (error) {
    if (handledError(res, error)) return;
    if (error?.code === 'P2002') return fail(res, 409, 'PHARMACY_INSURANCE_MEMBER_EXISTS', 'This patient already has this insurer member number.');
    return next(error);
  }
};

exports.verifyMember = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const memberId = validId(req.params.memberId, 'Membership ID');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['active', 'rejected', 'suspended', 'expired'].includes(status)) {
      return fail(res, 400, 'PHARMACY_INSURANCE_MEMBER_STATUS_INVALID', 'Choose active, rejected, suspended, or expired after contacting the insurer.');
    }
    const verificationReference = text(req.body?.verificationReference, 'Verification reference', 160);
    const verificationNote = text(req.body?.verificationNote, 'Verification note', 1000, { required: status !== 'active', min: status !== 'active' ? 5 : 0 });
    const updated = await dbClient().pharmacyInsuranceMember.updateMany({
      where: { id: memberId, companyId, patient: { registerId } },
      data: {
        status,
        verifiedAt: new Date(),
        verifiedById: userId,
        verificationReference,
        verificationNote,
      },
    });
    if (updated.count !== 1) return fail(res, 404, 'PHARMACY_INSURANCE_MEMBER_NOT_FOUND', 'Membership was not found on this Pharmacy register.');
    const member = await dbClient().pharmacyInsuranceMember.findFirst({
      where: { id: memberId, companyId },
      include: { provider: { select: { id: true, code: true, name: true, requiresPreauthorization: true } } },
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_MEMBER_VERIFIED',
      metadata: { memberId, status, hasReference: Boolean(verificationReference) },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { member } });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.recordEligibility = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const patientId = validId(req.body?.patientId, 'Patient ID');
    const memberId = validId(req.body?.memberId, 'Membership ID');
    const invoiceId = validId(req.body?.invoiceId, 'Invoice ID');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['eligible', 'not_eligible'].includes(status)) {
      return fail(res, 400, 'PHARMACY_INSURANCE_ELIGIBILITY_STATUS_INVALID', 'Record whether the insurer confirmed this patient as eligible.');
    }
    const invoice = await dbClient().invoice.findFirst({
      where: { id: invoiceId, companyId, posOrigin: true, registerId },
      select: { id: true, status: true, totalAmount: true, posCheckoutPayload: true },
    });
    if (!invoice || invoice.status !== 'PENDING_PAYMENT'
      || String(invoice.posCheckoutPayload?.pharmacyPatientId || '') !== patientId) {
      return fail(res, 409, 'PHARMACY_INSURANCE_PENDING_SALE_REQUIRED', 'Check coverage against the current pending Pharmacy sale and its selected patient.');
    }
    const member = await loadActiveMember(dbClient(), { companyId, registerId, patientId, memberId });
    const totalCents = moneyCents(invoice.totalAmount, 'Sale total', { allowZero: false });
    const coveredCents = moneyCents(req.body?.coveredAmount, 'Insurer-covered amount');
    const copayCents = moneyCents(req.body?.copayAmount, 'Patient copay');
    if (coveredCents + copayCents !== totalCents
      || status === 'not_eligible' && coveredCents !== 0
      || status === 'eligible' && coveredCents === 0) {
      return fail(res, 400, 'PHARMACY_INSURANCE_SPLIT_INVALID', 'Insurer coverage and patient copay must add up exactly to the sale total.');
    }
    const responseReference = text(req.body?.responseReference, 'Insurer response reference', 160);
    const responseNote = text(req.body?.responseNote, 'Insurer response note', 1000, { required: true, min: 5 });
    const claimAlreadyExists = await dbClient().pharmacyInsuranceClaim.findFirst({
      where: { companyId, invoiceId },
      select: { id: true },
    });
    if (claimAlreadyExists) return fail(res, 409, 'PHARMACY_INSURANCE_CLAIM_ALREADY_EXISTS', 'Coverage for this invoice can no longer be changed after claim creation.');
    const eligibility = await dbClient().pharmacyInsuranceEligibility.upsert({
      where: { companyId_invoiceId: { companyId, invoiceId } },
      create: {
        id: randomBytes(12).toString('hex'),
        companyId,
        providerId: member.providerId,
        memberId,
        patientId,
        invoiceId,
        status,
        coveredAmount: centsToAmount(coveredCents),
        copayAmount: centsToAmount(copayCents),
        responseReference,
        responseNote,
        checkedById: userId,
        validUntil: validDate(req.body?.validUntil, 'Eligibility expiry'),
      },
      update: {
        providerId: member.providerId,
        memberId,
        patientId,
        status,
        coveredAmount: centsToAmount(coveredCents),
        copayAmount: centsToAmount(copayCents),
        responseReference,
        responseNote,
        checkedById: userId,
        checkedAt: new Date(),
        validUntil: validDate(req.body?.validUntil, 'Eligibility expiry'),
      },
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_ELIGIBILITY_RECORDED',
      metadata: { eligibilityId: eligibility.id, invoiceId, memberId, status, coveredAmount: centsToAmount(coveredCents), copayAmount: centsToAmount(copayCents) },
      ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: {
        eligibility,
        requiresPreauthorization: member.provider.requiresPreauthorization,
      },
    });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.requestAuthorization = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const eligibilityId = validId(req.body?.eligibilityId, 'Eligibility ID');
    const eligibility = await dbClient().pharmacyInsuranceEligibility.findFirst({
      where: { id: eligibilityId, companyId, invoice: { registerId, status: 'PENDING_PAYMENT' } },
      include: { provider: true },
    });
    if (!eligibility || eligibility.status !== 'eligible') {
      return fail(res, 409, 'PHARMACY_INSURANCE_ELIGIBILITY_REQUIRED', 'Record an eligible insurer response before requesting preauthorization.');
    }
    if (!eligibility.provider.requiresPreauthorization) {
      return fail(res, 409, 'PHARMACY_INSURANCE_PREAUTH_NOT_REQUIRED', 'This insurer does not require recorded preauthorization.');
    }
    const requestedCents = moneyCents(req.body?.requestedAmount, 'Authorization amount', { allowZero: false });
    if (requestedCents > moneyCents(eligibility.coveredAmount, 'Coverage amount', { allowZero: false })) {
      return fail(res, 400, 'PHARMACY_INSURANCE_AUTHORIZATION_AMOUNT_INVALID', 'The requested authorization cannot exceed the insurer-covered amount.');
    }
    const requestNote = text(req.body?.requestNote, 'Authorization request note', 1000, { required: true, min: 5 });
    const authorization = await dbClient().pharmacyInsuranceAuthorization.create({
      data: {
        id: randomBytes(12).toString('hex'),
        companyId,
        providerId: eligibility.providerId,
        memberId: eligibility.memberId,
        patientId: eligibility.patientId,
        eligibilityId,
        requestedAmount: centsToAmount(requestedCents),
        requestReference: text(req.body?.requestReference, 'Authorization request reference', 160),
        requestNote,
        requestedById: userId,
      },
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_AUTHORIZATION_REQUESTED',
      metadata: { authorizationId: authorization.id, eligibilityId, requestedAmount: centsToAmount(requestedCents) },
      ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { authorization } });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.recordAuthorizationResponse = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const authorizationId = validId(req.params.authorizationId, 'Authorization ID');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['approved', 'partially_approved', 'rejected'].includes(status)) {
      return fail(res, 400, 'PHARMACY_INSURANCE_AUTHORIZATION_STATUS_INVALID', 'Record an approved, partially approved, or rejected insurer response.');
    }
    const responseNote = text(req.body?.responseNote, 'Authorization response note', 1000, { required: true, min: 5 });
    const scopedAuthorization = await dbClient().pharmacyInsuranceAuthorization.findFirst({
      where: { id: authorizationId, companyId, eligibility: { invoice: { registerId, status: 'PENDING_PAYMENT' } } },
    });
    if (!scopedAuthorization) return fail(res, 404, 'PHARMACY_INSURANCE_AUTHORIZATION_NOT_FOUND', 'The authorization request is not available for this Pharmacy register.');
    if (scopedAuthorization.status !== 'requested') {
      return fail(res, 409, 'PHARMACY_INSURANCE_AUTHORIZATION_ALREADY_RESOLVED', 'This authorization already has a recorded insurer response.');
    }
    const authorizedCents = moneyCents(req.body?.authorizedAmount, 'Authorized amount');
    const requestedCents = moneyCents(scopedAuthorization.requestedAmount, 'Requested amount', { allowZero: false });
    if (authorizedCents > requestedCents
      || status === 'approved' && authorizedCents !== requestedCents
      || status === 'partially_approved' && (authorizedCents <= 0 || authorizedCents >= requestedCents)
      || status === 'rejected' && authorizedCents !== 0) {
      return fail(res, 400, 'PHARMACY_INSURANCE_AUTHORIZATION_AMOUNT_INVALID', 'The recorded amount does not match the insurer decision.');
    }
    const updatedCount = await dbClient().pharmacyInsuranceAuthorization.updateMany({
      where: {
        id: authorizationId,
        companyId,
        status: 'requested',
        eligibility: { invoice: { registerId, status: 'PENDING_PAYMENT' } },
      },
      data: {
        status,
        authorizedAmount: centsToAmount(authorizedCents),
        authorizationReference: text(req.body?.authorizationReference, 'Authorization reference', 160),
        responseNote,
        respondedById: userId,
        respondedAt: new Date(),
        expiresAt: validDate(req.body?.expiresAt, 'Authorization expiry'),
      },
    });
    if (updatedCount.count !== 1) {
      return fail(res, 409, 'PHARMACY_INSURANCE_AUTHORIZATION_ALREADY_RESOLVED', 'This authorization has already been updated.');
    }
    const updated = await dbClient().pharmacyInsuranceAuthorization.findFirst({
      where: { id: authorizationId, companyId },
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_AUTHORIZATION_RESPONSE_RECORDED',
      metadata: { authorizationId, status, authorizedAmount: centsToAmount(authorizedCents) },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { authorization: updated } });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.listPendingSales = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const invoices = await dbClient().invoice.findMany({
      where: { companyId, registerId, posOrigin: true, status: 'PENDING_PAYMENT' },
      select: {
        id: true,
        referenceNo: true,
        totalAmount: true,
        createdAt: true,
        posCheckoutPayload: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const patientIds = [...new Set(invoices
      .map((invoice) => String(invoice.posCheckoutPayload?.pharmacyPatientId || ''))
      .filter((id) => ID_PATTERN.test(id)))];
    const patients = patientIds.length
      ? await dbClient().pharmacyPatient.findMany({
        where: { companyId, registerId, id: { in: patientIds } },
        select: { id: true, patientCode: true, fullName: true },
      })
      : [];
    const patientById = new Map(patients.map((patient) => [String(patient.id), patient]));
    return res.json({
      success: true,
      data: {
        sales: invoices.map((invoice) => {
          const patientId = String(invoice.posCheckoutPayload?.pharmacyPatientId || '');
          const patient = patientById.get(patientId);
          return {
            id: invoice.id,
            referenceNo: invoice.referenceNo,
            totalAmount: invoice.totalAmount,
            createdAt: invoice.createdAt,
            patient: patient ? { id: patient.id, patientCode: patient.patientCode, fullName: patient.fullName } : null,
          };
        }),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.listClaims = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const prisma = dbClient();
    const claims = await prisma.pharmacyInsuranceClaim.findMany({
      where: { companyId, invoice: { registerId } },
      include: {
        provider: { select: { id: true, code: true, name: true, submissionInstructions: true } },
        member: { select: { id: true, memberNumber: true, policyNumber: true } },
        patient: { select: { id: true, fullName: true, patientCode: true } },
        invoice: { select: { id: true, referenceNo: true, totalAmount: true, invoiceDate: true } },
        lines: { include: { invoiceLine: { select: { productName: true, productCode: true } } } },
        attempts: { orderBy: { attemptNumber: 'desc' } },
        settlements: { orderBy: { settlementDate: 'desc' } },
        adjustments: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    const recoverableEligibilities = await prisma.pharmacyInsuranceEligibility.findMany({
      where: {
        companyId,
        status: 'eligible',
        claims: { none: {} },
        invoice: {
          registerId,
          posOrigin: true,
          status: { notIn: ['PENDING_PAYMENT', 'draft', 'cancelled'] },
        },
      },
      include: {
        invoice: { select: { id: true, referenceNo: true, totalAmount: true, invoiceDate: true } },
        provider: { select: { id: true, code: true, name: true, requiresPreauthorization: true, submissionInstructions: true } },
        member: { select: { id: true, memberNumber: true, policyNumber: true } },
        patient: { select: { id: true, fullName: true, patientCode: true } },
        authorizations: {
          where: { status: { in: ['approved', 'partially_approved'] } },
          orderBy: { respondedAt: 'desc' },
          take: 1,
          select: { id: true, authorizedAmount: true },
        },
      },
      orderBy: [{ checkedAt: 'desc' }],
      take: 50,
    });
    return res.json({
      success: true,
      data: {
        claims: claims.map((claim) => ({
          ...claim,
          outstandingAmount: centsToAmount(claimBalance({
            claimAmount: claim.approvedAmount == null ? claim.claimAmount : claim.approvedAmount,
            settledAmount: claim.settledAmount,
            adjustedAmount: claim.adjustedAmount,
          }).outstandingCents),
        })),
        recoverableSales: recoverableEligibilities.map((eligibility) => ({
          invoiceId: eligibility.invoice.id,
          eligibilityId: eligibility.id,
          authorizationId: eligibility.authorizations[0]?.id || null,
          referenceNo: eligibility.invoice.referenceNo,
          totalAmount: eligibility.invoice.totalAmount,
          invoiceDate: eligibility.invoice.invoiceDate,
          coveredAmount: eligibility.coveredAmount,
          copayAmount: eligibility.copayAmount,
          provider: eligibility.provider,
          member: eligibility.member,
          patient: eligibility.patient,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.createClaim = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const invoiceId = validId(req.body?.invoiceId, 'Invoice ID');
    const eligibilityId = validId(req.body?.eligibilityId, 'Eligibility ID');
    const authorizationId = req.body?.authorizationId ? validId(req.body.authorizationId, 'Authorization ID') : null;
    const created = await dbClient().$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, companyId, posOrigin: true, registerId },
        include: { lines: { orderBy: { lineOrder: 'asc' } } },
      });
      if (!invoice || ['PENDING_PAYMENT', 'draft', 'cancelled'].includes(String(invoice.status))) {
        throw Object.assign(new Error('Only a completed Pharmacy sale can be turned into an insurer claim.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_COMPLETED_SALE_REQUIRED',
        });
      }
      const eligibility = await tx.pharmacyInsuranceEligibility.findFirst({
        where: { id: eligibilityId, companyId, invoiceId, invoice: { registerId } },
        include: { provider: true, member: true },
      });
      if (!eligibility || eligibility.status !== 'eligible') {
        throw Object.assign(new Error('An eligible manual insurer response is required before creating a claim.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_ELIGIBILITY_REQUIRED',
        });
      }
      if (!eligibility.provider.isActive || eligibility.member.status !== 'active') {
        throw Object.assign(new Error('The insurer and verified member must remain active to create a claim.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_MEMBER_NOT_ACTIVE',
        });
      }
      if (eligibility.validUntil && eligibility.validUntil < new Date()) {
        throw Object.assign(new Error('The recorded eligibility response has expired.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_ELIGIBILITY_EXPIRED',
        });
      }
      const patientId = String(invoice.posCheckoutPayload?.pharmacyPatientId || '');
      if (!patientId || patientId !== String(eligibility.patientId)) {
        throw Object.assign(new Error('The claim patient does not match the Pharmacy sale.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_PATIENT_MISMATCH',
        });
      }
      const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
      const insurancePaidCents = payments
        .filter((payment) => String(payment?.paymentMethod || '').toLowerCase() === 'insurance')
        .reduce((sum, payment) => sum + moneyCents(payment.amount, 'Insurance payment'), 0);
      const coveredCents = moneyCents(eligibility.coveredAmount, 'Covered amount', { allowZero: false });
      if (insurancePaidCents !== coveredCents) {
        throw Object.assign(new Error('The recorded insurance tender must match the insurer-covered amount exactly.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_TENDER_MISMATCH',
        });
      }
      const totalCents = moneyCents(invoice.totalAmount, 'Invoice total', { allowZero: false });
      const copayCents = moneyCents(eligibility.copayAmount, 'Patient copay');
      if (coveredCents + copayCents !== totalCents) {
        throw Object.assign(new Error('Insurer coverage and patient copay do not reconcile to the invoice total.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_SPLIT_INVALID',
        });
      }
      let authorization = null;
      if (eligibility.provider.requiresPreauthorization) {
        if (!authorizationId) {
          throw Object.assign(new Error('This insurer requires a recorded preauthorization before claim creation.'), {
            statusCode: 409,
            code: 'PHARMACY_INSURANCE_PREAUTH_REQUIRED',
          });
        }
        authorization = await tx.pharmacyInsuranceAuthorization.findFirst({
          where: { id: authorizationId, companyId, eligibilityId, status: { in: ['approved', 'partially_approved'] } },
        });
        if (!authorization
          || moneyCents(authorization.authorizedAmount, 'Authorized amount') < coveredCents
          || authorization.expiresAt && authorization.expiresAt < new Date()) {
          throw Object.assign(new Error('A valid authorization covering the insurer amount is required.'), {
            statusCode: 409,
            code: 'PHARMACY_INSURANCE_PREAUTH_INVALID',
          });
        }
      } else if (authorizationId) {
        authorization = await tx.pharmacyInsuranceAuthorization.findFirst({
          where: { id: authorizationId, companyId, eligibilityId, status: { in: ['approved', 'partially_approved'] } },
        });
        if (!authorization
          || moneyCents(authorization.authorizedAmount, 'Authorized amount') < coveredCents
          || authorization.expiresAt && authorization.expiresAt < new Date()) {
          throw Object.assign(new Error('The selected authorization does not cover this insurer amount.'), {
            statusCode: 409,
            code: 'PHARMACY_INSURANCE_PREAUTH_INVALID',
          });
        }
      }
      const existing = await tx.pharmacyInsuranceClaim.findFirst({ where: { companyId, invoiceId } });
      if (existing) {
        throw Object.assign(new Error('An insurer claim already exists for this invoice.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_ALREADY_EXISTS',
        });
      }
      const claimLines = allocateClaimLines(invoice.lines, copayCents, totalCents);
      const lineIds = claimLines.map((line) => line.invoiceLineId);
      if (lineIds.length !== invoice.lines.length || new Set(lineIds).size !== lineIds.length) {
        throw Object.assign(new Error('The claim lines could not be matched to the Pharmacy invoice.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_INVOICE_LINES_INVALID',
        });
      }
      return tx.pharmacyInsuranceClaim.create({
        data: {
          id: randomBytes(12).toString('hex'),
          companyId,
          providerId: eligibility.providerId,
          memberId: eligibility.memberId,
          patientId,
          invoiceId,
          eligibilityId,
          authorizationId,
          claimNumber: `${eligibility.provider.code}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`,
          status: 'draft',
          grossAmount: centsToAmount(totalCents),
          copayAmount: centsToAmount(copayCents),
          claimAmount: centsToAmount(coveredCents),
          createdById: userId,
          updatedById: userId,
          lines: { create: claimLines.map((line) => ({ id: randomBytes(12).toString('hex'), ...line })) },
        },
        include: { lines: true },
      });
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_CLAIM_CREATED',
      metadata: { claimId: created.id, invoiceId, claimNumber: created.claimNumber, claimAmount: String(created.claimAmount) },
      ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { claim: created } });
  } catch (error) {
    if (handledError(res, error)) return;
    if (error?.code === 'P2002') return fail(res, 409, 'PHARMACY_INSURANCE_CLAIM_ALREADY_EXISTS', 'An insurer claim already exists for this invoice.');
    return next(error);
  }
};

exports.submitClaim = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const claimId = validId(req.params.claimId, 'Claim ID');
    const submitted = await dbClient().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pharmacy_insurance_claims WHERE id = ${claimId} AND company_id = ${companyId} FOR UPDATE`;
      const claim = await tx.pharmacyInsuranceClaim.findFirst({
        where: { id: claimId, companyId, invoice: { registerId } },
      });
      if (!claim || !['draft', 'rejected', 'resubmission_required'].includes(claim.status)) {
        throw Object.assign(new Error('Only a draft or rejected claim can be submitted or resubmitted.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_NOT_SUBMITTABLE',
        });
      }
      const attemptNumber = await tx.pharmacyInsuranceClaimAttempt.count({ where: { claimId, companyId } }) + 1;
      const now = new Date();
      const attempt = await tx.pharmacyInsuranceClaimAttempt.create({
        data: {
          id: randomBytes(12).toString('hex'),
          companyId,
          claimId,
          attemptNumber,
          status: 'submitted',
          reference: text(req.body?.reference, 'Submission reference', 160),
          submittedById: userId,
          submittedAt: now,
        },
      });
      const updatedClaim = await tx.pharmacyInsuranceClaim.update({
        where: { id: claimId },
        data: {
          status: 'submitted',
          rejectionReason: null,
          submittedAt: now,
          resolvedAt: null,
          updatedById: userId,
        },
      });
      return { attempt, claim: updatedClaim };
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_CLAIM_SUBMITTED',
      metadata: { claimId, attemptNumber: submitted.attempt.attemptNumber },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: submitted });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.recordClaimDecision = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const claimId = validId(req.params.claimId, 'Claim ID');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['accepted', 'partially_accepted', 'rejected'].includes(status)) {
      return fail(res, 400, 'PHARMACY_INSURANCE_DECISION_INVALID', 'Record an accepted, partially accepted, or rejected insurer response.');
    }
    const responseNote = text(req.body?.responseNote, 'Insurer response', 1000, { required: true, min: 5 });
    const recorded = await dbClient().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pharmacy_insurance_claims WHERE id = ${claimId} AND company_id = ${companyId} FOR UPDATE`;
      const claim = await tx.pharmacyInsuranceClaim.findFirst({
        where: { id: claimId, companyId, invoice: { registerId } },
      });
      if (!claim || claim.status !== 'submitted') {
        throw Object.assign(new Error('Record a decision only after the claim has been submitted.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_NOT_SUBMITTED',
        });
      }
      const attempt = await tx.pharmacyInsuranceClaimAttempt.findFirst({
        where: { claimId, companyId, status: 'submitted' },
        orderBy: { attemptNumber: 'desc' },
      });
      if (!attempt) {
        throw Object.assign(new Error('The latest claim submission attempt is missing.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_ATTEMPT_MISSING',
        });
      }
      const amountCents = moneyCents(req.body?.responseAmount, 'Insurer-approved amount');
      const claimCents = moneyCents(claim.claimAmount, 'Claim amount', { allowZero: false });
      if (amountCents > claimCents
        || status === 'accepted' && amountCents !== claimCents
        || status === 'partially_accepted' && (amountCents <= 0 || amountCents >= claimCents)
        || status === 'rejected' && amountCents !== 0) {
        throw Object.assign(new Error('The approved amount must match the recorded insurer decision.'), {
          statusCode: 400,
          code: 'PHARMACY_INSURANCE_DECISION_AMOUNT_INVALID',
        });
      }
      const now = new Date();
      const updatedAttempt = await tx.pharmacyInsuranceClaimAttempt.update({
        where: { id: attempt.id },
        data: {
          status,
          responseAmount: centsToAmount(amountCents),
          responseNote,
          reference: text(req.body?.reference, 'Insurer decision reference', 160) || attempt.reference,
          respondedById: userId,
          respondedAt: now,
        },
      });
      const updatedClaim = await tx.pharmacyInsuranceClaim.update({
        where: { id: claimId },
        data: {
          status,
          approvedAmount: centsToAmount(amountCents),
          rejectionReason: status === 'rejected' || status === 'partially_accepted' ? responseNote : null,
          resolvedAt: now,
          updatedById: userId,
        },
      });
      return { attempt: updatedAttempt, claim: updatedClaim };
    });
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PHARMACY_INSURANCE_CLAIM_DECISION_RECORDED',
      metadata: { claimId, status, approvedAmount: String(recorded.claim.approvedAmount || 0) },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: recorded });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.recordSettlement = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const claimId = validId(req.params.claimId, 'Claim ID');
    const idempotencyKey = text(req.body?.idempotencyKey, 'Idempotency key', 100, { required: true, min: 8 });
    const amountCents = moneyCents(req.body?.amount, 'Settlement amount', { allowZero: false });
    const reference = text(req.body?.reference, 'Settlement reference', 160);
    const note = text(req.body?.note, 'Settlement note', 1000);
    const settlementDate = validDate(req.body?.settlementDate, 'Settlement date', { required: true });
    const result = await dbClient().$transaction(async (tx) => {
      const replay = await tx.pharmacyInsuranceSettlement.findUnique({
        where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      });
      if (replay) {
        if (String(replay.claimId) !== claimId || moneyCents(replay.amount, 'Settlement amount') !== amountCents) {
          throw Object.assign(new Error('This settlement request key was already used for a different payment.'), {
            statusCode: 409,
            code: 'PHARMACY_INSURANCE_SETTLEMENT_IDEMPOTENCY_CONFLICT',
          });
        }
        return { settlement: replay, replayed: true };
      }
      await tx.$queryRaw`SELECT id FROM pharmacy_insurance_claims WHERE id = ${claimId} AND company_id = ${companyId} FOR UPDATE`;
      const claim = await tx.pharmacyInsuranceClaim.findFirst({
        where: { id: claimId, companyId, invoice: { registerId } },
      });
      if (!claim || !['accepted', 'partially_accepted', 'partially_settled'].includes(claim.status)
        || claim.approvedAmount == null) {
        throw Object.assign(new Error('An accepted claim is required before recording insurer payment.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_NOT_ACCEPTED',
        });
      }
      const balance = claimBalance({
        claimAmount: claim.approvedAmount,
        settledAmount: claim.settledAmount,
        adjustedAmount: claim.adjustedAmount,
      });
      if (amountCents > balance.outstandingCents) {
        throw Object.assign(new Error('The insurer payment exceeds the approved claim balance.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_SETTLEMENT_EXCEEDS_BALANCE',
        });
      }
      const settlement = await tx.pharmacyInsuranceSettlement.create({
        data: {
          id: randomBytes(12).toString('hex'),
          companyId,
          claimId,
          amount: centsToAmount(amountCents),
          settlementDate,
          reference,
          note,
          idempotencyKey,
          recordedById: userId,
        },
      });
      const bankAccount = await resolveInsuranceAccount(
        companyId,
        registerId,
        'cashAtBank',
        'cash',
        'cashAtBank',
        DEFAULT_ACCOUNTS.cashAtBank,
      );
      const receivableAccount = await resolveInsuranceAccount(
        companyId,
        registerId,
        'accountsReceivable',
        'sales',
        'accountsReceivable',
        DEFAULT_ACCOUNTS.accountsReceivable,
      );
      const description = `Pharmacy insurance settlement ${claim.claimNumber}`;
      const posting = await posAccountingPostingService.postOrQueue({
        tx,
        companyId,
        userId,
        sourceType: 'pos_pharmacy_insurance_settlement',
        sourceId: settlement.id,
        metadata: { claimId, settlementId: settlement.id, amount: centsToAmount(amountCents) },
        entries: [{
          date: settlementDate,
          description,
          sourceType: 'pos_pharmacy_insurance_settlement',
          sourceId: settlement.id,
          sourceReference: reference || claim.claimNumber,
          lines: [
            JournalService.createDebitLine(bankAccount, centsToAmount(amountCents), description),
            JournalService.createCreditLine(receivableAccount, centsToAmount(amountCents), description),
          ],
          isAutoGenerated: true,
          sourceData: { claimId, settlementId: settlement.id, amount: centsToAmount(amountCents), reference },
        }],
      });
      const recordedSettlement = await tx.pharmacyInsuranceSettlement.update({
        where: { id: settlement.id },
        data: {
          journalEntryId: posting.journalEntryIds[0] || null,
          postingStatus: posting.status,
        },
      });
      const settledCents = balance.settledCents + amountCents;
      const status = settledCents + balance.adjustedCents >= moneyCents(claim.approvedAmount, 'Approved amount')
        ? 'settled'
        : 'partially_settled';
      const updatedClaim = await tx.pharmacyInsuranceClaim.update({
        where: { id: claimId },
        data: {
          settledAmount: centsToAmount(moneyCents(claim.settledAmount, 'Settled amount') + amountCents),
          status,
          updatedById: userId,
        },
      });
      return { settlement: recordedSettlement, claim: updatedClaim, replayed: false };
    });
    if (!result.replayed) {
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'PHARMACY_INSURANCE_SETTLEMENT_RECORDED',
        metadata: { claimId, amount: centsToAmount(amountCents), settlementId: result.settlement.id },
        ip: requestIp(req),
      });
    }
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

exports.recordAdjustment = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = context(req);
    const claimId = validId(req.params.claimId, 'Claim ID');
    const idempotencyKey = text(req.body?.idempotencyKey, 'Idempotency key', 100, { required: true, min: 8 });
    const amountCents = moneyCents(req.body?.amount, 'Adjustment amount', { allowZero: false });
    const reason = text(req.body?.reason, 'Adjustment reason', 1000, { required: true, min: 10 });
    const reference = text(req.body?.reference, 'Refund reference', 160);
    const result = await dbClient().$transaction(async (tx) => {
      const replay = await tx.pharmacyInsuranceClaimAdjustment.findUnique({
        where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      });
      if (replay) {
        if (String(replay.claimId) !== claimId || moneyCents(replay.amount, 'Adjustment amount') !== amountCents) {
          throw Object.assign(new Error('This adjustment request key was already used for different claim details.'), {
            statusCode: 409,
            code: 'PHARMACY_INSURANCE_ADJUSTMENT_IDEMPOTENCY_CONFLICT',
          });
        }
        return { adjustment: replay, replayed: true };
      }
      await tx.$queryRaw`SELECT id FROM pharmacy_insurance_claims WHERE id = ${claimId} AND company_id = ${companyId} FOR UPDATE`;
      const claim = await tx.pharmacyInsuranceClaim.findFirst({
        where: { id: claimId, companyId, invoice: { registerId } },
      });
      if (!claim || !['accepted', 'partially_accepted', 'partially_settled'].includes(claim.status)
        || claim.approvedAmount == null) {
        throw Object.assign(new Error('Only an accepted insurer claim can be adjusted.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_CLAIM_NOT_ACCEPTED',
        });
      }
      const balance = claimBalance({
        claimAmount: claim.approvedAmount,
        settledAmount: claim.settledAmount,
        adjustedAmount: claim.adjustedAmount,
      });
      if (amountCents > balance.outstandingCents) {
        throw Object.assign(new Error('A refund adjustment cannot exceed the remaining approved insurer balance.'), {
          statusCode: 409,
          code: 'PHARMACY_INSURANCE_ADJUSTMENT_EXCEEDS_BALANCE',
        });
      }
      const adjustment = await tx.pharmacyInsuranceClaimAdjustment.create({
        data: {
          id: randomBytes(12).toString('hex'),
          companyId,
          claimId,
          amount: centsToAmount(amountCents),
          reason,
          reference,
          idempotencyKey,
          recordedById: userId,
        },
      });
      const receivableAccount = await resolveInsuranceAccount(
        companyId,
        registerId,
        'accountsReceivable',
        'sales',
        'accountsReceivable',
        DEFAULT_ACCOUNTS.accountsReceivable,
      );
      const adjustmentAccount = await JournalService.getMappedAccountCode(
        companyId,
        'expenses',
        'badDebt',
        DEFAULT_ACCOUNTS.badDebt,
      );
      const description = `Pharmacy insurance claim adjustment ${claim.claimNumber}`;
      const posting = await posAccountingPostingService.postOrQueue({
        tx,
        companyId,
        userId,
        sourceType: 'pos_pharmacy_insurance_adjustment',
        sourceId: adjustment.id,
        metadata: { claimId, adjustmentId: adjustment.id, amount: centsToAmount(amountCents), reason },
        entries: [{
          date: new Date(),
          description,
          sourceType: 'pos_pharmacy_insurance_adjustment',
          sourceId: adjustment.id,
          sourceReference: reference || claim.claimNumber,
          lines: [
            JournalService.createDebitLine(adjustmentAccount, centsToAmount(amountCents), description),
            JournalService.createCreditLine(receivableAccount, centsToAmount(amountCents), description),
          ],
          isAutoGenerated: true,
          notes: reason,
          sourceData: { claimId, adjustmentId: adjustment.id, amount: centsToAmount(amountCents), reference, reason },
        }],
      });
      const recordedAdjustment = await tx.pharmacyInsuranceClaimAdjustment.update({
        where: { id: adjustment.id },
        data: {
          journalEntryId: posting.journalEntryIds[0] || null,
          postingStatus: posting.status,
        },
      });
      const adjustedCents = balance.adjustedCents + amountCents;
      const settledCents = balance.settledCents;
      const status = adjustedCents + settledCents >= moneyCents(claim.approvedAmount, 'Approved amount')
        ? 'adjusted'
        : claim.status;
      const updatedClaim = await tx.pharmacyInsuranceClaim.update({
        where: { id: claimId },
        data: {
          adjustedAmount: centsToAmount(moneyCents(claim.adjustedAmount, 'Adjusted amount') + amountCents),
          status,
          updatedById: userId,
        },
      });
      return { adjustment: recordedAdjustment, claim: updatedClaim, replayed: false };
    });
    if (!result.replayed) {
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'PHARMACY_INSURANCE_CLAIM_ADJUSTED',
        metadata: { claimId, amount: centsToAmount(amountCents), adjustmentId: result.adjustment.id, reason },
        ip: requestIp(req),
      });
    }
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    if (handledError(res, error)) return;
    return next(error);
  }
};

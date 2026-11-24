'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { normalizeSettings } = require('../services/posPharmacySettingsService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

const ALLOWED_STATUSES = new Set([
  'pending_review',
  'approved',
  'on_hold',
  'partially_dispensed',
  'dispensed',
  'cancelled',
  'rejected',
]);

class PharmacyWorkflowError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

function contextFor(req) {
  const context = req.posAuthContext;
  if (!context?.company?.id || !context?.register?.id || !context?.user?.id) {
    throw new PharmacyWorkflowError(401, 'POS_SESSION_INVALID', 'Sign in to this Pharmacy register again.');
  }
  return {
    companyId: String(context.company.id),
    registerId: String(context.register.id),
    userId: String(context.user.id),
  };
}

function sendWorkflowError(res, error) {
  if (!(error instanceof PharmacyWorkflowError)) return false;
  return res.status(error.status).json({
    success: false,
    code: error.code,
    message: error.message,
    ...(error.errors ? { errors: error.errors } : {}),
  });
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function text(value, maximumLength) {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function quantityUnits(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) return null;
  const units = Math.round(number * 10_000);
  return Math.abs(number * 10_000 - units) < 0.000001 ? units : null;
}

function quantityString(units) {
  return (units / 10_000).toFixed(4);
}

function pharmacyFields(product) {
  const fields = product?.customFields;
  const pharmacy = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields.pharmacy
    : null;
  return pharmacy && typeof pharmacy === 'object' && !Array.isArray(pharmacy) ? pharmacy : null;
}

function medicineForSearch(product) {
  const pharmacy = pharmacyFields(product);
  if (!pharmacy) return null;
  const status = String(pharmacy.prescriptionStatus || 'OTC').trim().toUpperCase();
  if (!['PRESCRIPTION', 'RESTRICTED'].includes(status)) return null;
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    genericName: text(pharmacy.genericName, 180),
    strength: text(pharmacy.strength, 80),
    dosageForm: text(pharmacy.dosageForm, 48),
    prescriptionStatus: status,
    controlled: pharmacy.restrictedStatus === true || status === 'RESTRICTED',
  };
}

function audit(req, context, event, entityType, entityId, metadata, client = prisma) {
  return writePosAuditLog({
    ...context,
    userId: context.userId,
    event,
    entityType,
    entityId,
    metadata,
    ip: requestIp(req),
  }, client);
}

function activeFill(prescription) {
  return prescription?.fills?.[0] || null;
}

function dispensedQuantityUnits(fill) {
  const totals = new Map();
  for (const dispense of fill?.dispenses || []) {
    for (const line of dispense.lines || []) {
      const units = quantityUnits(line.quantity);
      if (units === null) continue;
      totals.set(line.prescriptionLineId, (totals.get(line.prescriptionLineId) || 0) + units);
    }
  }
  return totals;
}

function publicPrescription(prescription) {
  if (!prescription) return null;
  const fill = activeFill(prescription);
  const dispensedQuantities = dispensedQuantityUnits(fill);
  return {
    id: prescription.id,
    prescriptionNumber: prescription.prescriptionNumber,
    prescriberName: prescription.prescriberName,
    prescriberLicense: prescription.prescriberLicense,
    issueDate: prescription.issueDate,
    expiryDate: prescription.expiryDate,
    status: prescription.status,
    refillsAuthorized: prescription.refillsAuthorized,
    refillsUsed: prescription.refillsUsed,
    createdAt: prescription.createdAt,
    patient: prescription.patient ? {
      id: prescription.patient.id,
      patientCode: prescription.patient.patientCode,
      fullName: prescription.patient.fullName,
      phone: prescription.patient.phone,
      dateOfBirth: prescription.patient.dateOfBirth,
    } : undefined,
    lines: (prescription.lines || []).map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      genericName: line.genericName,
      strength: line.strength,
      dosageForm: line.dosageForm,
      prescriptionStatus: line.prescriptionStatus,
      controlled: line.controlled,
      prescribedQuantity: String(line.prescribedQuantity),
      dosageInstructions: line.dosageInstructions,
      substitutionAllowed: line.substitutionAllowed,
    })),
    currentFill: fill ? {
      id: fill.id,
      fillNumber: fill.fillNumber,
      status: fill.status,
      reviewedById: fill.reviewedById,
      reviewedAt: fill.reviewedAt,
      reviewNote: fill.reviewNote,
      holdReason: fill.holdReason,
      dispensedQuantities: Object.fromEntries([...dispensedQuantities].map(([lineId, units]) =>
        [lineId, quantityString(units)])),
    } : null,
  };
}

async function findPrescription(context, prescriptionId, client = prisma) {
  return client.pharmacyPrescription.findFirst({
    where: {
      id: String(prescriptionId || ''),
      companyId: context.companyId,
      registerId: context.registerId,
    },
    include: {
      patient: {
        select: { id: true, patientCode: true, fullName: true, phone: true, dateOfBirth: true },
      },
      lines: true,
      fills: {
        orderBy: { fillNumber: 'desc' },
        take: 1,
        include: {
          dispenses: {
            select: {
              lines: { select: { prescriptionLineId: true, quantity: true, suppliedProductName: true } },
            },
          },
        },
      },
    },
  });
}

exports.listPatients = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const query = text(req.query?.q, 80);
    if (query.length < 2) {
      return res.status(400).json({ success: false, code: 'PHARMACY_SEARCH_TOO_SHORT', message: 'Enter at least 2 characters to search patients.' });
    }
    const patients = await prisma.pharmacyPatient.findMany({
      where: {
        companyId: context.companyId,
        registerId: context.registerId,
        OR: [
          { fullName: { contains: query, mode: 'insensitive' } },
          { patientCode: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query } },
        ],
      },
      select: { id: true, patientCode: true, fullName: true, phone: true, dateOfBirth: true },
      orderBy: { fullName: 'asc' },
      take: 30,
    });
    return res.json({ success: true, data: patients });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.createPatient = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const fullName = text(req.body?.fullName, 160);
    const phone = text(req.body?.phone, 40) || null;
    const birthDateValue = req.body?.dateOfBirth ? String(req.body.dateOfBirth) : '';
    const dateOfBirth = birthDateValue ? dateOnly(birthDateValue) : null;
    const errors = [];
    if (fullName.length < 2) errors.push({ field: 'fullName', message: 'Enter the patient’s full name.' });
    if (birthDateValue && !dateOfBirth) errors.push({ field: 'dateOfBirth', message: 'Enter a valid date of birth.' });
    if (dateOfBirth && dateOfBirth > new Date(new Date().toISOString().slice(0, 10))) {
      errors.push({ field: 'dateOfBirth', message: 'Date of birth cannot be in the future.' });
    }
    if (errors.length) {
      return res.status(422).json({ success: false, code: 'PHARMACY_PATIENT_INVALID', message: 'Review the highlighted patient details.', errors });
    }

    if (phone) {
      const duplicate = await prisma.pharmacyPatient.findFirst({
        where: {
          companyId: context.companyId,
          registerId: context.registerId,
          phone,
          fullName: { equals: fullName, mode: 'insensitive' },
        },
        select: { id: true, patientCode: true },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          code: 'PHARMACY_PATIENT_DUPLICATE',
          message: `A patient with this name and phone already exists (${duplicate.patientCode}). Select the existing profile instead.`,
        });
      }
    }

    const id = generateObjectId();
    const patient = await prisma.$transaction(async (tx) => {
      const created = await tx.pharmacyPatient.create({
        data: {
          id,
          ...context,
          patientCode: `PAT-${id.slice(-8).toUpperCase()}`,
          fullName,
          phone,
          dateOfBirth,
          createdById: context.userId,
        },
        select: { id: true, patientCode: true, fullName: true, phone: true, dateOfBirth: true },
      });
      await audit(req, context, 'PHARMACY_PATIENT_CREATED', 'pharmacy_patient', id, {}, tx);
      return created;
    });
    return res.status(201).json({ success: true, data: patient });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.searchPrescriptionProducts = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const query = text(req.query?.q, 80);
    if (query.length < 2) {
      return res.status(400).json({ success: false, code: 'PHARMACY_SEARCH_TOO_SHORT', message: 'Enter at least 2 characters to search medicines.' });
    }
    const products = await prisma.product.findMany({
      where: {
        companyId: context.companyId,
        isActive: true,
        isArchived: false,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { sku: { contains: query, mode: 'insensitive' } },
          { barcode: { contains: query } },
        ],
      },
      select: { id: true, name: true, sku: true, customFields: true },
      take: 100,
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, data: products.map(medicineForSearch).filter(Boolean).slice(0, 30) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.listPrescriptions = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const status = text(req.query?.status, 24);
    if (status && !ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ success: false, code: 'PHARMACY_PRESCRIPTION_STATUS_INVALID', message: 'Choose a valid prescription status filter.' });
    }
    const prescriptions = await prisma.pharmacyPrescription.findMany({
      where: {
        companyId: context.companyId,
        registerId: context.registerId,
        ...(status ? { status } : {}),
      },
      include: {
        patient: { select: { id: true, patientCode: true, fullName: true, phone: true, dateOfBirth: true } },
        lines: true,
        fills: {
          orderBy: { fillNumber: 'desc' },
          take: 1,
          include: {
            dispenses: {
              select: {
                lines: { select: { prescriptionLineId: true, quantity: true, suppliedProductName: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ success: true, data: prescriptions.map(publicPrescription) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.createPrescription = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const patientId = text(req.body?.patientId, 24);
    const prescriptionNumber = text(req.body?.prescriptionNumber, 80);
    const prescriberName = text(req.body?.prescriberName, 160);
    const prescriberLicense = text(req.body?.prescriberLicense, 80);
    const issueDate = dateOnly(req.body?.issueDate);
    const expiryDate = dateOnly(req.body?.expiryDate);
    const refillValue = req.body?.refillsAuthorized == null || req.body.refillsAuthorized === ''
      ? 0
      : Number(req.body.refillsAuthorized);
    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const errors = [];
    if (!patientId) errors.push({ field: 'patientId', message: 'Select a patient.' });
    if (prescriptionNumber.length < 2) errors.push({ field: 'prescriptionNumber', message: 'Enter the prescription reference.' });
    if (prescriberName.length < 2) errors.push({ field: 'prescriberName', message: 'Enter the prescriber’s name.' });
    if (prescriberLicense.length < 2) errors.push({ field: 'prescriberLicense', message: 'Enter the prescriber’s licence or registration reference.' });
    if (!issueDate) errors.push({ field: 'issueDate', message: 'Enter a valid issue date.' });
    if (!expiryDate) errors.push({ field: 'expiryDate', message: 'Enter a valid expiry date.' });
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    if (issueDate && issueDate > today) errors.push({ field: 'issueDate', message: 'Issue date cannot be in the future.' });
    if (issueDate && expiryDate && expiryDate < issueDate) errors.push({ field: 'expiryDate', message: 'Expiry date cannot be before the issue date.' });
    if (expiryDate && expiryDate < today) errors.push({ field: 'expiryDate', message: 'This prescription is expired.' });
    if (!Number.isInteger(refillValue) || refillValue < 0 || refillValue > 100) {
      errors.push({ field: 'refillsAuthorized', message: 'Enter a whole number of authorized refills from 0 to 100.' });
    }
    if (rawLines.length < 1 || rawLines.length > 20) errors.push({ field: 'lines', message: 'Add between 1 and 20 prescription lines.' });

    const lines = rawLines.map((line, index) => {
      const productId = text(line?.productId, 24);
      const dosageInstructions = text(line?.dosageInstructions, 500);
      const amount = quantityUnits(line?.prescribedQuantity);
      if (!productId) errors.push({ field: `lines.${index}.productId`, message: 'Select a medicine.' });
      if (amount === null) errors.push({ field: `lines.${index}.prescribedQuantity`, message: 'Enter a positive quantity with up to 4 decimal places.' });
      if (dosageInstructions.length < 2) errors.push({ field: `lines.${index}.dosageInstructions`, message: 'Enter the prescriber’s dosage instructions.' });
      return {
        productId,
        dosageInstructions,
        quantity: amount,
        substitutionAllowed: line?.substitutionAllowed === true,
      };
    });
    if (new Set(lines.map((line) => line.productId).filter(Boolean)).size !== lines.filter((line) => line.productId).length) {
      errors.push({ field: 'lines', message: 'The same medicine appears more than once. Combine its quantity into one line.' });
    }
    if (errors.length) {
      return res.status(422).json({ success: false, code: 'PHARMACY_PRESCRIPTION_INVALID', message: 'This prescription cannot be saved yet. Review the listed issues.', errors });
    }

    const [patient, products, duplicate] = await Promise.all([
      prisma.pharmacyPatient.findFirst({
        where: { id: patientId, companyId: context.companyId, registerId: context.registerId },
        select: { id: true },
      }),
      prisma.product.findMany({
        where: {
          id: { in: lines.map((line) => line.productId) },
          companyId: context.companyId,
          isActive: true,
          isArchived: false,
        },
        select: { id: true, name: true, customFields: true },
      }),
      prisma.pharmacyPrescription.findFirst({
        where: { companyId: context.companyId, registerId: context.registerId, prescriptionNumber },
        select: { id: true },
      }),
    ]);
    if (!patient) {
      return res.status(422).json({ success: false, code: 'PHARMACY_PATIENT_NOT_FOUND', message: 'The selected patient is not available on this Pharmacy register.' });
    }
    if (duplicate) {
      return res.status(409).json({ success: false, code: 'PHARMACY_PRESCRIPTION_DUPLICATE', message: 'This prescription reference already exists on this register. Check the original before continuing.' });
    }

    const productsById = new Map(products.map((product) => [product.id, product]));
    const preparedLines = [];
    for (const [index, line] of lines.entries()) {
      const product = productsById.get(line.productId);
      const pharmacy = pharmacyFields(product);
      const medicine = medicineForSearch(product);
      if (!medicine || !pharmacy || !product) {
        errors.push({ field: `lines.${index}.productId`, message: 'Choose an active Pharmacy medicine that requires a prescription.' });
        continue;
      }
      const genericName = text(pharmacy.genericName, 180);
      const strength = text(pharmacy.strength, 80);
      const dosageForm = text(pharmacy.dosageForm, 48);
      if (!genericName || !strength || !dosageForm) {
        errors.push({ field: `lines.${index}.productId`, message: 'This medicine needs a generic name, strength, and dosage form before it can be prescribed.' });
        continue;
      }
      preparedLines.push({
        id: generateObjectId(),
        productId: product.id,
        productName: product.name,
        genericName,
        strength,
        dosageForm,
        prescriptionStatus: medicine.prescriptionStatus,
        controlled: medicine.controlled,
        prescribedQuantity: quantityString(line.quantity),
        dosageInstructions: line.dosageInstructions,
        substitutionAllowed: line.substitutionAllowed,
      });
    }
    if (errors.length) {
      return res.status(422).json({ success: false, code: 'PHARMACY_PRESCRIPTION_INVALID', message: 'This prescription includes invalid or incomplete medicine details.', errors });
    }

    const prescriptionId = generateObjectId();
    const fillId = generateObjectId();
    const prescription = await prisma.$transaction(async (tx) => {
      const created = await tx.pharmacyPrescription.create({
        data: {
          id: prescriptionId,
          companyId: context.companyId,
          registerId: context.registerId,
          patientId,
          prescriptionNumber,
          prescriberName,
          prescriberLicense,
          issueDate,
          expiryDate,
          status: 'pending_review',
          refillsAuthorized: refillValue,
          createdById: context.userId,
          lines: { create: preparedLines },
          fills: {
            create: {
              id: fillId,
              companyId: context.companyId,
              registerId: context.registerId,
              fillNumber: 1,
              status: 'pending_review',
            },
          },
        },
        include: {
          patient: { select: { id: true, patientCode: true, fullName: true, phone: true, dateOfBirth: true } },
          lines: true,
          fills: { orderBy: { fillNumber: 'desc' }, take: 1 },
        },
      });
      await audit(req, context, 'PHARMACY_PRESCRIPTION_CREATED', 'pharmacy_prescription', prescriptionId, {
        lineCount: preparedLines.length,
        controlledLineCount: preparedLines.filter((line) => line.controlled).length,
      }, tx);
      return created;
    });
    return res.status(201).json({ success: true, data: publicPrescription(prescription) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'PHARMACY_PRESCRIPTION_DUPLICATE', message: 'This prescription reference already exists. Check the original before continuing.' });
    }
    return next(error);
  }
};

exports.reviewPrescription = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    const reviewNote = text(req.body?.reviewNote, 500);
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(422).json({ success: false, code: 'PHARMACY_REVIEW_INVALID', message: 'Choose approve or reject.' });
    }
    if (decision === 'reject' && reviewNote.length < 3) {
      return res.status(422).json({ success: false, code: 'PHARMACY_REVIEW_NOTE_REQUIRED', message: 'Add a short reason when rejecting a prescription.' });
    }
    if (!['pending_review', 'on_hold'].includes(fill.status)) {
      return res.status(409).json({ success: false, code: 'PHARMACY_REVIEW_NOT_ALLOWED', message: 'Only a pending or held prescription can be reviewed.' });
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.pharmacyPrescriptionFill.updateMany({
        where: { id: fill.id, companyId: context.companyId, registerId: context.registerId, status: fill.status },
        data: {
          status,
          reviewedById: context.userId,
          reviewedAt: new Date(),
          reviewNote: reviewNote || null,
        },
      });
      if (changed.count !== 1) throw new PharmacyWorkflowError(409, 'PHARMACY_REVIEW_CONFLICT', 'This prescription changed while you were reviewing it. Refresh and check its current status.');
      await tx.pharmacyPrescription.update({
        where: { id: prescription.id },
        data: { status },
      });
      await audit(req, context, 'PHARMACY_PRESCRIPTION_REVIEWED', 'pharmacy_prescription', prescription.id, {
        fillNumber: fill.fillNumber,
        decision,
      }, tx);
      return findPrescription(context, prescription.id, tx);
    });
    return res.json({ success: true, data: publicPrescription(updated) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.holdPrescription = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    const reason = text(req.body?.reason, 500);
    if (reason.length < 3) return res.status(422).json({ success: false, code: 'PHARMACY_HOLD_REASON_REQUIRED', message: 'Add a reason before putting this prescription on hold.' });
    if (!['pending_review', 'approved', 'partially_dispensed'].includes(fill.status)) {
      return res.status(409).json({ success: false, code: 'PHARMACY_HOLD_NOT_ALLOWED', message: 'This prescription cannot be put on hold in its current state.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.pharmacyPrescriptionFill.updateMany({
        where: { id: fill.id, companyId: context.companyId, registerId: context.registerId, status: fill.status },
        data: { status: 'on_hold', heldById: context.userId, heldAt: new Date(), holdReason: reason },
      });
      if (changed.count !== 1) throw new PharmacyWorkflowError(409, 'PHARMACY_HOLD_CONFLICT', 'This prescription changed. Refresh and try again.');
      await tx.pharmacyPrescription.update({ where: { id: prescription.id }, data: { status: 'on_hold' } });
      await audit(req, context, 'PHARMACY_PRESCRIPTION_HELD', 'pharmacy_prescription', prescription.id, {
        fillNumber: fill.fillNumber,
      }, tx);
      return findPrescription(context, prescription.id, tx);
    });
    return res.json({ success: true, data: publicPrescription(updated) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.cancelPrescription = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    const reason = text(req.body?.reason, 500);
    if (reason.length < 3) return res.status(422).json({ success: false, code: 'PHARMACY_CANCEL_REASON_REQUIRED', message: 'Add a reason before cancelling this prescription.' });
    if (['cancelled', 'dispensed', 'rejected'].includes(fill.status)) {
      return res.status(409).json({ success: false, code: 'PHARMACY_CANCEL_NOT_ALLOWED', message: 'This prescription cannot be cancelled in its current state.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.pharmacyPrescriptionFill.updateMany({
        where: { id: fill.id, companyId: context.companyId, registerId: context.registerId, status: fill.status },
        data: { status: 'cancelled', cancelledById: context.userId, cancelledAt: new Date(), cancelReason: reason },
      });
      if (changed.count !== 1) throw new PharmacyWorkflowError(409, 'PHARMACY_CANCEL_CONFLICT', 'This prescription changed. Refresh and try again.');
      await tx.pharmacyPrescription.update({ where: { id: prescription.id }, data: { status: 'cancelled' } });
      await audit(req, context, 'PHARMACY_PRESCRIPTION_CANCELLED', 'pharmacy_prescription', prescription.id, {
        fillNumber: fill.fillNumber,
      }, tx);
      return findPrescription(context, prescription.id, tx);
    });
    return res.json({ success: true, data: publicPrescription(updated) });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.requestRefill = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    if (prescription.status === 'cancelled' || prescription.expiryDate < new Date(new Date().toISOString().slice(0, 10))) {
      return res.status(409).json({ success: false, code: 'PHARMACY_REFILL_NOT_ALLOWED', message: 'This prescription is cancelled or expired and cannot be refilled.' });
    }
    if (fill.status !== 'dispensed' || prescription.refillsUsed >= prescription.refillsAuthorized) {
      return res.status(409).json({ success: false, code: 'PHARMACY_REFILL_NOT_ALLOWED', message: 'A refill requires a completed fill and an unused refill authorization.' });
    }
    const created = await prisma.$transaction(async (tx) => {
      const current = await tx.pharmacyPrescription.findFirst({
        where: { id: prescription.id, companyId: context.companyId, registerId: context.registerId, status: 'dispensed' },
      });
      if (!current || current.refillsUsed >= current.refillsAuthorized) {
        throw new PharmacyWorkflowError(409, 'PHARMACY_REFILL_CONFLICT', 'The refill authorization changed. Refresh and review the prescription.');
      }
      const nextFillNumber = fill.fillNumber + 1;
      const nextFillId = generateObjectId();
      const fillResult = await tx.pharmacyPrescriptionFill.create({
        data: {
          id: nextFillId,
          companyId: context.companyId,
          registerId: context.registerId,
          prescriptionId: prescription.id,
          fillNumber: nextFillNumber,
          status: 'pending_review',
        },
      });
      await tx.pharmacyPrescription.update({
        where: { id: prescription.id },
        data: { status: 'pending_review' },
      });
      await audit(req, context, 'PHARMACY_PRESCRIPTION_REFILL_REQUESTED', 'pharmacy_prescription', prescription.id, {
        fillNumber: nextFillNumber,
      }, tx);
      return fillResult;
    });
    return res.status(201).json({ success: true, data: { prescriptionId: prescription.id, fillNumber: created.fillNumber, status: created.status } });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.recordDispense = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    if (!['approved', 'partially_dispensed'].includes(fill.status)) {
      return res.status(409).json({ success: false, code: 'PHARMACY_DISPENSE_NOT_APPROVED', message: 'This prescription must be approved and not held, rejected, expired, or cancelled before dispensing.' });
    }
    if (prescription.expiryDate < new Date(new Date().toISOString().slice(0, 10))) {
      return res.status(409).json({ success: false, code: 'PHARMACY_PRESCRIPTION_EXPIRED', message: 'This prescription has expired and cannot be dispensed.' });
    }
    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const errors = [];
    if (!rawLines.length) errors.push({ field: 'lines', message: 'Enter at least one quantity to dispense.' });
    const requestLines = rawLines.map((line, index) => {
      const prescriptionLineId = text(line?.prescriptionLineId, 24);
      const amount = quantityUnits(line?.quantity);
      const substituteProductId = text(line?.substituteProductId, 24);
      const substitutionReason = text(line?.substitutionReason, 300);
      if (!prescriptionLineId) errors.push({ field: `lines.${index}.prescriptionLineId`, message: 'Select a prescription line.' });
      if (amount === null) errors.push({ field: `lines.${index}.quantity`, message: 'Enter a positive quantity with up to 4 decimal places.' });
      if (substituteProductId && substitutionReason.length < 3) errors.push({ field: `lines.${index}.substitutionReason`, message: 'Add a reason for the generic substitution.' });
      return { prescriptionLineId, amount, substituteProductId, substitutionReason };
    });
    if (new Set(requestLines.map((line) => line.prescriptionLineId)).size !== requestLines.length) {
      errors.push({ field: 'lines', message: 'Each prescription line can appear only once in a dispense record.' });
    }
    if (errors.length) {
      return res.status(422).json({ success: false, code: 'PHARMACY_DISPENSE_INVALID', message: 'Review the dispensing quantities and substitutions.', errors });
    }

    const prescriptionLines = new Map((prescription.lines || []).map((line) => [line.id, line]));
    const selectedLines = [];
    let hasControlled = false;
    for (const [index, requested] of requestLines.entries()) {
      const line = prescriptionLines.get(requested.prescriptionLineId);
      if (!line) {
        errors.push({ field: `lines.${index}.prescriptionLineId`, message: 'This medicine is not part of the selected prescription.' });
        continue;
      }
      if (requested.substituteProductId && !line.substitutionAllowed) {
        errors.push({ field: `lines.${index}.substituteProductId`, message: 'The prescriber did not allow generic substitution for this line.' });
        continue;
      }
      hasControlled ||= line.controlled;
      selectedLines.push({ ...requested, line });
    }
    const substituteIds = selectedLines.map((line) => line.substituteProductId).filter(Boolean);
    const substitutes = substituteIds.length ? await prisma.product.findMany({
      where: {
        id: { in: substituteIds },
        companyId: context.companyId,
        isActive: true,
        isArchived: false,
      },
      select: { id: true, name: true, customFields: true },
    }) : [];
    const substitutesById = new Map(substitutes.map((product) => [product.id, product]));
    for (const [index, requested] of selectedLines.entries()) {
      if (!requested.substituteProductId) continue;
      const product = substitutesById.get(requested.substituteProductId);
      const pharmacy = pharmacyFields(product);
      const sameMedicine = Boolean(
        product && pharmacy
        && text(pharmacy.genericName, 180).toLocaleLowerCase() === requested.line.genericName.toLocaleLowerCase()
        && text(pharmacy.strength, 80).toLocaleLowerCase() === requested.line.strength.toLocaleLowerCase()
        && text(pharmacy.dosageForm, 48).toLocaleLowerCase() === requested.line.dosageForm.toLocaleLowerCase(),
      );
      if (!sameMedicine) {
        errors.push({ field: `lines.${index}.substituteProductId`, message: 'Choose an active product with the same generic name, strength, and dosage form.' });
      }
    }
    if (errors.length) {
      return res.status(422).json({ success: false, code: 'PHARMACY_DISPENSE_INVALID', message: 'Review the dispensing quantities and substitutions.', errors });
    }

    const controlledReference = text(req.body?.controlledReference, 120) || null;
    if (hasControlled) {
      const settingsRow = await prisma.systemSettings.findUnique({
        where: { companyId: context.companyId },
        select: { posPharmacySettings: true },
      });
      const pharmacySettings = normalizeSettings(settingsRow?.posPharmacySettings);
      if (!pharmacySettings.profile.controlledMedicineAuthorized) {
        return res.status(403).json({ success: false, code: 'PHARMACY_CONTROLLED_NOT_AUTHORIZED', message: 'Controlled medicines are not enabled in the reviewed Pharmacy profile.' });
      }
      if (fill.reviewedById === context.userId) {
        return res.status(403).json({ success: false, code: 'PHARMACY_CONTROLLED_SECOND_REVIEW_REQUIRED', message: 'A different pharmacist must review controlled-medicine dispensing.' });
      }
      if (!controlledReference || controlledReference.length < 3) {
        return res.status(422).json({ success: false, code: 'PHARMACY_CONTROLLED_REFERENCE_REQUIRED', message: 'Enter the controlled-medicine register reference before dispensing.' });
      }
    }

    const dispenseId = generateObjectId();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${fill.id}))`;
      const currentFill = await tx.pharmacyPrescriptionFill.findFirst({
        where: {
          id: fill.id,
          companyId: context.companyId,
          registerId: context.registerId,
          status: { in: ['approved', 'partially_dispensed'] },
        },
        select: { id: true },
      });
      if (!currentFill) throw new PharmacyWorkflowError(409, 'PHARMACY_DISPENSE_CONFLICT', 'This prescription changed while dispensing. Refresh before continuing.');
      const previousLines = await tx.pharmacyDispenseLine.findMany({
        where: { fillId: fill.id },
        select: { prescriptionLineId: true, quantity: true },
      });
      const dispensedUnits = new Map();
      for (const previous of previousLines) {
        dispensedUnits.set(previous.prescriptionLineId, (dispensedUnits.get(previous.prescriptionLineId) || 0) + quantityUnits(previous.quantity));
      }
      const nextTotals = new Map(dispensedUnits);
      for (const requested of selectedLines) {
        const prescribed = quantityUnits(requested.line.prescribedQuantity);
        const already = dispensedUnits.get(requested.line.id) || 0;
        if (requested.amount > prescribed - already) {
          throw new PharmacyWorkflowError(422, 'PHARMACY_DISPENSE_OVER_QUANTITY', `Dispense quantity exceeds the remaining amount for ${requested.line.productName}.`);
        }
        nextTotals.set(requested.line.id, already + requested.amount);
      }
      const created = await tx.pharmacyDispense.create({
        data: {
          id: dispenseId,
          companyId: context.companyId,
          registerId: context.registerId,
          prescriptionId: prescription.id,
          fillId: fill.id,
          dispensingUserId: context.userId,
          controlledReference: hasControlled ? controlledReference : null,
          lines: {
            create: selectedLines.map((requested) => {
              const substitute = requested.substituteProductId ? substitutesById.get(requested.substituteProductId) : null;
              return {
                id: generateObjectId(),
                fillId: fill.id,
                prescriptionLineId: requested.line.id,
                quantity: quantityString(requested.amount),
                suppliedProductId: substitute?.id || requested.line.productId,
                suppliedProductName: substitute?.name || requested.line.productName,
                substitutionReason: substitute ? requested.substitutionReason : null,
              };
            }),
          },
          include: { lines: true },
        },
      });
      const complete = prescription.lines.every((line) =>
        (nextTotals.get(line.id) || 0) >= quantityUnits(line.prescribedQuantity));
      const status = complete ? 'dispensed' : 'partially_dispensed';
      await tx.pharmacyPrescriptionFill.update({ where: { id: fill.id }, data: { status } });
      await tx.pharmacyPrescription.update({
        where: { id: prescription.id },
        data: {
          status,
          ...(complete && fill.fillNumber > 1 ? { refillsUsed: { increment: 1 } } : {}),
        },
      });
      await audit(req, context, 'PHARMACY_DISPENSE_RECORDED', 'pharmacy_prescription', prescription.id, {
        fillNumber: fill.fillNumber,
        dispenseId,
        lineCount: selectedLines.length,
        controlled: hasControlled,
      }, tx);
      return { id: created.id, status, fillNumber: fill.fillNumber, lines: created.lines };
    });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

exports.getPrescriptionLabel = async (req, res, next) => {
  try {
    const context = contextFor(req);
    const prescription = await findPrescription(context, req.params?.prescriptionId);
    const fill = activeFill(prescription);
    if (!prescription || !fill) {
      return res.status(404).json({ success: false, code: 'PHARMACY_PRESCRIPTION_NOT_FOUND', message: 'Prescription not found on this Pharmacy register.' });
    }
    if (!['partially_dispensed', 'dispensed'].includes(fill.status)) {
      return res.status(409).json({ success: false, code: 'PHARMACY_LABEL_NOT_READY', message: 'Record a dispense before printing a dispensing label.' });
    }
    const settingsRow = await prisma.systemSettings.findUnique({
      where: { companyId: context.companyId },
      select: { posPharmacySettings: true },
    });
    const pharmacySettings = normalizeSettings(settingsRow?.posPharmacySettings);
    await audit(req, context, 'PHARMACY_PRESCRIPTION_LABEL_PRINTED', 'pharmacy_prescription', prescription.id, {
      fillNumber: fill.fillNumber,
      lineCount: prescription.lines.length,
    });
    const dispensedLines = new Map();
    for (const dispense of fill.dispenses || []) {
      for (const dispenseLine of dispense.lines || []) {
        const prescriptionLine = prescription.lines.find((line) => line.id === dispenseLine.prescriptionLineId);
        const units = quantityUnits(dispenseLine.quantity);
        if (!prescriptionLine || units === null) continue;
        const key = `${prescriptionLine.id}:${dispenseLine.suppliedProductName}`;
        const existing = dispensedLines.get(key);
        dispensedLines.set(key, {
          prescriptionLine,
          productName: dispenseLine.suppliedProductName,
          units: (existing?.units || 0) + units,
        });
      }
    }
    return res.json({
      success: true,
      data: {
        prescriptionNumber: prescription.prescriptionNumber,
        patientName: prescription.patient.fullName,
        patientCode: prescription.patient.patientCode,
        prescriberName: prescription.prescriberName,
        issueDate: prescription.issueDate,
        fillNumber: fill.fillNumber,
        responsiblePharmacistName: pharmacySettings.profile.responsiblePharmacistName,
        lines: [...dispensedLines.values()].map(({ prescriptionLine, productName, units }) => ({
          productName,
          strength: prescriptionLine.strength,
          dosageForm: prescriptionLine.dosageForm,
          quantity: quantityString(units),
          dosageInstructions: prescriptionLine.dosageInstructions,
        })),
      },
    });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    return next(error);
  }
};

'use strict';

const { generateObjectId } = require('../utils/objectId');
const { normalizeSettings } = require('./posPharmacySettingsService');
const { writePosAuditLog, requestIp } = require('./posAuditService');
const { permissionsForUser } = require('../middleware/posAuthMiddleware');
const { getPosSessionPermissionCandidates } = require('../utils/posPermissionCompatibility');

function checkoutError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function pharmacyFields(product) {
  const fields = product?.customFields;
  const pharmacy = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields.pharmacy
    : null;
  return pharmacy && typeof pharmacy === 'object' && !Array.isArray(pharmacy) ? pharmacy : null;
}

function quantityUnits(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return null;
  const units = Math.round(quantity * 10_000);
  return Math.abs(quantity * 10_000 - units) < 0.000001 ? units : null;
}

function quantityString(units) {
  return (units / 10_000).toFixed(4);
}

function text(value, maximumLength) {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function pharmacyProduct(product) {
  const pharmacy = pharmacyFields(product);
  if (!pharmacy) return null;
  const prescriptionStatus = String(pharmacy.prescriptionStatus || 'OTC').trim().toUpperCase();
  if (!['OTC', 'PRESCRIPTION', 'RESTRICTED'].includes(prescriptionStatus)) return null;
  return {
    genericName: text(pharmacy.genericName, 180).toLocaleLowerCase(),
    strength: text(pharmacy.strength, 80).toLocaleLowerCase(),
    dosageForm: text(pharmacy.dosageForm, 48).toLocaleLowerCase(),
    prescriptionStatus,
    controlled: pharmacy.restrictedStatus === true || prescriptionStatus === 'RESTRICTED',
  };
}

function dispensedUnits(fill) {
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

async function validateAndRecordPharmacyCheckout({
  client,
  req,
  companyId,
  register,
  items,
  invoiceId,
  pending = false,
}) {
  if (String(register?.systemTillType || '').trim().toLowerCase() !== 'pharmacy') return null;

  const registerId = String(register.id || register._id || '');
  const user = req.posAuthContext?.user || req.user;
  const userId = String(user?.id || user?._id || '');
  if (!registerId || !userId) {
    throw checkoutError(401, 'PHARMACY_CHECKOUT_CONTEXT_INVALID', 'Sign in to this Pharmacy register again.');
  }

  const checkoutItems = Array.isArray(items) ? items : [];
  const productIds = [...new Set(checkoutItems.map((item) => String(item?.productId || '')).filter(Boolean))];
  const products = productIds.length
    ? await client.product.findMany({
      where: {
        companyId: String(companyId),
        id: { in: productIds },
        isActive: true,
        isArchived: false,
      },
      select: { id: true, name: true, customFields: true },
    })
    : [];
  const productsById = new Map(products.map((product) => [String(product.id), product]));
  const prescriptionGroups = new Map();

  for (const [index, item] of checkoutItems.entries()) {
    const productId = String(item?.productId || '');
    const product = productsById.get(productId);
    const medicine = pharmacyProduct(product);
    if (!product || !medicine) {
      throw checkoutError(
        409,
        'PHARMACY_PRODUCT_SETUP_REQUIRED',
        `Set up Pharmacy medicine details for item ${index + 1} before selling it at this register.`,
      );
    }

    if (medicine.prescriptionStatus === 'OTC') continue;

    const prescriptionId = text(item?.pharmacyPrescriptionId, 24);
    const prescriptionLineId = text(item?.pharmacyPrescriptionLineId, 24);
    const quantity = quantityUnits(item?.quantity);
    if (!prescriptionId || !prescriptionLineId || quantity === null) {
      throw checkoutError(
        409,
        'PHARMACY_PRESCRIPTION_REQUIRED',
        `${product.name} requires an approved prescription and a valid quantity.`,
      );
    }
    if (item?.salesUnitCode) {
      throw checkoutError(
        422,
        'PHARMACY_PRESCRIPTION_UNIT_INVALID',
        'Prescription medicines must be sold in the prescribed base unit.',
      );
    }

    const group = prescriptionGroups.get(prescriptionId) || {
      prescriptionId,
      patientId: '',
      lines: new Map(),
    };
    const requestedPatientId = text(req.body?.pharmacyPatientId, 24);
    if (group.patientId && group.patientId !== requestedPatientId) {
      throw checkoutError(422, 'PHARMACY_PATIENT_MISMATCH', 'A checkout cannot mix patients across prescriptions.');
    }
    group.patientId = requestedPatientId;

    const existing = group.lines.get(prescriptionLineId);
    if (existing && existing.product.id !== product.id) {
      throw checkoutError(422, 'PHARMACY_SUBSTITUTION_MIXED', 'Use one supplied product for each prescription line.');
    }
    if (existing) {
      existing.quantity += quantity;
    } else {
      group.lines.set(prescriptionLineId, {
        product,
        medicine,
        quantity,
        substitutionReason: text(item?.pharmacySubstitutionReason, 300),
      });
    }
    prescriptionGroups.set(prescriptionId, group);
  }

  if (!prescriptionGroups.size) {
    const patientId = text(req.body?.pharmacyPatientId, 24);
    if (!patientId) return null;
    const patient = await client.pharmacyPatient.findFirst({
      where: { id: patientId, companyId: String(companyId), registerId },
      select: { id: true },
    });
    if (!patient) {
      throw checkoutError(422, 'PHARMACY_PATIENT_NOT_FOUND', 'The selected patient is not available on this Pharmacy register.');
    }
    return { pending: Boolean(pending), hasControlled: false, patientId: String(patient.id) };
  }
  if (!req.body?.pharmacyPatientId) {
    throw checkoutError(422, 'PHARMACY_PATIENT_REQUIRED', 'Select the patient profile linked to this prescription.');
  }

  const settingsRow = await client.systemSettings.findUnique({
    where: { companyId: String(companyId) },
    select: { posRolePermissions: true, posPharmacySettings: true },
  });
  const permissionMatrix = req.posAuthContext?.settings?.posRolePermissions
    || settingsRow?.posRolePermissions;
  const permissions = await permissionsForUser(user, String(companyId), permissionMatrix);
  const reviewPermission = getPosSessionPermissionCandidates('pharmacy.dispensing.review');
  if (!reviewPermission.some((permission) => permissions.includes(permission))) {
    throw checkoutError(
      403,
      'PHARMACY_DISPENSING_PERMISSION_REQUIRED',
      'A pharmacist with dispensing permission must complete prescription checkouts.',
    );
  }

  const controlledReference = text(req.body?.pharmacyControlledReference, 120);
  const settings = normalizeSettings(settingsRow?.posPharmacySettings);
  const plans = [];
  let hasControlled = false;
  const today = new Date().toISOString().slice(0, 10);

  for (const group of [...prescriptionGroups.values()].sort((left, right) =>
    left.prescriptionId.localeCompare(right.prescriptionId))) {
    const loadPrescription = () => client.pharmacyPrescription.findFirst({
      where: { id: group.prescriptionId, companyId: String(companyId), registerId },
      include: {
        patient: true,
        lines: true,
        fills: {
          orderBy: { fillNumber: 'desc' },
          take: 1,
          include: { dispenses: { include: { lines: true } } },
        },
      },
    });
    let prescription = await loadPrescription();
    let fill = prescription?.fills?.[0];
    if (!prescription || !fill) {
      throw checkoutError(404, 'PHARMACY_PRESCRIPTION_NOT_FOUND', 'Prescription not found on this Pharmacy register.');
    }
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${fill.id}))`;
    prescription = await loadPrescription();
    fill = prescription?.fills?.[0];
    if (!prescription || !fill) {
      throw checkoutError(404, 'PHARMACY_PRESCRIPTION_NOT_FOUND', 'Prescription not found on this Pharmacy register.');
    }
    if (String(prescription.patientId) !== group.patientId) {
      throw checkoutError(409, 'PHARMACY_PATIENT_MISMATCH', 'The selected patient does not match this prescription.');
    }
    if (!['approved', 'partially_dispensed'].includes(fill.status)) {
      throw checkoutError(
        409,
        'PHARMACY_DISPENSE_NOT_APPROVED',
        'This prescription must be approved and not held, rejected, expired, or cancelled before checkout.',
      );
    }
    if (dateOnly(prescription.expiryDate) < today) {
      throw checkoutError(409, 'PHARMACY_PRESCRIPTION_EXPIRED', 'This prescription has expired and cannot be dispensed.');
    }

    const prescriptionLines = new Map((prescription.lines || []).map((line) => [String(line.id), line]));
    const previous = dispensedUnits(fill);
    const nextTotals = new Map(previous);
    const selectedLines = [];
    for (const [lineId, requested] of group.lines) {
      const line = prescriptionLines.get(lineId);
      if (!line) {
        throw checkoutError(422, 'PHARMACY_PRESCRIPTION_LINE_INVALID', 'The selected medicine is not part of this prescription.');
      }
      const sameProduct = String(line.productId) === String(requested.product.id);
      const sameMedicine = requested.medicine.genericName === text(line.genericName, 180).toLocaleLowerCase()
        && requested.medicine.strength === text(line.strength, 80).toLocaleLowerCase()
        && requested.medicine.dosageForm === text(line.dosageForm, 48).toLocaleLowerCase();
      if (!sameProduct && (!line.substitutionAllowed || !sameMedicine || requested.substitutionReason.length < 3)) {
        throw checkoutError(
          422,
          'PHARMACY_SUBSTITUTION_INVALID',
          `Choose the prescribed medicine or an authorized generic substitute for ${line.productName}.`,
        );
      }
      if (sameProduct && requested.substitutionReason) {
        throw checkoutError(422, 'PHARMACY_SUBSTITUTION_INVALID', 'A substitution reason is only valid for a substitute product.');
      }
      if (sameProduct && requested.medicine.prescriptionStatus === 'OTC') {
        throw checkoutError(409, 'PHARMACY_PRODUCT_CLASSIFICATION_CHANGED', 'Refresh the product and prescription details before checkout.');
      }

      const prescribed = quantityUnits(line.prescribedQuantity);
      const alreadyDispensed = previous.get(line.id) || 0;
      if (prescribed === null || requested.quantity > prescribed - alreadyDispensed) {
        throw checkoutError(
          422,
          'PHARMACY_DISPENSE_OVER_QUANTITY',
          `Checkout quantity exceeds the remaining prescribed amount for ${line.productName}.`,
        );
      }
      nextTotals.set(line.id, alreadyDispensed + requested.quantity);
      hasControlled ||= Boolean(line.controlled || requested.medicine.controlled);
      selectedLines.push({ ...requested, line });
    }
    plans.push({ prescription, fill, nextTotals, selectedLines });
  }

  if (hasControlled) {
    if (!settings.profile.controlledMedicineAuthorized) {
      throw checkoutError(
        403,
        'PHARMACY_CONTROLLED_NOT_AUTHORIZED',
        'Controlled medicines are not enabled in the reviewed Pharmacy profile.',
      );
    }
    if (plans.some(({ fill }) => String(fill.reviewedById || '') === userId)) {
      throw checkoutError(
        403,
        'PHARMACY_CONTROLLED_SECOND_REVIEW_REQUIRED',
        'A different pharmacist from the reviewer must complete this controlled-medicine checkout.',
      );
    }
    if (controlledReference.length < 3) {
      throw checkoutError(
        422,
        'PHARMACY_CONTROLLED_REFERENCE_REQUIRED',
        'Enter the controlled-medicine register reference before checkout.',
      );
    }
  }

  if (pending) return { pending: true, hasControlled };

  for (const { prescription, fill, nextTotals, selectedLines } of plans) {
    const currentFill = await client.pharmacyPrescriptionFill.findFirst({
      where: {
        id: fill.id,
        companyId: String(companyId),
        registerId,
        status: { in: ['approved', 'partially_dispensed'] },
      },
      select: { id: true },
    });
    if (!currentFill) {
      throw checkoutError(409, 'PHARMACY_DISPENSE_CONFLICT', 'This prescription changed while checking out. Refresh before continuing.');
    }

    const dispenseId = generateObjectId();
    const created = await client.pharmacyDispense.create({
      data: {
        id: dispenseId,
        companyId: String(companyId),
        registerId,
        prescriptionId: prescription.id,
        fillId: fill.id,
        invoiceId: String(invoiceId),
        dispensingUserId: userId,
        controlledReference: hasControlled ? controlledReference : null,
        lines: {
          create: selectedLines.map((requested) => ({
            id: generateObjectId(),
            fillId: fill.id,
            prescriptionLineId: requested.line.id,
            quantity: quantityString(requested.quantity),
            suppliedProductId: requested.product.id,
            suppliedProductName: requested.product.name,
            substitutionReason: requested.product.id === requested.line.productId
              ? null
              : requested.substitutionReason,
          })),
        },
      },
    });
    const complete = prescription.lines.every((line) =>
      (nextTotals.get(line.id) || 0) >= quantityUnits(line.prescribedQuantity));
    const status = complete ? 'dispensed' : 'partially_dispensed';
    await client.pharmacyPrescriptionFill.update({ where: { id: fill.id }, data: { status } });
    await client.pharmacyPrescription.update({
      where: { id: prescription.id },
      data: {
        status,
        ...(complete && fill.fillNumber > 1 ? { refillsUsed: { increment: 1 } } : {}),
      },
    });
    await writePosAuditLog({
      companyId: String(companyId),
      registerId,
      userId,
      event: 'PHARMACY_DISPENSE_RECORDED',
      entityType: 'pharmacy_prescription',
      entityId: prescription.id,
      metadata: {
        fillNumber: fill.fillNumber,
        dispenseId: created.id,
        invoiceId: String(invoiceId),
        lineCount: selectedLines.length,
        controlled: hasControlled,
      },
      ip: requestIp(req),
    }, client);
  }

  return { pending: false, hasControlled };
}

module.exports = {
  validateAndRecordPharmacyCheckout,
  pharmacyProduct,
  quantityUnits,
};

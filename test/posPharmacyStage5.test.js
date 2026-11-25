'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue({}),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posPharmacyPrescriptionController');

const context = {
  company: { id: 'company-1' },
  register: { id: 'register-1' },
  user: { id: 'pharmacist-2' },
};

function request(body = {}, params = {}, query = {}) {
  return {
    posAuthContext: context,
    body,
    params,
    query,
    headers: {},
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function prescriptionWithFill(status, dispenses = []) {
  const fill = {
    id: 'fill-1',
    fillNumber: 1,
    status,
    reviewedById: 'pharmacist-1',
    reviewedAt: new Date('2026-01-01T10:00:00.000Z'),
    reviewNote: null,
    holdReason: null,
    dispenses,
  };
  return {
    id: 'prescription-1',
    prescriptionNumber: 'RX-1',
    prescriberName: 'Dr. Example',
    prescriberLicense: 'LIC-1',
    issueDate: new Date('2026-01-01T00:00:00.000Z'),
    expiryDate: new Date('2099-01-01T00:00:00.000Z'),
    status,
    refillsAuthorized: 0,
    refillsUsed: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    patient: { id: 'patient-1', patientCode: 'PAT-1', fullName: 'Test Patient', phone: null, dateOfBirth: null },
    lines: [{
      id: 'line-1',
      productId: 'product-1',
      productName: 'Prescribed medicine',
      genericName: 'Example ingredient',
      strength: '10 mg',
      dosageForm: 'tablet',
      prescriptionStatus: 'PRESCRIPTION',
      controlled: false,
      prescribedQuantity: '10.0000',
      dosageInstructions: 'Take as directed',
      substitutionAllowed: false,
    }],
    fills: [fill],
  };
}

describe('Pharmacy Stage 5 prescription and dispensing workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(prisma).forEach((key) => delete prisma[key]);
  });

  test('shows duplicate prescription references instead of saving a second prescription', async () => {
    prisma.pharmacyPatient = { findFirst: jest.fn().mockResolvedValue({ id: 'patient-1' }) };
    prisma.product = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue({ id: 'existing-prescription' }) };
    const res = response();

    await controller.createPrescription(request({
      patientId: 'patient-1',
      prescriptionNumber: 'RX-DUPLICATE',
      prescriberName: 'Dr. Example',
      prescriberLicense: 'LIC-1',
      issueDate: new Date().toISOString().slice(0, 10),
      expiryDate: '2099-01-01',
      lines: [{ productId: 'product-1', prescribedQuantity: 1, dosageInstructions: 'Take daily' }],
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PHARMACY_PRESCRIPTION_DUPLICATE');
    expect(res.body.message).toMatch(/already exists/i);
    expect(prisma.$transaction).toBeUndefined();
  });

  test('returns field-level issues for an invalid prescription', async () => {
    const res = response();

    await controller.createPrescription(request({ lines: [] }), res, jest.fn());

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('PHARMACY_PRESCRIPTION_INVALID');
    expect(res.body.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      'patientId',
      'prescriptionNumber',
      'prescriberName',
      'issueDate',
      'lines',
    ]));
  });

  test('creates patient profiles without passing the POS context userId to Prisma', async () => {
    const patient = {
      id: 'patient-1',
      patientCode: 'PAT-1',
      fullName: 'Aline Uwase',
      phone: null,
      dateOfBirth: null,
    };
    const tx = {
      pharmacyPatient: { create: jest.fn().mockResolvedValue(patient) },
    };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.createPatient(request({ fullName: 'Aline Uwase' }), res, jest.fn());

    const createData = tx.pharmacyPatient.create.mock.calls[0][0].data;
    expect(createData).toEqual(expect.objectContaining({
      companyId: context.company.id,
      registerId: context.register.id,
      createdById: context.user.id,
    }));
    expect(createData).not.toHaveProperty('userId');
    expect(res.statusCode).toBe(201);
  });

  test('adds repeated partial dispense quantities when returning the prescription queue', async () => {
    const prescription = prescriptionWithFill('partially_dispensed', [
      { lines: [{ prescriptionLineId: 'line-1', quantity: '2.0000', suppliedProductName: 'Prescribed medicine' }] },
      { lines: [{ prescriptionLineId: 'line-1', quantity: '3.5000', suppliedProductName: 'Prescribed medicine' }] },
    ]);
    prisma.pharmacyPrescription = { findMany: jest.fn().mockResolvedValue([prescription]) };
    const res = response();

    await controller.listPrescriptions(request(), res, jest.fn());

    expect(res.body.data[0].currentFill.dispensedQuantities['line-1']).toBe('5.5000');
  });

  test('records the reviewing pharmacist on approval', async () => {
    const before = prescriptionWithFill('pending_review');
    const after = prescriptionWithFill('approved');
    const tx = {
      pharmacyPrescriptionFill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      pharmacyPrescription: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(after),
      },
    };
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(before) };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.reviewPrescription(request({ decision: 'approve', reviewNote: 'Verified' }, { prescriptionId: 'prescription-1' }), res, jest.fn());

    expect(tx.pharmacyPrescriptionFill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'approved', reviewedById: context.user.id, reviewedAt: expect.any(Date) }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PHARMACY_PRESCRIPTION_REVIEWED',
      userId: context.user.id,
    }), tx);
    expect(res.body.data.currentFill.status).toBe('approved');
  });

  test('keeps cancelled prescriptions auditable with a cancellation reason and user', async () => {
    const before = prescriptionWithFill('approved');
    const after = prescriptionWithFill('cancelled');
    const tx = {
      pharmacyPrescriptionFill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      pharmacyPrescription: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(after),
      },
    };
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(before) };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.cancelPrescription(request({ reason: 'Prescriber withdrew the order' }, { prescriptionId: 'prescription-1' }), res, jest.fn());

    expect(tx.pharmacyPrescriptionFill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'cancelled',
        cancelledById: context.user.id,
        cancelledAt: expect.any(Date),
        cancelReason: 'Prescriber withdrew the order',
      }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PHARMACY_PRESCRIPTION_CANCELLED',
      entityId: 'prescription-1',
    }), tx);
    expect(res.body.data.currentFill.status).toBe('cancelled');
  });

  test('prints only actually dispensed quantities and supplied medicine names', async () => {
    const prescription = prescriptionWithFill('partially_dispensed', [
      { lines: [{ prescriptionLineId: 'line-1', quantity: '2.0000', suppliedProductName: 'Substitute medicine' }] },
    ]);
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(prescription) };
    prisma.systemSettings = { findUnique: jest.fn().mockResolvedValue({ posPharmacySettings: {} }) };
    const res = response();

    await controller.getPrescriptionLabel(request({}, { prescriptionId: 'prescription-1' }), res, jest.fn());

    expect(res.body.data.lines).toEqual([expect.objectContaining({
      productName: 'Substitute medicine',
      quantity: '2.0000',
    })]);
  });

  test('rejects a partial dispense that would exceed the prescribed quantity', async () => {
    const prescription = prescriptionWithFill('approved', [
      { lines: [{ prescriptionLineId: 'line-1', quantity: '9.0000', suppliedProductName: 'Prescribed medicine' }] },
    ]);
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(prescription) };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      pharmacyPrescriptionFill: { findFirst: jest.fn().mockResolvedValue({ id: 'fill-1' }) },
      pharmacyDispenseLine: {
        findMany: jest.fn().mockResolvedValue([{ prescriptionLineId: 'line-1', quantity: '9.0000' }]),
      },
    };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.recordDispense(request({
      lines: [{ prescriptionLineId: 'line-1', quantity: 2 }],
    }, { prescriptionId: 'prescription-1' }), res, jest.fn());

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('PHARMACY_DISPENSE_OVER_QUANTITY');
  });

  test('requires a different pharmacist to dispense a controlled medicine', async () => {
    const prescription = prescriptionWithFill('approved');
    prescription.fills[0].reviewedById = context.user.id;
    prescription.lines[0].controlled = true;
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(prescription) };
    prisma.systemSettings = {
      findUnique: jest.fn().mockResolvedValue({
        posPharmacySettings: { profile: { controlledMedicineAuthorized: true } },
      }),
    };
    const res = response();

    await controller.recordDispense(request({
      controlledReference: 'CONTROL-1',
      lines: [{ prescriptionLineId: 'line-1', quantity: 1 }],
    }, { prescriptionId: 'prescription-1' }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PHARMACY_CONTROLLED_SECOND_REVIEW_REQUIRED');
    expect(prisma.$transaction).toBeUndefined();
  });

  test('does not consume refill authorization until the refill is dispensed', async () => {
    const prescription = prescriptionWithFill('dispensed');
    prescription.refillsAuthorized = 1;
    prescription.fills[0].fillNumber = 1;
    const tx = {
      pharmacyPrescription: {
        findFirst: jest.fn().mockResolvedValue({ id: prescription.id, refillsUsed: 0, refillsAuthorized: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      pharmacyPrescriptionFill: {
        create: jest.fn().mockResolvedValue({ id: 'fill-2', fillNumber: 2, status: 'pending_review' }),
      },
    };
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(prescription) };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.requestRefill(request({}, { prescriptionId: prescription.id }), res, jest.fn());

    expect(tx.pharmacyPrescriptionFill.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fillNumber: 2, status: 'pending_review' }),
    }));
    expect(tx.pharmacyPrescription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'pending_review' },
    }));
    expect(res.body.data).toMatchObject({ fillNumber: 2, status: 'pending_review' });
  });

  test('counts a refill only after its full quantity is dispensed', async () => {
    const prescription = prescriptionWithFill('approved');
    prescription.fills[0].fillNumber = 2;
    prescription.refillsAuthorized = 1;
    prescription.refillsUsed = 0;
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      pharmacyPrescriptionFill: {
        findFirst: jest.fn().mockResolvedValue({ id: 'fill-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      pharmacyDispenseLine: { findMany: jest.fn().mockResolvedValue([]) },
      pharmacyDispense: {
        create: jest.fn().mockResolvedValue({ id: 'dispense-1', lines: [{ id: 'dispense-line-1', quantity: '10.0000' }] }),
      },
      pharmacyPrescription: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.pharmacyPrescription = { findFirst: jest.fn().mockResolvedValue(prescription) };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const res = response();

    await controller.recordDispense(request({
      lines: [{ prescriptionLineId: 'line-1', quantity: 10 }],
    }, { prescriptionId: prescription.id }), res, jest.fn());

    expect(tx.pharmacyPrescription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'dispensed', refillsUsed: { increment: 1 } },
    }));
    expect(res.body.data.status).toBe('dispensed');
  });
});

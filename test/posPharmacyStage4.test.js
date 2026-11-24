'use strict';

const {
  normalizeSupplierPharmacyFields,
  validateReceiptLine,
  receiptDiscrepancy,
  reconcileReceiptLines,
} = require('../services/pharmacyProcurementService');

describe('Pharmacy Stage 4 procurement and supplier operations', () => {
  test('stores pharmacy supplier controls without changing standard supplier fields', () => {
    const result = normalizeSupplierPharmacyFields({
      other: 'retained',
      pharmacy: {
        rwandaFdaImporterRegistration: ' FDA-123 ',
        coldChainCapable: true,
        leadTimeDays: 5,
      },
    });
    expect(result.other).toBe('retained');
    expect(result.pharmacy).toMatchObject({
      rwandaFdaImporterRegistration: 'FDA-123',
      coldChainCapable: true,
      leadTimeDays: 5,
      qualityDocumentRequired: true,
    });
  });

  test('requires batch identity and valid expiry dates', () => {
    expect(validateReceiptLine({ qtyReceived: 2, trackingType: 'batch', batchNo: '' }))
      .toContain('Batch number is required.');
    expect(validateReceiptLine({
      qtyReceived: 2,
      trackingType: 'batch',
      batchNo: 'A',
      manufactureDate: '2026-10-01',
      expiryDate: '2026-09-01',
    })).toContain('Expiry date must be after manufacture date.');
  });

  test('identifies complete, partial and over receipts', () => {
    expect(receiptDiscrepancy(10, 10, 0).status).toBe('complete');
    expect(receiptDiscrepancy(10, 4, 2)).toMatchObject({ remaining: 8, shortage: 4, overage: 0, status: 'partial_receipt' });
    expect(receiptDiscrepancy(10, 12, 0)).toMatchObject({ remaining: 10, shortage: 0, overage: 2, status: 'over_receipt' });
  });

  test('reconciles ordered, previous, received and remaining quantities', () => {
    expect(reconcileReceiptLines([
      { qtyOrdered: 10, qtyPreviouslyReceived: 3, qtyReceived: 4 },
      { qtyOrdered: 5, qtyPreviouslyReceived: 0, qtyReceived: 2 },
    ])).toEqual({ ordered: 15, previous: 3, received: 6, remaining: 6 });
  });
});

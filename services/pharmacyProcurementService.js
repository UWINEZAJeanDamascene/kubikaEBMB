'use strict';

function normalizeSupplierPharmacyFields(customFields) {
  const source = customFields && typeof customFields === 'object' && !Array.isArray(customFields)
    ? customFields
    : {};
  const pharmacy = source.pharmacy && typeof source.pharmacy === 'object'
    ? source.pharmacy
    : {};
  return {
    ...source,
    pharmacy: {
      rwandaFdaImporterRegistration: String(pharmacy.rwandaFdaImporterRegistration || '').trim().slice(0, 80),
      pharmacyLicenseNumber: String(pharmacy.pharmacyLicenseNumber || '').trim().slice(0, 80),
      coldChainCapable: Boolean(pharmacy.coldChainCapable),
      recallContact: String(pharmacy.recallContact || '').trim().slice(0, 160),
      leadTimeDays: Math.max(0, Number(pharmacy.leadTimeDays) || 0),
      qualityDocumentRequired: pharmacy.qualityDocumentRequired !== false,
    },
  };
}

function validateReceiptLine(line) {
  const errors = [];
  const quantity = Number(line.qtyReceived);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.push('Received quantity must be greater than zero.');
  }
  if (line.trackingType === 'batch') {
    if (!String(line.batchNo || '').trim()) errors.push('Batch number is required.');
    if (line.manufactureDate && line.expiryDate) {
      const manufacture = new Date(line.manufactureDate);
      const expiry = new Date(line.expiryDate);
      if (Number.isFinite(manufacture.getTime()) && Number.isFinite(expiry.getTime())
        && expiry <= manufacture) errors.push('Expiry date must be after manufacture date.');
    }
  }
  return errors;
}

function receiptDiscrepancy(orderedQuantity, receivedQuantity, previouslyReceivedQuantity = 0) {
  const ordered = Number(orderedQuantity) || 0;
  const received = Number(receivedQuantity) || 0;
  const previous = Number(previouslyReceivedQuantity) || 0;
  const remaining = Math.max(0, ordered - previous);
  const shortage = Math.max(0, remaining - received);
  const overage = Math.max(0, received - remaining);
  return {
    remaining,
    shortage,
    overage,
    status: overage > 0 ? 'over_receipt' : shortage > 0 ? 'partial_receipt' : 'complete',
  };
}

function reconcileReceiptLines(lines) {
  const received = (lines || []).reduce((sum, line) => sum + (Number(line.qtyReceived) || 0), 0);
  const ordered = (lines || []).reduce((sum, line) => sum + (Number(line.qtyOrdered) || 0), 0);
  const previous = (lines || []).reduce((sum, line) => sum + (Number(line.qtyPreviouslyReceived) || 0), 0);
  return {
    ordered,
    previous,
    received,
    remaining: Math.max(0, ordered - previous - received),
  };
}

module.exports = {
  normalizeSupplierPharmacyFields,
  validateReceiptLine,
  receiptDiscrepancy,
  reconcileReceiptLines,
};

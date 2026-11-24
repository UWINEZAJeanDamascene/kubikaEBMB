'use strict';

function batchStatus(batch, at = new Date()) {
  const recallStatus = String(batch?.recallStatus || 'active').toLowerCase();
  if (recallStatus === 'recalled') return 'recalled';
  if (recallStatus === 'closed') return 'closed';
  if (batch?.isQuarantined) return 'quarantined';
  if (batch?.expiryDate) {
    const expiry = new Date(batch.expiryDate);
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < at.getTime()) return 'expired';
  }
  return 'saleable';
}

function allocateFefo(batches, requestedQuantity, at = new Date()) {
  const quantity = Number(requestedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const eligible = (batches || [])
    .filter((batch) => batchStatus(batch, at) === 'saleable')
    .filter((batch) => Number(batch.qtyOnHand || 0) > 0)
    .slice()
    .sort((left, right) => {
      const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      return (Number.isNaN(leftExpiry) ? Number.MAX_SAFE_INTEGER : leftExpiry)
        - (Number.isNaN(rightExpiry) ? Number.MAX_SAFE_INTEGER : rightExpiry);
    });
  let remaining = quantity;
  const allocations = [];
  for (const batch of eligible) {
    const take = Math.min(remaining, Number(batch.qtyOnHand));
    if (take <= 0) continue;
    allocations.push({ batchId: String(batch.id || batch._id), batchNo: String(batch.batchNo || ''), quantity: take });
    remaining -= take;
    if (remaining <= 0.0000001) break;
  }
  return remaining <= 0.0000001 ? allocations : null;
}

function reconcileBatchQuantity(batch, movements = []) {
  const received = Number(batch?.qtyReceived || 0);
  const onHand = Number(batch?.qtyOnHand || 0);
  const reserved = Number(batch?.reservedQuantity || 0);
  const movementDelta = movements.reduce((sum, movement) => {
    const quantity = Number(movement.quantity || 0);
    return sum + (String(movement.type || '').toLowerCase() === 'out' ? -quantity : quantity);
  }, 0);
  return {
    received,
    onHand,
    reserved,
    available: Math.max(0, onHand - reserved),
    movementDelta,
    reconciled: Number.isFinite(received) && Number.isFinite(onHand)
      && received >= onHand
      && received - onHand >= 0,
  };
}

module.exports = {
  batchStatus,
  allocateFefo,
  reconcileBatchQuantity,
};

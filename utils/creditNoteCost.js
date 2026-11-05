'use strict';

function positiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function resolveOriginalUnitCost(invoiceLine, stockMovements = []) {
  const savedUnitCost = positiveAmount(invoiceLine?.unitCost);
  if (savedUnitCost) return savedUnitCost;

  const originalQuantity = positiveAmount(invoiceLine?.qty ?? invoiceLine?.quantity);
  const savedCogs = positiveAmount(invoiceLine?.cogsAmount);
  if (originalQuantity && savedCogs) return savedCogs / originalQuantity;

  const movementQuantity = stockMovements.reduce(
    (sum, movement) => sum + positiveAmount(movement.quantity),
    0,
  );
  const movementCost = stockMovements.reduce((sum, movement) => {
    const totalCost = positiveAmount(movement.totalCost);
    return sum + (totalCost || positiveAmount(movement.quantity) * positiveAmount(movement.unitCost));
  }, 0);
  return movementQuantity && movementCost ? movementCost / movementQuantity : 0;
}

module.exports = { resolveOriginalUnitCost };

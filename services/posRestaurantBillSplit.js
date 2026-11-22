'use strict';

const MAX_GUESTS = 20;

function fail(message) {
  const error = new Error(message);
  error.code = 'RESTAURANT_BILL_SPLIT_INVALID';
  error.statusCode = 400;
  return error;
}

function allocateEqualRwf(total, guestCount) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw fail('The bill total must be a whole-number RWF amount.');
  }
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS) {
    throw fail(`Choose between 1 and ${MAX_GUESTS} guests.`);
  }

  const baseAmount = Math.floor(total / guestCount);
  const remainder = total % guestCount;
  return Array.from({ length: guestCount }, (_, index) => ({
    payerNumber: index + 1,
    amount: baseAmount + (index === 0 ? remainder : 0),
  }));
}

function allocateItemsToChecks(value, checkoutLines, guestCount) {
  if (!Array.isArray(value) || value.length < 1 || value.length > guestCount) {
    throw fail('Assign items to at least one guest and no more guests than the order contains.');
  }
  if (!Array.isArray(checkoutLines) || !checkoutLines.length) {
    throw fail('The order has no sent items to split.');
  }

  const sourceById = new Map(checkoutLines.map((line) => [String(line.itemId), line]));
  if (sourceById.size !== checkoutLines.length) {
    throw fail('The saved order contains duplicate item identifiers and cannot be split safely.');
  }

  const assignedById = new Map(checkoutLines.map((line) => [String(line.itemId), 0]));
  const guestNumbers = new Set();
  const checks = value.map((check) => {
    const guestNumber = Number(check?.guestNumber);
    if (!Number.isInteger(guestNumber) || guestNumber < 1 || guestNumber > guestCount
      || guestNumbers.has(guestNumber)) {
      throw fail('Each check must belong to a different guest in this order.');
    }
    guestNumbers.add(guestNumber);
    if (!Array.isArray(check?.items) || !check.items.length) {
      throw fail('Give each guest at least one item.');
    }

    const itemIds = new Set();
    const items = check.items.map((assignment) => {
      const itemId = String(assignment?.itemId || '');
      const source = sourceById.get(itemId);
      const quantity = Number(assignment?.quantity);
      if (!source || itemIds.has(itemId)) {
        throw fail('Choose an item from this order only once per guest.');
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(source.quantity)) {
        throw fail('Each assigned quantity must be a whole number available on the order.');
      }
      itemIds.add(itemId);
      const assignedQuantity = assignedById.get(itemId) + quantity;
      if (assignedQuantity > Number(source.quantity)) {
        throw fail('An item quantity cannot be assigned to more guests than was ordered.');
      }
      assignedById.set(itemId, assignedQuantity);
      return { ...source, quantity };
    });

    return { guestNumber, items };
  });

  for (const line of checkoutLines) {
    if (assignedById.get(String(line.itemId)) !== Number(line.quantity)) {
      throw fail(`Assign all of ${line.name || 'each item'} before issuing the split checks.`);
    }
  }

  return checks.sort((left, right) => left.guestNumber - right.guestNumber);
}

module.exports = {
  MAX_GUESTS,
  allocateEqualRwf,
  allocateItemsToChecks,
};

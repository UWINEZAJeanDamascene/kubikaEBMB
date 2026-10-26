const WAREHOUSE_CODE_PREFIX = 'WH-';
const WAREHOUSE_CODE_DIGITS = 3;

function nextWarehouseCode(existingCodes = []) {
  const usedNumbers = new Set();
  const codePattern = /^WH-(\d+)$/i;

  for (const existingCode of existingCodes) {
    const match = String(existingCode || '').trim().match(codePattern);
    if (match) usedNumbers.add(Number(match[1]));
  }

  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber += 1;

  return `${WAREHOUSE_CODE_PREFIX}${String(nextNumber).padStart(WAREHOUSE_CODE_DIGITS, '0')}`;
}

module.exports = { nextWarehouseCode };

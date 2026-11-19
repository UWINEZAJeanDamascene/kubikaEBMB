const GS1_FORMATS = {
  EAN13: { length: 13, label: 'EAN-13' },
  EAN8: { length: 8, label: 'EAN-8' },
  UPC: { length: 12, label: 'UPC-A' },
  UPCA: { length: 12, label: 'UPC-A' },
  ITF14: { length: 14, label: 'ITF-14' },
};

function calculateGs1CheckDigit(dataDigits) {
  let sum = 0;
  for (let index = 0; index < dataDigits.length; index += 1) {
    const weight = (dataDigits.length - index) % 2 === 1 ? 3 : 1;
    sum += Number(dataDigits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

function validateGs1Barcode(value, type) {
  const barcode = String(value ?? '').trim();
  if (!barcode) return null;

  const normalizedType = String(type || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const format = GS1_FORMATS[normalizedType];
  if (!format) return null;

  if (!new RegExp(`^\\d{${format.length}}$`).test(barcode)) {
    return `${format.label} barcodes must be exactly ${format.length} digits.`;
  }

  const expectedCheckDigit = calculateGs1CheckDigit(barcode.slice(0, -1));
  if (Number(barcode[barcode.length - 1]) !== expectedCheckDigit) {
    return `${format.label} barcode check digit is invalid; the final digit should be ${expectedCheckDigit}.`;
  }

  return null;
}

module.exports = { calculateGs1CheckDigit, validateGs1Barcode };

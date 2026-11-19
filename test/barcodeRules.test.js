const { validateGs1Barcode } = require('../utils/barcodeRules');

describe('GS1 barcode rules', () => {
  it.each([
    ['EAN13', '6001234000112'],
    ['EAN8', '12345670'],
    ['UPC', '036000291452'],
    ['ITF14', '10012345000017'],
  ])('accepts a valid %s check digit', (type, barcode) => {
    expect(validateGs1Barcode(barcode, type)).toBeNull();
  });

  it.each([
    ['EAN13', '6001234000113', '2'],
    ['EAN8', '12345671', '0'],
    ['UPC', '036000291453', '2'],
    ['ITF14', '10012345000018', '7'],
  ])('reports the expected %s check digit', (type, barcode, expectedDigit) => {
    expect(validateGs1Barcode(barcode, type)).toContain(`final digit should be ${expectedDigit}`);
  });

  it('rejects a GS1 barcode with the wrong length', () => {
    expect(validateGs1Barcode('600123400011', 'EAN13')).toBe(
      'EAN-13 barcodes must be exactly 13 digits.',
    );
  });
});

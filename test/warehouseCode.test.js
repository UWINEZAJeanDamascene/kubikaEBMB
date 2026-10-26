const { nextWarehouseCode } = require('../utils/warehouseCode');

describe('nextWarehouseCode', () => {
  it('starts generated warehouse codes at WH-001', () => {
    expect(nextWarehouseCode()).toBe('WH-001');
  });

  it('uses the first unused sequence number', () => {
    expect(nextWarehouseCode(['WH-001', 'WH-003'])).toBe('WH-002');
  });

  it('handles existing codes without case sensitivity', () => {
    expect(nextWarehouseCode(['wh-001', 'WH-002'])).toBe('WH-003');
  });

  it('ignores codes outside the generated warehouse-code format', () => {
    expect(nextWarehouseCode(['MAIN', 'WH001', 'WH-ABC'])).toBe('WH-001');
  });
});

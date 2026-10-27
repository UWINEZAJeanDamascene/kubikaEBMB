const crypto = require('crypto');
const baseline = require('../fixtures/rraVsdc/v1.0.5/import-item-status-4.18.json');
const {
  RRA_IMPORT_ITEM_STATUS_CLASS,
  RRA_IMPORT_ITEM_STATUS_BY_CODE,
  getRraImportItemStatusName,
} = require('../constants/ebmImportItemStatuses');
const { ebmImportedItemToApi } = require('../utils/phase10Mappers');

describe('RRA VSDC v1.0.5 §4.18 import-item status codes', () => {
  it('preserves the published class identity, all four codes, labels, and order', () => {
    expect(baseline.scope).toMatchObject({
      section: '4.18',
      classificationCode: '26',
      classificationName: 'Import item Status',
    });
    expect(RRA_IMPORT_ITEM_STATUS_CLASS).toBe('26');
    expect(baseline.codes.map(({ code, sortOrder, name }) => [code, sortOrder, name])).toEqual([
      ['1', 1, 'Unsent'],
      ['2', 2, 'Waiting'],
      ['3', 3, 'Approved'],
      ['4', 4, 'Cancelled'],
    ]);
    expect(crypto.createHash('sha256').update(JSON.stringify(baseline.codes)).digest('hex'))
      .toBe(baseline.integrity.sha256);
    expect(Object.keys(RRA_IMPORT_ITEM_STATUS_BY_CODE)).toEqual(['1', '2', '3', '4']);
  });

  it.each([
    ['1', 'Unsent'],
    ['2', 'Waiting'],
    ['3', 'Approved'],
    ['4', 'Cancelled'],
  ])('maps RRA status %s to %s in the API', (code, name) => {
    const api = ebmImportedItemToApi({ id: 'item-id', rraStatusCode: code });
    expect(api).toMatchObject({ rraStatusCode: code, rraStatusName: name });
    expect(getRraImportItemStatusName(code)).toBe(name);
  });

  it('derives an unambiguous legacy label from preserved raw status fields', () => {
    expect(ebmImportedItemToApi({
      id: 'item-id',
      rraStatusCode: null,
      raw: { imptItemSttsCd: '3' },
    }).rraStatusName).toBe('Approved');
  });

  it('does not guess when status aliases conflict or the RRA returns an unknown code', () => {
    expect(ebmImportedItemToApi({
      id: 'item-id',
      rraStatusCode: null,
      raw: { imptItemsttsCd: '3', imptItemSttsCd: '4' },
    }).rraStatusName).toBeNull();
    expect(ebmImportedItemToApi({
      id: 'item-id',
      rraStatusCode: '3',
      raw: { imptItemSttsCd: '4' },
    }).rraStatusName).toBeNull();
    expect(getRraImportItemStatusName('9')).toBeNull();
    expect(ebmImportedItemToApi({ id: 'item-id', rraStatusCode: '9' }))
      .toMatchObject({ rraStatusCode: '9', rraStatusName: null });
  });
});

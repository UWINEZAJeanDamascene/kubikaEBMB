const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fixture = require('../fixtures/rraVsdc/v1.0.5/api-response-codes-4.14.json');
const ebmService = require('../services/ebmService');
const { mapVsdcErrorCode } = require('../utils/vsdcPayloadSanitizer');

const EXPECTED_CODES = [
  ['000', 'Server', 'It is succeeded'],
  ['001', 'Server', 'There is no search result'],
  ['881', 'Client', 'Purchase is mandatory'],
  ['882', 'Client', 'Purchase code is invalid'],
  ['883', 'Client', 'Purchase already used'],
  ['884', 'Client', 'Invalid customer TIN was provided'],
  ['891', 'Client', 'An error occurred while Request URL is created.'],
  ['892', 'Client', 'An error occurred while Request Header data is created.'],
  ['893', 'Client', 'An error occurred while Request Body data is created.'],
  ['894', 'Client', 'An error regarding server communication occurred.'],
  ['895', 'Client', 'An error regarding unallowed Request Method occurred.'],
  ['896', 'Client', 'An error regarding Request Status occurred.'],
  ['899', 'Client', 'An error regarding Client occurred.'],
  ['900', 'Server', 'There is no Header information'],
  ['901', 'Server', 'It is not valid device'],
  ['902', 'Server', 'This device is installed'],
  ['903', 'Server', 'Only VSDC device can be verified.'],
  ['910', 'Server', 'Request parameter error'],
  ['911', 'Server', 'There is no request full text'],
  ['912', 'Server', 'There is a request Method error.'],
  ['921', 'Server', 'Sales or sales invoice data which is declared cannot be received.'],
  ['922', 'Server', 'Sales invoice data can be received after receiving the sales data.'],
  ['990', 'Server', 'The maxium number of views are exceeded'],
  ['991', 'Server', 'There is an error during registration'],
  ['992', 'Server', 'There is an error during modification'],
  ['993', 'Server', 'There is an error during deletion'],
  ['994', 'Server', 'There is an overlapped Data'],
  ['995', 'Server', 'There is no downloaded file'],
  ['999', 'Server', 'There is an unknown error. Please ask it administrator'],
];

describe('RRA VSDC v1.0.5 §4.14 API response-code reference', () => {
  test('preserves the complete published code, system and description table in source order', () => {
    expect(fixture.source).toMatchObject({ documentId: 'RRA_VSDC_DOC_v1.0.5', version: '1.0.5' });
    expect(fixture.scope).toMatchObject({ section: '4.14', printedPages: '73', physicalPdfPages: '77' });
    expect(fixture.codes.map(({ code, system, description }) => [code, system, description])).toEqual(EXPECTED_CODES);
    expect(fixture.codes.every(({ code }) => typeof code === 'string' && code.length === 3)).toBe(true);

    const pdfPath = path.resolve(path.dirname(require.resolve('../fixtures/rraVsdc/v1.0.5/api-response-codes-4.14.json')), fixture.source.pdf);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(fixture.source.sha256);
    const digest = crypto.createHash('sha256').update(JSON.stringify(fixture.codes), 'utf8').digest('hex');
    expect(fixture.integrity).toMatchObject({ algorithm: 'SHA-256', rowCount: 29, sha256: digest });
  });

  test('exposes source-backed descriptions for every result code without treating success as an error', () => {
    for (const [code, system, description] of EXPECTED_CODES) {
      const record = ebmService.getVsdcApiResponseCode(code);
      expect(record).toEqual({ code, system, description });
      expect(ebmService.RESULT_CODE_DETAILS[code]).toBe(description);
      if (code === '000') {
        expect(mapVsdcErrorCode(code)).toBeNull();
      } else {
        expect(mapVsdcErrorCode(code)).toBeTruthy();
      }
    }
    expect(ebmService.getVsdcApiResponseCode('00')).toBeNull();
    expect(ebmService.getVsdcApiResponseCode('unknown')).toBeNull();
    expect(mapVsdcErrorCode('777')).toBeNull();
  });

  test('keeps retry decisions separate from the PDF Client/Server classification', () => {
    expect(ebmService.isRetryableResultCode('894')).toBe(false);
    expect(ebmService.isRetryableResultCode('999')).toBe(true);
  });

  test('attaches the published result code metadata to a rejected VSDC response', () => {
    let error;
    try {
      ebmService.normalizeVsdcResponse({ resultCd: '901', resultMsg: 'device rejected' }, 'mock', '/test', {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'EBM_VSDC_901',
      resultCd: '901',
      resultCodeSystem: 'Server',
      resultCodeDescription: 'It is not valid device',
      response: { resultCd: '901', resultMsg: 'device rejected' },
    });
    expect(error.message).toContain('device rejected');
  });
});

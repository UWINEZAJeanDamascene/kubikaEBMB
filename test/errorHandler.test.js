const errorHandler = require('../middleware/errorHandler');

describe('errorHandler production diagnostics', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  test('logs safe server-error context without exposing it to the client', () => {
    process.env.NODE_ENV = 'production';
    const error = Object.assign(new Error('database detail'), { code: 'P2003' });
    const request = {
      method: 'POST',
      originalUrl: '/api/petty-cash/funds?token=private',
      path: '/petty-cash/funds',
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, request, response, jest.fn());

    expect(logError).toHaveBeenCalledWith('[api-error]', {
      method: 'POST',
      path: '/api/petty-cash/funds',
      statusCode: 500,
      errorName: 'Error',
      errorCode: 'P2003',
      errorMessage: 'database detail',
    });
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    });
  });

  test('exposes known VSDC result-code metadata without exposing raw response data', () => {
    process.env.NODE_ENV = 'production';
    const error = Object.assign(new Error('Device rejected'), {
      code: 'EBM_VSDC_REJECTED',
      resultCd: '901',
      resultCodeSystem: 'Server',
      resultCodeDescription: 'It is not valid device',
      response: { secret: 'must-not-leak' },
    });
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    errorHandler(error, { method: 'POST', path: '/api/ebm/test' }, response, jest.fn());

    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Device rejected',
      code: 'EBM_VSDC_REJECTED',
      resultCd: '901',
      resultCodeSystem: 'Server',
      resultCodeDescription: 'It is not valid device',
    });
  });
});

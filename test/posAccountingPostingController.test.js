jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const controller = require('../controllers/posAccountingPostingController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('POS accounting posting status API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns only the posting belonging to the active session tenant', async () => {
    const query = jest.fn().mockResolvedValue([{
      sourceType: 'pos_sale',
      sourceId: '507f1f77bcf86cd799439012',
      status: 'pending',
      journalEntryIds: [],
      attemptCount: 1,
      maxAttempts: 8,
      lastError: { code: 'PERIOD_CLOSED', message: 'Target accounting period is closed' },
    }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });
    const res = response();

    await controller.get({
      posAuthContext: { session: { companyId: '507f1f77bcf86cd799439011' } },
      params: { sourceType: 'pos_sale', sourceId: '507f1f77bcf86cd799439012' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('pending');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"company_id" = $1 AND "source_type" = $2 AND "source_id" = $3'),
      '507f1f77bcf86cd799439011',
      'pos_sale',
      '507f1f77bcf86cd799439012',
    );
  });

  test('rejects invalid source IDs without querying the database', async () => {
    const res = response();
    await controller.get({
      posAuthContext: { session: { companyId: '507f1f77bcf86cd799439011' } },
      params: { sourceType: 'pos_sale', sourceId: 'not-an-id' },
    }, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(dbClient).not.toHaveBeenCalled();
  });
});

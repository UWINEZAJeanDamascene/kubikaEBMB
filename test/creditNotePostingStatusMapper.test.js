const { creditNoteToApi } = require('../utils/salesApMappers');

describe('credit note posting status mapping', () => {
  test.each(['pending', 'posted', 'failed'])(
    'preserves the authoritative POS posting status %s',
    (posPostingStatus) => {
      const result = creditNoteToApi({
        id: '507f1f77bcf86cd799439011',
        companyId: '507f1f77bcf86cd799439012',
        referenceNo: 'CN-1',
        status: 'confirmed',
        posOrigin: true,
        posPostingStatus,
        lines: [],
        loyaltyRewardReversed: '12.50',
        loyaltyRewardConsumed: '7.50',
        applications: [{
          id: '507f1f77bcf86cd799439013',
          postingStatus: 'pending',
        }],
        payments: [{
          id: '507f1f77bcf86cd799439014',
          postingStatus: 'pending',
        }],
      });

      expect(result.postingStatus).toBe(posPostingStatus);
      expect(result.loyaltyRewardReversed).toBe(12.5);
      expect(result.loyaltyRewardConsumed).toBe(7.5);
      expect(result.applications[0].postingStatus).toBe('pending');
      expect(result.payments[0].postingStatus).toBe('pending');
    },
  );
});

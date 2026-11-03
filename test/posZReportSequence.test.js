'use strict';

const { getPosZReportHighWaterMark } = require('../services/posZReportSequence');

describe('getPosZReportHighWaterMark', () => {
  test('preserves deleted report numbers above the latest existing report', async () => {
    const client = {
      posZReport: { findFirst: jest.fn().mockResolvedValue({ zNumber: 4 }) },
      posAuditLog: { findFirst: jest.fn().mockResolvedValue({ metadata: { zNumberHighWaterMark: 7 } }) },
    };

    await expect(getPosZReportHighWaterMark(client, 'company-a', 'register-a')).resolves.toBe(7);
    expect(client.posAuditLog.findFirst).toHaveBeenCalledWith({
      where: { companyId: 'company-a', registerId: 'register-a', event: 'SHIFT_DELETED' },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
  });

  test('rejects invalid stored sequence metadata instead of risking number reuse', async () => {
    const client = {
      posZReport: { findFirst: jest.fn().mockResolvedValue(null) },
      posAuditLog: { findFirst: jest.fn().mockResolvedValue({ metadata: { zNumberHighWaterMark: '7' } }) },
    };

    await expect(getPosZReportHighWaterMark(client, 'company-a', 'register-a')).rejects.toThrow(
      'Invalid deleted POS Z report sequence high-water mark.',
    );
  });
});

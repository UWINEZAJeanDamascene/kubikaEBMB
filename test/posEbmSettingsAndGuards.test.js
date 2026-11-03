'use strict';

const { getPosEbmSettings, DEFAULT_POS_EBM_SETTINGS } = require('../services/posEbmSettingsService');
const { assertPosEbmTenantContext, assertPosEbmReceiptReprintContext } = require('../services/posEbmTenantGuard');
const { assertFiscalReferencesSafeForRestore } = require('../services/ebmBackupRestoreGuard');

describe('POS EBM settings and tenant/restore guards', () => {
  test('uses the safe company defaults when no settings row exists', async () => {
    const db = { posEbmSettings: { findUnique: jest.fn().mockResolvedValue(null) } };
    await expect(getPosEbmSettings(db, 'company-a')).resolves.toEqual(DEFAULT_POS_EBM_SETTINGS);
    expect(db.posEbmSettings.findUnique).toHaveBeenCalledWith({ where: { companyId: 'company-a' } });
  });

  test('blocks a submission whose company or sale context does not match', async () => {
    const db = {
      ebmSubmissionQueue: { findFirst: jest.fn().mockResolvedValue(null) },
      invoice: { findFirst: jest.fn().mockResolvedValue({ id: 'invoice-a', companyId: 'company-a' }) },
      posRegister: { findFirst: jest.fn().mockResolvedValue(null) },
      posShift: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(assertPosEbmTenantContext(db, {
      companyId: 'company-a', submissionId: 'queue-b', invoiceId: 'invoice-a',
    })).rejects.toMatchObject({ code: 'POS_EBM_SUBMISSION_COMPANY_MISMATCH' });
  });

  test('refuses a restore archive that omits a submission referenced by receipt records', async () => {
    const tx = {
      posEbmReceiptReprint: { findMany: jest.fn().mockResolvedValue([{ submissionId: 'queue-a' }]) },
      invoiceReceiptMetadata: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await expect(assertFiscalReferencesSafeForRestore(tx, 'company-a', new Map()))
      .rejects.toMatchObject({ code: 'BACKUP_EBM_REFERENCED_SUBMISSION_MISSING' });
  });

  test('refuses a refund restore when its original signed submission is missing', async () => {
    const tx = {
      posEbmReceiptReprint: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceReceiptMetadata: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const refund = {
      id: 'refund-a', companyId: 'company-a', documentType: 'creditNote', documentId: 'note-a',
      salesTyCd: 'N', rcptTyCd: 'R', originalSubmissionId: 'sale-a', payload: { orgRcptNo: '123' },
    };
    const archive = new Map([['EbmSubmissionQueue', { data: [refund] }]]);

    await expect(assertFiscalReferencesSafeForRestore(tx, 'company-a', archive))
      .rejects.toMatchObject({ code: 'BACKUP_EBM_REFUND_SOURCE_MISSING' });
  });

  test('a receipt reprint must use the same company, sale and register as its signed submission', async () => {
    const db = {
      ebmSubmissionQueue: { findFirst: jest.fn().mockResolvedValue({
        id: 'queue-a', companyId: 'company-a', documentType: 'invoice', documentId: 'invoice-a',
        registerId: 'register-b', shiftId: 'shift-a', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE',
      }) },
      invoice: { findFirst: jest.fn().mockResolvedValue({ id: 'invoice-a', companyId: 'company-a' }) },
      posRegister: { findFirst: jest.fn().mockResolvedValue({ id: 'register-a', companyId: 'company-a' }) },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: 'shift-a', companyId: 'company-a', registerId: 'register-a' }) },
    };
    await expect(assertPosEbmReceiptReprintContext(db, {
      companyId: 'company-a', submissionId: 'queue-a', invoiceId: 'invoice-a', registerId: 'register-a', shiftId: 'shift-a',
    })).rejects.toMatchObject({ code: 'POS_EBM_SUBMISSION_REGISTER_MISMATCH' });
    expect(db.ebmSubmissionQueue.findFirst).toHaveBeenCalledWith({ where: { id: 'queue-a', companyId: 'company-a' } });
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { id: 'invoice-a', companyId: 'company-a' }, select: { id: true, companyId: true } });
  });
});

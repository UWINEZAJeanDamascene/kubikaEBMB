'use strict';

const { assertWithinSourceTotals } = require('../services/posEbmV2RefundService');
const { createV2RefundOutbox } = require('../services/posEbmV2RefundService');

const payload = ({ total = '0', tax = '0', baseA = '0', taxA = '0', baseB = '0', taxB = '0' } = {}) => ({
  totAmt: total,
  totTaxAmt: tax,
  taxblAmtA: baseA, taxAmtA: taxA, taxblAmtB: baseB, taxAmtB: taxB,
  taxblAmtC: '0', taxAmtC: '0', taxblAmtD: '0', taxAmtD: '0',
});

describe('POS V2 fiscal refund cumulative limits', () => {
  test('permits cumulative partial refunds within original gross and tax totals', () => {
    expect(() => assertWithinSourceTotals(
      payload({ total: '118', tax: '18', baseB: '100', taxB: '18' }),
      [payload({ total: '59', tax: '9', baseB: '50', taxB: '9' })],
      payload({ total: '59', tax: '9', baseB: '50', taxB: '9' }),
    )).not.toThrow();
  });

  test.each([
    ['gross total', payload({ total: '119', tax: '18', baseB: '101', taxB: '18' })],
    ['cumulative tax', payload({ total: '118', tax: '19', baseB: '99', taxB: '19' })],
    ['tax bucket', payload({ total: '118', tax: '18', baseA: '50', taxA: '10', baseB: '50', taxB: '8' })],
  ])('rejects a refund that exceeds original %s', (_label, refund) => {
    expect(() => assertWithinSourceTotals(
      payload({ total: '118', tax: '18', baseA: '50', taxA: '9', baseB: '50', taxB: '9' }), [], refund,
    )).toThrow(expect.objectContaining({ code: 'EBM_V2_REFUND_EXCEEDS_ORIGINAL' }));
  });

  test('includes already queued pending refunds when checking cumulative amounts', () => {
    expect(() => assertWithinSourceTotals(
      payload({ total: '118', tax: '18', baseB: '100', taxB: '18' }),
      [payload({ total: '100', tax: '15', baseB: '85', taxB: '15' })],
      payload({ total: '18', tax: '3', baseB: '15', taxB: '3' }),
    )).not.toThrow();
    expect(() => assertWithinSourceTotals(
      payload({ total: '118', tax: '18', baseB: '100', taxB: '18' }),
      [payload({ total: '100', tax: '15', baseB: '85', taxB: '15' })],
      payload({ total: '19', tax: '3', baseB: '16', taxB: '3' }),
    )).toThrow(expect.objectContaining({ code: 'EBM_V2_REFUND_EXCEEDS_ORIGINAL' }));
  });

  test('creates a refund outbox linked to the original signed submission in the supplied transaction', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          id: 'original-submission', company_id: 'company-1', document_id: 'invoice-1', document_type: 'pos',
          sales_ty_cd: 'N', rcpt_ty_cd: 'S', signed_at: new Date(), fiscal_data_source: 'VSDC_RESPONSE',
          ebm_status: 'submitted', payload: payload({ total: '118', tax: '18', baseB: '100', taxB: '18' }),
          register_id: 'register-1', shift_id: 'shift-1', cashier_id: 'cashier-1', environment: 'sandbox',
        }])
        .mockResolvedValueOnce([]),
      ebmSubmissionQueue: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => data),
      },
      posAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prepared = {
      companyId: 'company-1', noteId: 'credit-note-1', invoiceId: 'invoice-1',
      originalSubmissionId: 'original-submission', requestPayloadHash: 'a'.repeat(64),
      payload: { ...payload({ total: '59', tax: '9', baseB: '50', taxB: '9' }), salesTyCd: 'N', rcptTyCd: 'R' },
    };
    const result = await createV2RefundOutbox(tx, prepared, { userId: 'manager-1' });
    expect(result).toMatchObject({
      companyId: 'company-1', documentType: 'creditNote', documentId: 'credit-note-1',
      originalSubmissionId: 'original-submission', salesTyCd: 'N', rcptTyCd: 'R',
      registerId: 'register-1', shiftId: 'shift-1', cashierId: 'cashier-1', environment: 'sandbox',
    });
    expect(tx.ebmSubmissionQueue.create).toHaveBeenCalledTimes(1);
    expect(tx.posAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('refuses to create a refund against an unsigned original submission', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
        id: 'original-submission', company_id: 'company-1', document_id: 'invoice-1', document_type: 'pos',
        sales_ty_cd: 'N', rcpt_ty_cd: 'S', signed_at: null, fiscal_data_source: null,
        ebm_status: 'failed', payload: payload(), register_id: 'register-1', shift_id: 'shift-1',
      }]),
      ebmSubmissionQueue: { findFirst: jest.fn(), create: jest.fn() },
    };
    await expect(createV2RefundOutbox(tx, {
      companyId: 'company-1', noteId: 'credit-note-1', invoiceId: 'invoice-1', originalSubmissionId: 'original-submission', payload: payload(),
    }, { userId: 'manager-1' })).rejects.toMatchObject({ code: 'EBM_V2_ORIGINAL_RECEIPT_NOT_SIGNED' });
    expect(tx.ebmSubmissionQueue.create).not.toHaveBeenCalled();
  });
});

const invoiceController = require('../controllers/invoiceController');

describe('invoice PDF buffer rendering', () => {
  afterEach(() => jest.restoreAllMocks());

  test('captures the generated PDF stream as bytes', async () => {
    const pdfBytes = Buffer.from('%PDF-buffer-test');
    jest.spyOn(invoiceController, 'generateInvoicePDF').mockImplementation(async (_req, res) => {
      res.write(pdfBytes);
      res.end();
    });

    await expect(invoiceController.renderInvoicePdfBuffer('a'.repeat(24), 'b'.repeat(24)))
      .resolves.toEqual(pdfBytes);
  });

  test('surfaces PDF generation errors instead of returning an empty document', async () => {
    const error = new Error('Invoice render failed');
    jest.spyOn(invoiceController, 'generateInvoicePDF').mockImplementation(async (_req, _res, next) => {
      next(error);
    });

    await expect(invoiceController.renderInvoicePdfBuffer('a'.repeat(24), 'b'.repeat(24)))
      .rejects.toBe(error);
  });
});

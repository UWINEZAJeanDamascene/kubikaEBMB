jest.mock('../models/Product', () => ({ findOne: jest.fn() }));
jest.mock('bwip-js', () => ({ toBuffer: jest.fn() }));
jest.mock('qrcode', () => ({ toBuffer: jest.fn() }));
jest.mock('../services/moduleEntitlementService', () => ({ getEntitlement: jest.fn() }));
jest.mock('../services/cacheService', () => ({}));
jest.mock('../services/notificationHelper', () => ({
  notifyLowStock: jest.fn(),
  notifyOutOfStock: jest.fn(),
  notifyStockReceived: jest.fn(),
}));

const Product = require('../models/Product');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');
const { getProductBarcode, getProductQRCode } = require('../controllers/productController');

function createResponse() {
  const res = {
    status: jest.fn(),
    set: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  return res;
}

describe('product barcode image generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Product.findOne.mockResolvedValue({
      _id: 'product-1',
      company: 'company-1',
      barcode: '6001234000112',
      barcodeType: 'EAN13',
      sku: 'RICE-01',
    });
    bwipjs.toBuffer.mockResolvedValue(Buffer.from('png'));
    QRCode.toBuffer.mockResolvedValue(Buffer.from('qr'));
  });

  it.each([
    ['EAN13', '6001234000112', 'ean13'],
    ['EAN8', '12345670', 'ean8'],
  ])('generates a %s image without truncating its full-length barcode', async (type, barcode, bcid) => {
    Product.findOne.mockResolvedValue({
      _id: 'product-1',
      company: 'company-1',
      barcode,
      barcodeType: type,
      sku: 'RICE-01',
    });
    const res = createResponse();
    const next = jest.fn();

    await getProductBarcode({
      user: { company: 'company-1' },
      params: { id: 'product-1' },
      query: {},
      get: () => 'https://example.test',
    }, res, next);

    expect(bwipjs.toBuffer).toHaveBeenCalledWith(expect.objectContaining({
      bcid,
      text: barcode,
    }));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an oversized EAN-13 instead of silently truncating it', async () => {
    Product.findOne.mockResolvedValue({
      _id: 'product-1',
      company: 'company-1',
      barcode: '60012340001122',
      barcodeType: 'EAN13',
      sku: 'RICE-01',
    });
    const res = createResponse();

    await getProductBarcode({
      user: { company: 'company-1' },
      params: { id: 'product-1' },
      query: {},
      get: () => 'https://example.test',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).not.toHaveBeenCalled();
    expect(bwipjs.toBuffer).not.toHaveBeenCalled();
  });

  it('returns a validation response for an EAN-13 with an incorrect check digit', async () => {
    Product.findOne.mockResolvedValue({
      _id: 'product-1',
      company: 'company-1',
      barcode: '6001234000113',
      barcodeType: 'EAN13',
      sku: 'RICE-01',
    });
    const res = createResponse();
    const next = jest.fn();

    await getProductBarcode({
      user: { company: 'company-1' },
      params: { id: 'product-1' },
      query: {},
      get: () => 'https://example.test',
    }, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'EAN-13 barcode check digit is invalid; the final digit should be 2.',
    });
    expect(bwipjs.toBuffer).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('generates a clean product deep link without redundant mutable query values', async () => {
    const previousFrontendBase = process.env.FRONTEND_BASE_URL;
    process.env.FRONTEND_BASE_URL = 'https://app.kubika.test/';
    const res = createResponse();

    try {
      await getProductQRCode({
        user: { company: 'company-1' },
        params: { id: 'product-1' },
        query: {},
        get: () => 'https://api.kubika.test',
      }, res, jest.fn());

      expect(QRCode.toBuffer).toHaveBeenCalledWith(
        'https://app.kubika.test/products/product-1',
        expect.objectContaining({ type: 'png' }),
      );
      expect(res.send).toHaveBeenCalledWith(Buffer.from('qr'));
    } finally {
      if (previousFrontendBase === undefined) delete process.env.FRONTEND_BASE_URL;
      else process.env.FRONTEND_BASE_URL = previousFrontendBase;
    }
  });

  it('keeps the QR usable by the in-app scanner when no frontend URL is configured', async () => {
    const previousFrontendBase = process.env.FRONTEND_BASE_URL;
    delete process.env.FRONTEND_BASE_URL;

    try {
      await getProductQRCode({
        user: { company: 'company-1' },
        params: { id: 'product-1' },
        query: {},
        get: () => '',
      }, createResponse(), jest.fn());

      expect(QRCode.toBuffer).toHaveBeenCalledWith('product:product-1', expect.any(Object));
    } finally {
      if (previousFrontendBase !== undefined) process.env.FRONTEND_BASE_URL = previousFrontendBase;
    }
  });
});

/** Shared ids and request builders for the POS E2E pack. */

const IDS = {
  company: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  cashier: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  manager: '999999999999999999999999',
  product: 'cccccccccccccccccccccccc',
  warehouse: 'dddddddddddddddddddddddd',
  till: 'eeeeeeeeeeeeeeeeeeeeeeee',
  client: 'ffffffffffffffffffffffff',
  bank: '111111111111111111111111',
  invoice: '222222222222222222222222',
  creditNote: '333333333333333333333333',
  approval: '444444444444444444444444',
  registerId: 'reg-e2e-1',
  deviceId: '77777777-7777-4777-8777-777777777777',
};

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function baseUser(overrides = {}) {
  return {
    id: IDS.cashier,
    company: { _id: IDS.company },
    ...overrides,
  };
}

function catalogProduct(overrides = {}) {
  return {
    _id: IDS.product,
    name: 'POS Widget',
    sku: 'WID-1',
    sellingPrice: 1000,
    unit: 'pcs',
    taxRate: 18,
    taxCode: 'B',
    currentStock: 50,
    isStockable: true,
    averageCost: 400,
    trackingType: 'none',
    trackSerialNumbers: false,
    trackBatch: false,
    isActive: true,
    ...overrides,
  };
}

function saleLine(overrides = {}) {
  return {
    productId: IDS.product,
    quantity: 1,
    unitPrice: 1000,
    catalogUnitPrice: 1000,
    discountPct: 0,
    discountReason: 'Test discount',
    description: 'POS Widget',
    ...overrides,
  };
}

function checkoutBody(overrides = {}) {
  return {
    warehouseId: IDS.warehouse,
    registerId: IDS.registerId,
    deviceId: IDS.deviceId,
    tillSession: { id: IDS.till },
    items: [saleLine()],
    paymentMethod: 'cash',
    paymentAmount: 1180,
    ...overrides,
  };
}

function makeReq({ body = {}, headers = {}, user, params = {}, query = {} } = {}) {
  const headerMap = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  return {
    user: user || baseUser(),
    body,
    params,
    query,
    get(name) {
      return headerMap[String(name).toLowerCase()];
    },
  };
}

module.exports = {
  IDS,
  mockRes,
  baseUser,
  catalogProduct,
  saleLine,
  checkoutBody,
  makeReq,
};

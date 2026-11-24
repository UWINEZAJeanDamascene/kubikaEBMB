'use strict';

const { validateAndRecordPharmacyCheckout } = require('../services/posPharmacyCheckoutService');

function mockClient(product) {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue(product ? [product] : []),
    },
    pharmacyPatient: {
      findFirst: jest.fn(),
    },
  };
}

describe('Pharmacy checkout validation', () => {
  it('does not alter non-Pharmacy checkout behavior', async () => {
    const client = mockClient(null);

    await expect(validateAndRecordPharmacyCheckout({
      client,
      req: { body: { items: [] } },
      companyId: 'company-1',
      register: { id: 'register-1', systemTillType: 'retail' },
      items: [],
      invoiceId: 'invoice-1',
    })).resolves.toBeNull();

    expect(client.product.findMany).not.toHaveBeenCalled();
  });

  it('allows configured OTC medicines without requiring a prescription', async () => {
    const client = mockClient({
      id: 'product-1',
      name: 'OTC medicine',
      customFields: { pharmacy: { prescriptionStatus: 'OTC' } },
    });

    await expect(validateAndRecordPharmacyCheckout({
      client,
      req: { body: { items: [{ productId: 'product-1', quantity: 1 }] }, posAuthContext: { user: { id: 'cashier-1' } } },
      companyId: 'company-1',
      register: { id: 'register-1', systemTillType: 'pharmacy' },
      items: [{ productId: 'product-1', quantity: 1 }],
      invoiceId: 'invoice-1',
    })).resolves.toBeNull();
  });

  it('blocks prescription medicines without prescription and line references', async () => {
    const client = mockClient({
      id: 'product-1',
      name: 'Prescription medicine',
      customFields: { pharmacy: { prescriptionStatus: 'PRESCRIPTION' } },
    });

    await expect(validateAndRecordPharmacyCheckout({
      client,
      req: { body: { items: [{ productId: 'product-1', quantity: 1 }] }, posAuthContext: { user: { id: 'cashier-1' } } },
      companyId: 'company-1',
      register: { id: 'register-1', systemTillType: 'pharmacy' },
      items: [{ productId: 'product-1', quantity: 1 }],
      invoiceId: 'invoice-1',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PRESCRIPTION_REQUIRED',
    });

  });

  it('validates an OTC patient against the current Pharmacy register', async () => {
    const client = mockClient({
      id: 'product-1',
      name: 'OTC medicine',
      customFields: { pharmacy: { prescriptionStatus: 'OTC' } },
    });
    client.pharmacyPatient.findFirst.mockResolvedValue({ id: '507f1f77bcf86cd799439011' });

    await expect(validateAndRecordPharmacyCheckout({
      client,
      req: {
        body: { pharmacyPatientId: '507f1f77bcf86cd799439011', items: [{ productId: 'product-1', quantity: 1 }] },
        posAuthContext: { user: { id: 'cashier-1' } },
      },
      companyId: 'company-1',
      register: { id: 'register-1', systemTillType: 'pharmacy' },
      items: [{ productId: 'product-1', quantity: 1 }],
      invoiceId: 'invoice-1',
    })).resolves.toEqual({
      pending: false,
      hasControlled: false,
      patientId: '507f1f77bcf86cd799439011',
    });
    expect(client.pharmacyPatient.findFirst).toHaveBeenCalledWith({
      where: {
        id: '507f1f77bcf86cd799439011',
        companyId: 'company-1',
        registerId: 'register-1',
      },
      select: { id: true },
    });
  });
});

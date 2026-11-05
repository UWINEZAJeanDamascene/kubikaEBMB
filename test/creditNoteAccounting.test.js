const {
  buildCreditNoteCostLines,
  findOriginalSaleCostAccounts,
  findOriginalVatAccountCode,
} = require('../utils/creditNoteAccounting');

describe('credit note accounting builders', () => {
  test('uses the original sale VAT account only when its full tax credit matches', () => {
    const saleEntry = {
      lines: [
        { accountCode: '2225', accountName: 'VAT Output', credit: 180, debit: 0 },
        { accountCode: '4000', accountName: 'Sales Revenue', credit: 1000, debit: 0 },
      ],
    };

    expect(findOriginalVatAccountCode(saleEntry, 180)).toBe('2225');
    expect(() => findOriginalVatAccountCode(saleEntry, 179.99))
      .toThrow('does not contain a matching VAT output account');
  });

  test('finds original COGS and inventory accounts from the sale journal', () => {
    expect(findOriginalSaleCostAccounts({
      lines: [
        { accountCode: '5105', accountName: 'Cost of Goods Sold', debit: 400, credit: 0 },
        { accountCode: '1205', accountName: 'Inventory', debit: 0, credit: 400 },
      ],
    })).toEqual({ cogsAccountCode: '5105', inventoryAccountCode: '1205' });
  });

  test('balances restock, write-off, and mixed return lines at original cost', () => {
    const result = buildCreditNoteCostLines({
      writeOffAccountCode: '5150',
      lines: [
        {
          quantity: 2,
          unitCost: 25.25,
          returnDisposition: 'restock',
          inventoryAccountCode: '1205',
          cogsAccountCode: '5105',
          description: 'Restocked goods',
        },
        {
          quantity: 1,
          unitCost: 12.5,
          returnDisposition: 'write_off',
          cogsAccountCode: '5105',
          description: 'Damaged goods',
        },
      ],
    });

    expect(result.restockLines).toHaveLength(2);
    expect(result.restockLines[0]).toMatchObject({ accountCode: '1205', debit: 50.5, credit: 0 });
    expect(result.restockLines[1]).toMatchObject({ accountCode: '5105', debit: 0, credit: 50.5 });
    expect(result.writeOffLines).toHaveLength(2);
    expect(result.writeOffLines[0]).toMatchObject({ accountCode: '5150', debit: 12.5, credit: 0 });
    expect(result.writeOffLines[1]).toMatchObject({ accountCode: '5105', debit: 0, credit: 12.5 });
    expect(result.writeOffAmount).toBe(12.5);
    for (const lines of [result.restockLines, result.writeOffLines]) {
      expect(lines.reduce((sum, line) => sum + line.debit, 0))
        .toBe(lines.reduce((sum, line) => sum + line.credit, 0));
    }
  });

  test('rejects missing original accounts rather than falling back to defaults', () => {
    expect(() => buildCreditNoteCostLines({
      lines: [{
        quantity: 1,
        unitCost: 10,
        returnDisposition: 'restock',
        cogsAccountCode: '5105',
      }],
    })).toThrow('original sale Inventory account is required');

    expect(() => buildCreditNoteCostLines({
      writeOffAccountCode: '5150',
      lines: [{
        quantity: 1,
        unitCost: 10,
        returnDisposition: 'write_off',
      }],
    })).toThrow('original sale COGS account is required');
  });
});

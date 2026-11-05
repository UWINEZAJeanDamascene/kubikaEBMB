'use strict';

const { prisma } = require('../lib/prisma');

async function getBankDepositClearingBalances(companyId, client = prisma) {
  const rows = await client.$queryRawUnsafe(
    `SELECT movement.register_id AS "registerId",
            COALESCE(SUM(movement.amount), 0)::numeric AS balance
       FROM pos_cash_movements movement
       JOIN journal_entries entry
         ON entry.id = movement.journal_entry_id
        AND entry.company_id = movement.company_id
      WHERE movement.company_id = $1
        AND movement.type = 'cash_out'
        AND movement.reason_code = 'BANK_DEPOSIT'
        AND entry.status = 'posted'
        AND entry.reversal_entry_id IS NULL
      GROUP BY movement.register_id`,
    String(companyId),
  );
  return new Map(rows.map((row) => {
    const balance = Number(row.balance || 0);
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new RangeError('A POS bank-deposit clearing balance exceeds the supported integer amount range.');
    }
    return [String(row.registerId), balance];
  }));
}

module.exports = { getBankDepositClearingBalances };

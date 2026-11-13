'use strict';

const RECEIPT_BLOCK_SIZE = 50;
const RECEIPT_COLLISION_RETRIES = 5;

function isReceiptNumberCollision(error) {
  return error?.code === 'P2002'
    || error?.meta?.code === '23505'
    || error?.meta?.driverAdapterError?.cause?.code === '23505'
    || error?.cause?.code === '23505';
}

/**
 * Refresh unused reservations first, then fill a complete block. Receipt
 * references use the ordinary INV sequence; EBM/VSDC numbering is not touched.
 */
async function allocateOfflineReceiptBlock({
  queryRaw,
  executeRaw,
  companyId,
  deviceId,
  registerId,
  blockId,
  expiresAt,
  nextReferenceNo,
  generateId,
  size = RECEIPT_BLOCK_SIZE,
}) {
  if (!Number.isInteger(size) || size < 1 || size > RECEIPT_BLOCK_SIZE) {
    throw new RangeError(`Offline receipt blocks must contain between 1 and ${RECEIPT_BLOCK_SIZE} numbers.`);
  }
  const reusable = await queryRaw(
    `WITH available AS (
       SELECT allocation.id, allocation.created_at, allocation.block_index
         FROM pos_receipt_number_allocations allocation
         JOIN pos_offline_snapshots snapshot
           ON snapshot.id = allocation.block_id AND snapshot.company_id = allocation.company_id
        WHERE allocation.company_id = $1 AND allocation.device_id = $2 AND allocation.register_id = $3
          AND allocation.operation_id IS NULL AND allocation.used_at IS NULL AND allocation.retired_at IS NULL
          AND allocation.expires_at > CURRENT_TIMESTAMP
          AND snapshot.expires_at <= CURRENT_TIMESTAMP
        ORDER BY allocation.created_at ASC, allocation.block_index ASC
        LIMIT $5
        FOR UPDATE OF allocation SKIP LOCKED
     ), indexed AS (
       SELECT id,
              ROW_NUMBER() OVER (ORDER BY created_at ASC, block_index ASC, id ASC) - 1 AS next_index
         FROM available
     ), refreshed AS (
       UPDATE pos_receipt_number_allocations allocation
          SET expires_at = $4::timestamptz,
              block_id = $6,
              block_index = indexed.next_index::integer
         FROM indexed
        WHERE allocation.id = indexed.id
        RETURNING allocation.receipt_number AS "receiptNumber"
     )
     SELECT "receiptNumber" FROM refreshed`,
    companyId,
    deviceId,
    registerId,
    expiresAt,
    size,
    blockId,
  );
  const receiptNumbers = reusable.map((row) => String(row.receiptNumber));

  while (receiptNumbers.length < size) {
    let inserted = false;
    for (let collision = 0; collision < RECEIPT_COLLISION_RETRIES; collision += 1) {
      const receiptNumber = await nextReferenceNo(companyId, 'INV', { field: 'referenceNo', model: 'invoice' });
      try {
        await executeRaw(
          `INSERT INTO pos_receipt_number_allocations
             (id, company_id, device_id, register_id, block_id, block_index, receipt_number, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
          generateId(), companyId, deviceId, registerId, blockId,
          receiptNumbers.length, receiptNumber, expiresAt,
        );
        receiptNumbers.push(receiptNumber);
        inserted = true;
        break;
      } catch (error) {
        if (!isReceiptNumberCollision(error) || collision === RECEIPT_COLLISION_RETRIES - 1) throw error;
        // A legacy/custom invoice may already own this INV value. Consume the
        // sequence value and try the next one; never claim the conflicting number.
      }
    }
    if (!inserted) throw new Error('Could not reserve a unique offline receipt number.');
  }
  return receiptNumbers;
}

async function retireUnusedReceiptNumbersForShift(tx, { companyId, tillSessionId, at = new Date() }) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE pos_receipt_number_allocations allocation
        SET retired_at = $3::timestamptz,
            retirement_reason = 'SHIFT_CLOSED',
            expires_at = LEAST(allocation.expires_at, $3::timestamptz)
       FROM pos_offline_snapshots snapshot
      WHERE snapshot.id = allocation.block_id
        AND snapshot.company_id = allocation.company_id
        AND snapshot.till_session_id = $2
        AND allocation.company_id = $1
        AND allocation.operation_id IS NULL
        AND allocation.used_at IS NULL
        AND allocation.retired_at IS NULL
     RETURNING allocation.id`,
    String(companyId), String(tillSessionId), at,
  );
  return rows.length;
}

async function retireUnusedReceiptNumbersForSnapshots(tx, { companyId, deviceId, snapshotIds, at = new Date() }) {
  const ids = [...new Set((snapshotIds || []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  const rows = await tx.$queryRawUnsafe(
    `UPDATE pos_receipt_number_allocations allocation
        SET retired_at = $4::timestamptz,
            retirement_reason = 'SYNC_COMPLETED',
            expires_at = LEAST(allocation.expires_at, $4::timestamptz)
       WHERE allocation.company_id = $1
         AND allocation.device_id = $2
         AND allocation.block_id::text = ANY($3::text[])
         AND allocation.operation_id IS NULL
         AND allocation.used_at IS NULL
         AND allocation.retired_at IS NULL
       RETURNING allocation.id`,
    String(companyId), String(deviceId), ids, at,
  );
  return rows.length;
}

module.exports = {
  RECEIPT_BLOCK_SIZE,
  RECEIPT_COLLISION_RETRIES,
  allocateOfflineReceiptBlock,
  isReceiptNumberCollision,
  retireUnusedReceiptNumbersForShift,
  retireUnusedReceiptNumbersForSnapshots,
};

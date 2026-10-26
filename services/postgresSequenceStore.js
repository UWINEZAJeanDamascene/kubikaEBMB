/**
 * Atomic sequence counters on PostgreSQL (Step 8).
 * Uses INSERT … ON CONFLICT … RETURNING for race-safe increments inside
 * optional Prisma interactive transactions.
 */
const { prisma } = require('../lib/prisma');
const { MAX_VSDC_NUMBER, MAX_VSDC_NUMBER_BIGINT } = require('../constants/ebmFiscalNumber');

// RRA declares these counters as NUMBER(38); keep the ceiling as text so it
// never passes through JavaScript's imprecise Number representation.
function parseExactInteger(value, { allowZero = false } = {}) {
  let parsed;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  } catch {
    parsed = undefined;
  }
  const minimum = allowZero ? 0n : 1n;
  if (parsed === undefined || parsed < minimum || parsed > MAX_VSDC_NUMBER_BIGINT) {
    const error = new Error(`EBM fiscal sequence values must be whole numbers between ${minimum} and ${MAX_VSDC_NUMBER}.`);
    error.code = 'EBM_FISCAL_SEQUENCE_INVALID';
    error.retryable = false;
    throw error;
  }
  return parsed;
}

function safeFiscalValue(value) {
  const text = value && typeof value.toFixed === 'function'
    ? value.toFixed(0)
    : value.toString();
  return BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}

/**
 * Sequence counters deliberately do NOT join the caller's ambient transaction
 * (see lib/txContext.js), unlike every other write in this codebase.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` holds a row lock until its
 * transaction ends. Enlisting it in a document-posting transaction would hold
 * that lock for the whole posting — every concurrent invoice for the same
 * company would serialize behind it, up to the 30s transaction timeout. Running
 * on the plain client commits the increment immediately, so concurrent postings
 * never block each other.
 *
 * The trade-off is that a rolled-back posting burns its number, leaving a gap
 * in the series. That is the normal, auditable behaviour for document numbering
 * and is far preferable to duplicate numbers or serialized POS throughput. Pass
 * an explicit `tx` at a call site that genuinely needs gapless allocation.
 */
function client(tx) {
  return tx || prisma;
}

/**
 * Increment a (company, name, year) counter and return the new value.
 * @param {string} companyId
 * @param {string} name
 * @param {number} [year=0]
 * @param {import('@prisma/client').Prisma.TransactionClient} [tx]
 * @returns {Promise<number>}
 */
async function incrementSequence(companyId, name, year = 0, tx = null) {
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, 1, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = sequences.value + 1, updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
  );
  return Number(rows[0].value);
}

/**
 * Bump a counter by an arbitrary delta (e.g. fixed_asset seed reconciliation).
 * @param {string} companyId
 * @param {string} name
 * @param {number} year
 * @param {number} delta
 * @param {import('@prisma/client').Prisma.TransactionClient} [tx]
 * @returns {Promise<number>}
 */
async function bumpSequence(companyId, name, year, delta, tx = null) {
  const bump = Math.max(1, Number(delta) || 1);
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = sequences.value + $4, updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
    bump,
  );
  return Number(rows[0].value);
}

/**
 * Read current counter value without incrementing.
 */
async function peekSequence(companyId, name, year = 0, tx = null) {
  const rows = await client(tx).$queryRawUnsafe(
    `SELECT value FROM sequences WHERE company_id = $1 AND name = $2 AND year = $3`,
    String(companyId),
    String(name),
    Number(year) || 0,
  );
  return rows.length ? Number(rows[0].value) : 0;
}

/**
 * Set counter to at least `minValue` (used when seeding from VSDC init info).
 */
async function ensureMinSequence(companyId, name, year, minValue, tx = null) {
  const min = Math.max(0, Number(minValue) || 0);
  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (company_id, name, year)
     DO UPDATE SET value = GREATEST(sequences.value, EXCLUDED.value), updated_at = NOW()
     RETURNING value`,
    String(companyId),
    String(name),
    Number(year) || 0,
    min,
  );
  return Number(rows[0].value);
}

/**
 * Allocate the next EBM fiscal number for a branch + type.
 * @param {string} companyId
 * @param {string} branchId  two-char branch code
 * @param {string} sequenceType  EbmSequenceType enum value
 * @param {{ seed?: number|string|bigint, seededFrom?: string|null, tx?: object }} [options]
 * @returns {Promise<number|string>} Safe values remain numbers; larger fiscal numbers remain exact decimal strings.
 */
async function allocateEbmSequence(companyId, branchId, sequenceType, options = {}) {
  const { seed = 0, seededFrom = null, tx = null } = options;
  const c = client(tx);
  const company = String(companyId);
  const branch = String(branchId).padStart(2, '0').slice(-2);
  const type = String(sequenceType);

  const seedValue = seed == null ? 0n : parseExactInteger(seed, { allowZero: true });
  if (seedValue > 0n) {
    await c.$queryRawUnsafe(
      `INSERT INTO ebm_sequences
         (company_id, branch_id, sequence_type, last_number, seeded_from, seeded_at, created_at, updated_at)
       VALUES ($1, $2, $3::"EbmSequenceType", $4, $5, NOW(), NOW(), NOW())
       ON CONFLICT (company_id, branch_id, sequence_type) DO NOTHING`,
      company,
      branch,
      type,
      seedValue.toString(),
      seededFrom,
    );
  }

  const rows = await c.$queryRawUnsafe(
    `INSERT INTO ebm_sequences
       (company_id, branch_id, sequence_type, last_number, created_at, updated_at)
     VALUES ($1, $2, $3::"EbmSequenceType", 1, NOW(), NOW())
     ON CONFLICT (company_id, branch_id, sequence_type)
     DO UPDATE SET last_number = ebm_sequences.last_number + 1, updated_at = NOW()
     WHERE ebm_sequences.last_number < $4::numeric
     RETURNING last_number`,
    company,
    branch,
    type,
    MAX_VSDC_NUMBER,
  );
  if (!rows.length) {
    const error = new Error(`EBM ${sequenceType} fiscal sequence reached the VSDC NUMBER(38) limit for branch ${branch}.`);
    error.code = 'EBM_FISCAL_SEQUENCE_EXHAUSTED';
    error.retryable = false;
    throw error;
  }
  return safeFiscalValue(rows[0].last_number);
}

/**
 * Seed EBM counters from VSDC init info ($max semantics).
 */
async function seedEbmSequence(companyId, branchId, sequenceType, minValue, seededFrom = 'vsdc_init', tx = null) {
  const min = minValue == null ? 0n : parseExactInteger(minValue, { allowZero: true });
  if (min <= 0n) return min;

  const rows = await client(tx).$queryRawUnsafe(
    `INSERT INTO ebm_sequences
       (company_id, branch_id, sequence_type, last_number, seeded_from, seeded_at, created_at, updated_at)
     VALUES ($1, $2, $3::"EbmSequenceType", $4, $5, NOW(), NOW(), NOW())
     ON CONFLICT (company_id, branch_id, sequence_type)
     DO UPDATE SET
       last_number = GREATEST(ebm_sequences.last_number, EXCLUDED.last_number),
       seeded_from = EXCLUDED.seeded_from,
       seeded_at = NOW(),
       updated_at = NOW()
     RETURNING last_number`,
    String(companyId),
    String(branchId).padStart(2, '0').slice(-2),
    String(sequenceType),
    min.toString(),
    seededFrom,
  );
  return safeFiscalValue(rows[0].last_number);
}

module.exports = {
  MAX_VSDC_NUMBER,
  incrementSequence,
  bumpSequence,
  peekSequence,
  ensureMinSequence,
  allocateEbmSequence,
  seedEbmSequence,
};

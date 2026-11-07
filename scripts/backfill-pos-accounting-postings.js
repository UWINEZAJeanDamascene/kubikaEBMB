'use strict';

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { buildPosSaleJournalEntries } = require('../services/posSaleJournalBuilder');
const { enqueueForRetry } = require('../services/posAccountingPostingService');

const PAGE_SIZE = 100;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function parseArgs(argv) {
  const options = { apply: false, companyId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') continue;
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--company-id') {
      options.companyId = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    throw new TypeError(`Unsupported argument: ${arg}`);
  }
  if (options.companyId && !OBJECT_ID_PATTERN.test(options.companyId)) {
    throw new TypeError('--company-id must be a 24-character company ID.');
  }
  return options;
}

function numeric(value) {
  const result = Number(value || 0);
  if (!Number.isFinite(result)) throw new TypeError('Stored invoice contains an invalid amount.');
  return result;
}

async function buildEntries(invoice) {
  const companyId = String(invoice.companyId);
  const register = invoice.registerId
    ? await prisma.posRegister.findFirst({
      where: { id: String(invoice.registerId), companyId },
      select: { id: true, systemTillType: true },
    })
    : null;
  const loyaltyRows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM("amount"), 0)::text AS "earned"
     FROM "pos_stored_value_ledger"
     WHERE "company_id" = $1 AND "invoice_id" = $2
       AND "kind" = 'loyalty' AND "entry_type" = 'earn'`,
    companyId,
    String(invoice.id),
  );
  const lines = (invoice.lines || []).map((line) => ({
    ...line,
    lineTax: numeric(line.lineTax),
    lineTotal: numeric(line.lineTotal),
    cogsAmount: numeric(line.cogsAmount),
  }));
  const tenders = Array.isArray(invoice.payments)
    ? invoice.payments.map((tender) => ({
      ...tender,
      amount: numeric(tender.amount),
      paymentMethod: String(tender.paymentMethod || '').toLowerCase(),
    }))
    : [];
  const built = await buildPosSaleJournalEntries({
    companyId,
    userId: String(invoice.cashierId || invoice.createdById || ''),
    invoice,
    register: register || { id: invoice.registerId, systemTillType: 'retail' },
    tenders,
    lines,
    totalAmount: numeric(invoice.totalAmount),
    subtotal: numeric(invoice.subtotal),
    totalDiscount: numeric(invoice.totalDiscount),
    taxAmount: numeric(invoice.taxAmount),
    amountPaid: numeric(invoice.amountPaid),
    amountOutstanding: numeric(invoice.amountOutstanding),
    cogsAmount: lines.reduce((sum, line) => sum + line.cogsAmount, 0),
    loyaltyEarned: numeric(loyaltyRows[0]?.earned),
    paymentFlow: invoice.ebm?.paymentFlow === 'PAYMENTS_V2' ? 'PAYMENTS_V2' : 'LEGACY',
  });
  return built.journalEntries;
}

async function backfill({ apply = false, companyId = null, logger = console } = {}) {
  let cursor = '';
  let examined = 0;
  let queued = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const invoices = await prisma.invoice.findMany({
      where: {
        posOrigin: true,
        status: { in: ['fully_paid', 'partially_paid'] },
        revenueJournalEntryId: null,
        ...(companyId ? { companyId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      include: { lines: { orderBy: [{ lineOrder: 'asc' }, { id: 'asc' }] } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    });
    if (!invoices.length) break;

    for (const invoice of invoices) {
      examined += 1;
      cursor = String(invoice.id);
      const existing = await prisma.posAccountingPosting.findFirst({
        where: { companyId: String(invoice.companyId), sourceType: 'pos_sale', sourceId: String(invoice.id) },
        select: { id: true, status: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      try {
        const entries = await buildEntries(invoice);
        if (apply) {
          await runInTransaction(async (tx) => {
            await enqueueForRetry({
              tx,
              companyId: String(invoice.companyId),
              userId: String(invoice.cashierId || invoice.createdById || ''),
              sourceType: 'pos_sale',
              sourceId: String(invoice.id),
              entries,
            });
            await tx.$executeRawUnsafe(
              `UPDATE "invoices"
               SET "pos_posting_status" = 'pending', "updated_at" = CURRENT_TIMESTAMP
               WHERE "id" = $1 AND "company_id" = $2 AND "pos_origin" = TRUE
                 AND "revenue_journal_entry_id" IS NULL`,
              String(invoice.id),
              String(invoice.companyId),
            );
          });
        }
        queued += 1;
      } catch (error) {
        failed += 1;
        logger.error(`[POS posting backfill] Invoice ${invoice.id} could not be prepared: ${error.message || error}`);
      }
    }

    if (invoices.length < PAGE_SIZE) break;
  }

  return { mode: apply ? 'apply' : 'dry-run', examined, wouldQueue: queued, queued: apply ? queued : 0, skipped, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await connectPrisma();
  try {
    const result = await backfill({ ...options });
    console.log(`[POS posting backfill] ${JSON.stringify(result)}`);
    if (result.failed) process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[POS posting backfill] Failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildEntries, backfill };

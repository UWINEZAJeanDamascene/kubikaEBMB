/**
 * Idempotent required-data bootstrap.
 *
 * It is deliberately safe to run on every process start: system roles are
 * refreshed and each tenant receives any missing canonical ledger accounts.
 */
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { CHART_OF_ACCOUNTS } = require('../constants/chartOfAccounts');
const { syncSystemRoles } = require('../scripts/seedSystemRoles');
const CurrencyService = require('./CurrencyService');

const configuredUpsertAttempts = Number(process.env.PRISMA_RETRY_ATTEMPTS || 3);
const BOOTSTRAP_UPSERT_ATTEMPTS = Number.isFinite(configuredUpsertAttempts) && configuredUpsertAttempts > 0
  ? Math.floor(configuredUpsertAttempts)
  : 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function accountData(definition, createdById = null) {
  return {
    name: definition.name,
    type: definition.type || 'asset',
    subtype: definition.subtype || null,
    normalBalance: definition.normalBalance || definition.normal_balance || 'debit',
    allowDirectPosting: definition.allowDirectPosting !== false,
    isActive: true,
    ...(createdById ? { createdById } : {}),
  };
}

async function upsertCanonicalAccount(companyId, code, definition, createdById = null) {
  const create = {
    id: generateObjectId(),
    companyId,
    code: String(code),
    ...accountData(definition, createdById),
  };
  const update = accountData(definition);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.chartOfAccount.upsert({
        where: { companyId_code: { companyId, code: String(code) } },
        create,
        update,
      });
      return;
    } catch (error) {
      if (error.code !== 'P1017' || attempt >= BOOTSTRAP_UPSERT_ATTEMPTS) throw error;
      console.warn(
        `[Bootstrap] Chart account ${code} connection closed during upsert`
        + ` — retrying (${attempt}/${BOOTSTRAP_UPSERT_ATTEMPTS - 1})`,
      );
      await sleep(attempt * 500);
    }
  }
}

async function syncCompanyChartOfAccounts(companyId, createdById = null) {
  let created = 0;
  let updated = 0;

  for (const [code, definition] of Object.entries(CHART_OF_ACCOUNTS)) {
    const existing = await prisma.chartOfAccount.findUnique({
      where: { companyId_code: { companyId, code: String(code) } },
      select: { id: true },
    });

    await upsertCanonicalAccount(companyId, code, definition, createdById);
    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  return { created, updated };
}

async function initializeRequiredData() {
  const roles = await syncSystemRoles();
  await CurrencyService.seedCurrencies();
  const companies = await prisma.company.findMany({ select: { id: true } });
  let accountsCreated = 0;
  let accountsUpdated = 0;

  for (const company of companies) {
    const result = await syncCompanyChartOfAccounts(company.id);
    accountsCreated += result.created;
    accountsUpdated += result.updated;
  }

  console.log(
    `[Bootstrap] System roles synced (${roles.created} created, ${roles.updated} updated); `
      + `currencies are ready; chart of accounts synced for ${companies.length} companies `
      + `(${accountsCreated} created, ${accountsUpdated} updated).`,
  );
}

module.exports = { initializeRequiredData, syncCompanyChartOfAccounts };

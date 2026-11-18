'use strict';

const { randomBytes, randomUUID } = require('crypto');

function validatedScratchUrl(value) {
  if (!value) throw new Error('POS_TEST_DATABASE_URL must be set for POS EBM database tests.');
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || databaseName !== 'testdatabase') {
    throw new Error('POS EBM database tests are restricted to the local testdatabase scratch database.');
  }
  return url.toString();
}

const scratchUrl = validatedScratchUrl(process.env.POS_TEST_DATABASE_URL);
process.env.DATABASE_URL = scratchUrl;
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const legacyCompanyId = '000000000000000000000001';
const legacyQueueId = '000000000000000000000002';

function id() { return randomBytes(12).toString('hex'); }

async function insertCompany(companyId = id(), client = prisma) {
  await client.$executeRaw`
    INSERT INTO companies (id, name, code, updated_at)
    VALUES (${companyId}, ${`EBM test ${companyId}`}, ${`ebm-${companyId}`}, NOW())
  `;
  return companyId;
}

async function insertQueue(companyId, {
  queueId = id(), documentId = id(), registerId = null,
  salesTyCd = null, rcptTyCd = null, signedAt = null, fiscalDataSource = null,
  resolvedAt = null, v2ResolvedAt = null,
  managerApprovalId = null, secondApproverId = null, resolvedById = null,
  resolution = null, resolutionReason = null, managerEvidenceNote = null,
  endpoint = '/saveSales', operationKey = 'default', environment = 'sandbox',
} = {}) {
  await prisma.$executeRaw`
    INSERT INTO ebm_submission_queues
      (id, company_id, document_type, document_id, endpoint, payload, updated_at,
       register_id, sales_ty_cd, rcpt_ty_cd, signed_at, fiscal_data_source,
       resolved_at, v2_resolved_at, operation_key, environment, manager_approval_id,
       second_approver_id, resolved_by_id, resolution, resolution_reason, manager_evidence_note)
    VALUES
      (${queueId}, ${companyId}, 'invoice', ${documentId}, ${endpoint}, '{}'::jsonb, NOW(),
       ${registerId}, ${salesTyCd}, ${rcptTyCd}, ${signedAt}, ${fiscalDataSource},
       ${resolvedAt}, ${v2ResolvedAt}, ${operationKey}, ${environment}, ${managerApprovalId},
       ${secondApproverId}, ${resolvedById}, ${resolution}, ${resolutionReason}, ${managerEvidenceNote})
  `;
  return { queueId, documentId };
}

async function insertInvoice(companyId) {
  const clientId = id();
  const invoiceId = id();
  await prisma.$executeRaw`
    INSERT INTO clients (id, company_id, name, code, updated_at)
    VALUES (${clientId}, ${companyId}, 'EBM test customer', ${`c-${clientId}`}, NOW())
  `;
  await prisma.$executeRaw`
    INSERT INTO invoices (id, company_id, reference_no, client_id, due_date, updated_at)
    VALUES (${invoiceId}, ${companyId}, ${`i-${invoiceId}`}, ${clientId}, NOW(), NOW())
  `;
  return { clientId, invoiceId };
}

async function cleanupCompany(companyId) {
  await prisma.$executeRaw`DELETE FROM pos_ebm_receipt_reprints WHERE company_id = ${companyId}`;
  await prisma.$executeRaw`DELETE FROM invoice_receipt_metadata WHERE company_id = ${companyId}`;
  await prisma.$executeRaw`DELETE FROM ebm_submission_queues WHERE company_id = ${companyId}`;
  await prisma.$executeRaw`DELETE FROM companies WHERE id = ${companyId}`;
}

describe('POS EBM additive schema on the designated scratch database', () => {
  beforeAll(async () => {
    const [{ name }] = await prisma.$queryRaw`SELECT current_database() AS name`;
    if (name !== 'testdatabase') throw new Error(`Refusing test run against database ${name}.`);
    await cleanupCompany(legacyCompanyId);
    await prisma.$executeRaw`INSERT INTO companies (id, name, code, updated_at) VALUES (${legacyCompanyId}, 'EBM legacy semantics fixture', 'ebm-legacy-semantics', NOW())`;
    await prisma.$executeRaw`
      INSERT INTO ebm_submission_queues
        (id, company_id, document_type, document_id, endpoint, payload, ebm_status, resolved_at, updated_at)
      VALUES (${legacyQueueId}, ${legacyCompanyId}, 'invoice', '000000000000000000000003', '/saveSales', '{}'::jsonb, 'submitted', '2026-10-01T12:00:00Z', NOW())
    `;
  });

  afterAll(async () => {
    await cleanupCompany(legacyCompanyId);
    await prisma.$disconnect();
  });

  test('backfills one matching fiscal entitlement for every existing company', async () => {
    const [result] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE e.id IS NULL)::int AS missing,
        COUNT(*) FILTER (
          WHERE e.id IS NOT NULL
            AND e.status <> CASE WHEN c.ebm_enabled THEN 'on' ELSE 'off' END
        )::int AS mismatched
      FROM companies c
      LEFT JOIN company_module_entitlements e
        ON e.company_id = c.id AND e.module_code = 'fiscal.ebm'
    `;
    expect(result.missing).toBe(0);
    expect(result.mismatched).toBe(0);
  });

  test('new companies default to EBM off in the legacy mirror and entitlement', async () => {
    const companyId = await insertCompany();
    try {
      const rows = await prisma.$queryRaw`
        SELECT c.ebm_enabled, e.status AS module_status
        FROM companies c
        JOIN company_module_entitlements e
          ON e.company_id = c.id AND e.module_code = 'fiscal.ebm'
        WHERE c.id = ${companyId}
      `;
      expect(rows).toEqual([{ ebm_enabled: false, module_status: 'off' }]);
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('platform module audit rows reject update, delete and truncate', async () => {
    async function expectMutationBlocked(operation) {
      const companyId = id();
      const actorId = id();
      const auditId = id();
      let mutationError;
      try {
        await prisma.$transaction(async (tx) => {
          await insertCompany(companyId, tx);
          await tx.$executeRaw`
            INSERT INTO users (id, name, email, password, updated_at)
            VALUES (${actorId}, 'Audit probe', ${`audit-probe-${actorId}@example.invalid`}, 'unused', NOW())
          `;
          await tx.$executeRaw`
            INSERT INTO platform_module_audit_logs
              (id, company_id, module_code, actor_user_id, event_type, old_status, new_status,
               reason, result, correlation_id, effective_at, created_at)
            VALUES
              (${auditId}, ${companyId}, 'fiscal.ebm', ${actorId}, 'probe', 'on', 'off',
               'Rollback-only immutability probe', 'probe', ${randomUUID()}::uuid, NOW(), NOW())
          `;
          if (operation === 'UPDATE') {
            await tx.$executeRaw`
              UPDATE platform_module_audit_logs SET result = 'tampered' WHERE id = ${auditId}
            `;
          } else {
            await tx.$executeRaw`
              DELETE FROM platform_module_audit_logs WHERE id = ${auditId}
            `;
          }
          throw new Error('__AUDIT_MUTATION_SUCCEEDED__');
        });
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toBeDefined();
      const errorMessage = `${mutationError.message} ${mutationError.meta?.message || ''}`;
      expect(errorMessage).not.toContain('__AUDIT_MUTATION_SUCCEEDED__');
      expect(errorMessage).toMatch(/Platform module audit rows are append-only/);
    }

    await expectMutationBlocked('UPDATE');
    await expectMutationBlocked('DELETE');
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`TRUNCATE TABLE platform_module_audit_logs`;
      throw new Error('__TRUNCATE_SUCCEEDED__');
    })).rejects.toThrow(/Platform module audit rows are append-only/);
  });

  test('does not reuse legacy resolved_at as the V2 resolution timestamp', async () => {
    const rows = await prisma.$queryRaw`
      SELECT resolved_at, v2_resolved_at, request_sent_at
      FROM ebm_submission_queues WHERE id = ${legacyQueueId} AND company_id = ${legacyCompanyId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].resolved_at).toEqual(new Date('2026-10-01T12:00:00.000Z'));
    expect(rows[0].v2_resolved_at).toBeNull();
    expect(rows[0].request_sent_at).toBeNull();
  });

  test('requires a deadline when offline queueing is enabled', async () => {
    const companyId = await insertCompany();
    try {
      await expect(prisma.$executeRaw`
        INSERT INTO pos_ebm_settings (id, company_id, queue_when_unavailable, updated_at)
        VALUES (${id()}, ${companyId}, TRUE, NOW())
      `).rejects.toThrow();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('rejects a second receipt-type queue row for the same company document and fiscal codes', async () => {
    const companyId = await insertCompany();
    const documentId = id();
    try {
      await insertQueue(companyId, { documentId, salesTyCd: 'N', rcptTyCd: 'S', operationKey: 'first' });
      await expect(insertQueue(companyId, { documentId, salesTyCd: 'N', rcptTyCd: 'S', operationKey: 'second' })).rejects.toThrow();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('requires fiscal_data_source on signed V2 rows and accepts the declared source', async () => {
    const companyId = await insertCompany();
    const registerId = id();
    await prisma.$executeRaw`
      INSERT INTO pos_registers (id, company_id, code, name, updated_at)
      VALUES (${registerId}, ${companyId}, ${`reg-${registerId}`}, 'EBM test register', NOW())
    `;
    try {
      await expect(insertQueue(companyId, {
        registerId, salesTyCd: 'N', rcptTyCd: 'S', signedAt: new Date(),
      })).rejects.toThrow();
      await expect(insertQueue(companyId, {
        registerId, salesTyCd: 'N', rcptTyCd: 'S', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE',
      })).resolves.toBeDefined();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('accepts the 20-character fiscal-entry manager approval action', async () => {
    const companyId = await insertCompany();
    try {
      await prisma.$executeRaw`
        INSERT INTO pos_manager_approvals
          (id, company_id, cashier_id, manager_id, action, payload_hash, expires_at)
        VALUES (${id()}, ${companyId}, ${id()}, ${id()}, 'FISCAL_RECEIPT_ENTRY', 'test-hash', NOW() + INTERVAL '1 hour')
      `;
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('manual signed receipt entry needs a separate approver, evidence and recorded resolution', async () => {
    const companyId = await insertCompany();
    const managerApprovalId = id();
    await prisma.$executeRaw`
      INSERT INTO pos_manager_approvals
        (id, company_id, cashier_id, manager_id, action, payload_hash, expires_at)
      VALUES (${managerApprovalId}, ${companyId}, ${id()}, ${id()}, 'FISCAL_RECEIPT_ENTRY', 'entry-hash', NOW() + INTERVAL '1 hour')
    `;
    const fields = {
      salesTyCd: 'N', rcptTyCd: 'S', signedAt: new Date(), fiscalDataSource: 'MANAGER_ENTRY',
      managerApprovalId, secondApproverId: id(), resolvedById: id(), resolution: 'CONFIRMED_SIGNED',
      resolutionReason: 'Verified with RRA', v2ResolvedAt: new Date(),
    };
    try {
      await expect(insertQueue(companyId, fields)).rejects.toThrow();
      await expect(insertQueue(companyId, { ...fields, managerEvidenceNote: 'RRA confirmation reference 123' })).resolves.toBeDefined();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('keeps tenant deletion as soft deactivation without deleting fiscal records', async () => {
    const companyId = await insertCompany();
    const { queueId } = await insertQueue(companyId, { salesTyCd: 'N', rcptTyCd: 'S' });
    try {
      await prisma.$executeRaw`UPDATE companies SET is_active = FALSE WHERE id = ${companyId}`;
      const company = await prisma.$queryRaw`SELECT is_active FROM companies WHERE id = ${companyId}`;
      expect(company[0].is_active).toBe(false);
      const queue = await prisma.$queryRaw`SELECT id FROM ebm_submission_queues WHERE id = ${queueId}`;
      expect(queue).toHaveLength(1);
    } finally {
      await cleanupCompany(companyId);
    }
  });

  test('serializes concurrent reprints on the invoice row and allocates distinct copy numbers', async () => {
    const companyId = await insertCompany();
    const { invoiceId } = await insertInvoice(companyId);
    const { queueId: submissionId } = await insertQueue(companyId, {
      documentId: invoiceId, salesTyCd: 'N', rcptTyCd: 'S', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE',
    });
    const allocate = (key) => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
      const [{ next_copy }] = await tx.$queryRaw`
        SELECT COALESCE(MAX(copy_number), 0) + 1 AS next_copy
        FROM pos_ebm_receipt_reprints WHERE company_id = ${companyId} AND invoice_id = ${invoiceId}
      `;
      await tx.$executeRaw`
        INSERT INTO pos_ebm_receipt_reprints
          (id, company_id, invoice_id, submission_id, actor_user_id, copy_number, idempotency_key)
        VALUES (${id()}, ${companyId}, ${invoiceId}, ${submissionId}, ${id()}, ${Number(next_copy)}, ${key})
      `;
      return Number(next_copy);
    });
    try {
      const copies = await Promise.all([allocate(`copy-${id()}`), allocate(`copy-${id()}`)]);
      expect(copies.sort()).toEqual([1, 2]);
    } finally {
      await prisma.$executeRaw`DELETE FROM pos_ebm_receipt_reprints WHERE company_id = ${companyId}`;
      await cleanupCompany(companyId);
    }
  });

  test('blocks direct submission deletion but company cascade removes reprints and receipt metadata safely', async () => {
    const companyId = await insertCompany();
    const { invoiceId } = await insertInvoice(companyId);
    const { queueId: submissionId } = await insertQueue(companyId, {
      documentId: invoiceId, salesTyCd: 'N', rcptTyCd: 'S', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE',
    });
    try {
      await prisma.$executeRaw`
        INSERT INTO invoice_receipt_metadata (id, company_id, invoice_id, submission_id, updated_at)
        VALUES (${id()}, ${companyId}, ${invoiceId}, ${submissionId}, NOW())
      `;
      await prisma.$executeRaw`
        INSERT INTO pos_ebm_receipt_reprints
          (id, company_id, invoice_id, submission_id, actor_user_id, copy_number, idempotency_key)
        VALUES (${id()}, ${companyId}, ${invoiceId}, ${submissionId}, ${id()}, 1, ${`reprint-${id()}`})
      `;
      await expect(prisma.$executeRaw`DELETE FROM ebm_submission_queues WHERE id = ${submissionId}`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM companies WHERE id = ${companyId}`).resolves.toBe(1);
      const [queues, metadata, reprints] = await Promise.all([
        prisma.$queryRaw`SELECT id FROM ebm_submission_queues WHERE id = ${submissionId}`,
        prisma.$queryRaw`SELECT id FROM invoice_receipt_metadata WHERE company_id = ${companyId}`,
        prisma.$queryRaw`SELECT id FROM pos_ebm_receipt_reprints WHERE company_id = ${companyId}`,
      ]);
      expect(queues).toHaveLength(0);
      expect(metadata).toHaveLength(0);
      expect(reprints).toHaveLength(0);
    } finally {
      await cleanupCompany(companyId);
    }
  });
});

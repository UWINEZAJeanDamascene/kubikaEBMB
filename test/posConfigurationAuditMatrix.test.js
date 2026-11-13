'use strict';

const fs = require('fs');
const path = require('path');
const { POS_AUDIT_EVENTS } = require('../services/posAuditService');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('POS configuration and customer audit inventory', () => {
  const matrix = read('docs/pos/configuration-audit-matrix.md');

  test('keeps the requested areas and their mutation paths in the review matrix', () => {
    for (const route of [
      'PUT /api/pos/register-settings',
      'PUT /api/pos/register-settings/payment-methods',
      'POST /api/pos/registers/:registerId/activate',
      'PUT /api/pos/registers/:registerId/cashier-access',
      '`POST /api/customers`, `/quick-add`',
      'POST /api/customers/:id/loyalty-adjustments',
      '`POST /api/sales-legacy/vouchers`, `/vouchers/bulk-generate`',
      'PATCH /api/ebm/pos-settings',
      'POST /api/sales-legacy/receipt/:invoiceId/reprint',
      '`POST /api/sales-legacy/receipt/:invoiceId/reprint`, `/public-link`',
    ]) expect(matrix).toContain(route.startsWith('`') ? route : `\`${route}\``);
  });

  test('all documented domain event names are present in the allowlist', () => {
    const eventNames = [...matrix.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]);
    const domainEvents = eventNames.filter((event) => /^(REGISTER_|CUSTOMER_|VOUCHER_|POS_EBM_|EBM_V2_|POS_RECEIPT_|PRINT_JOB_)/.test(event));
    expect(domainEvents.length).toBeGreaterThan(20);
    for (const event of domainEvents) expect(POS_AUDIT_EVENTS.has(event)).toBe(true);
  });

  test('the schema and migration represent queryable action context without rewriting old rows', () => {
    const schema = read('prisma/schema.prisma');
    const migration = read('prisma/migrations/20261112100000_pos_audit_structured_action_context/migration.sql');
    for (const column of ['actionId', 'correlationId', 'outcome', 'entityType', 'entityId', 'hashVersion']) {
      expect(schema).toMatch(new RegExp(`\\b${column}\\s+String|\\b${column}\\s+Int`));
    }
    expect(migration).toContain('"action_id" CHAR(24)');
    expect(migration).toContain('"hash_version" SMALLINT');
    expect(migration).not.toMatch(/UPDATE\s+"pos_audit_logs"/i);
  });
});

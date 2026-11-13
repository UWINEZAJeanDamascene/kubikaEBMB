'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('POS financial audit matrix coverage', () => {
  const matrix = read('docs/pos/financial-audit-matrix.md');

  test('documents every registered POS payment, customer-credit, cheque, and stored-value mutation route', () => {
    const routes = read('routes/posRoutes.js');
    const registrations = [...routes.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)];
    const financialMutations = registrations
      .map(([, method, route]) => `${method.toUpperCase()} /api/pos${route}`)
      .filter((route) => /\/payments(?:-|\/)|\/credit-accounts(?:\/|$)|\/cheques(?:\/|$)/.test(route));

    expect(financialMutations.length).toBeGreaterThan(0);
    for (const route of financialMutations) {
      expect(matrix).toContain(`\`${route}\``);
    }
  });

  test('documents the legacy sale and stored-value write routes', () => {
    const routes = read('routes/salesLegacyRoutes.js');
    expect(routes).toContain("router.post('/direct-sale'");
    expect(routes).toContain("router.post('/stored-value/issue'");
    expect(matrix).toContain('`POST /api/sales-legacy/direct-sale`');
    expect(matrix).toContain('`POST /api/sales-legacy/stored-value/issue`');
  });

  test('documents each POS-origin credit-note mutation path', () => {
    const routes = read('routes/creditNoteRoutes.js');
    expect(routes).toContain(".post(authorizeCreditNoteDraft");
    expect(routes).toContain("router.post('/:id/confirm'");
    expect(routes).toContain("router.post('/:id/refund'");
    expect(matrix).toContain('`POST /api/credit-notes` with `posOrigin: true`');
    expect(matrix).toContain('`POST /api/credit-notes/:id/confirm`');
    expect(matrix).toContain('`POST /api/credit-notes/:id/refund`');
  });
});

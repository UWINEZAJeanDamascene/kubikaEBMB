const test = require('node:test');
const assert = require('node:assert/strict');
const { hydrateReferencedJob } = require('../../src/documentHydration');

test('hydrates a stored job reference and keeps rendering options outside the document body', async () => {
  const job = {
    jobType: 'gift-card-slip',
    documentId: 'a'.repeat(24),
    documentVersion: 2,
    copyRequired: true,
    copyNumber: 1,
  };
  let retrieved;
  const result = await hydrateReferencedJob(job, async (documentId, version) => {
    retrieved = { documentId, version };
    return {
      documentType: 'gift-card-slip',
      payloadJson: { shopName: 'Kubika Shop', giftCard: { code: 'EFGH' } },
    };
  }, {
    documentId: job.documentId,
    documentVersion: 2,
    columns: 32,
    labels: { total: 'Total' },
  });

  assert.deepEqual(retrieved, { documentId: job.documentId, version: 2 });
  assert.deepEqual(result.payloadJson, {
    shopName: 'Kubika Shop',
    giftCard: { code: 'EFGH' },
    columns: 32,
    labels: { total: 'Total' },
    copyNumber: 1,
    copyRequired: true,
  });
  assert.equal(Object.hasOwn(result.payloadJson, 'documentId'), false);
});

test('leaves legacy jobs with embedded payloads unchanged', async () => {
  const job = { jobType: 'receipt', payloadJson: { receipt: { version: 1 } } };
  const result = await hydrateReferencedJob(job, async () => {
    throw new Error('No document reference should be fetched.');
  });
  assert.equal(result, job);
});

test('rejects invalid and mismatched stored-document references', async () => {
  await assert.rejects(
    hydrateReferencedJob({ jobType: 'z-report', documentId: 'invalid', documentVersion: 1 }, async () => ({})),
    { code: 'PRINT_DOCUMENT_REFERENCE_INVALID' },
  );
  await assert.rejects(
    hydrateReferencedJob({
      jobType: 'z-report',
      documentId: 'a'.repeat(24),
      documentVersion: 1,
    }, async () => ({ documentType: 'cash-movement-slip', payloadJson: {} })),
    { code: 'PRINT_DOCUMENT_TYPE_MISMATCH' },
  );
});

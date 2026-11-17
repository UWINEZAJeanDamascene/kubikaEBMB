async function hydrateReferencedJob(job, retrieveDocument, renderOptions = {}) {
  const documentId = String(job.documentId || job.document_id || renderOptions.documentId || '');
  const version = Number(job.documentVersion || job.document_version || renderOptions.documentVersion);
  if (!documentId && !version) return job;
  if (!/^[a-f\d]{24}$/i.test(documentId) || !Number.isSafeInteger(version) || version < 1) {
    throw Object.assign(new Error('The print job has an invalid stored-document reference.'), {
      code: 'PRINT_DOCUMENT_REFERENCE_INVALID',
    });
  }
  const document = await retrieveDocument(documentId, version);
  if (document?.documentType !== (job.jobType || job.job_type)) {
    throw Object.assign(new Error('The stored document type does not match the print job.'), {
      code: 'PRINT_DOCUMENT_TYPE_MISMATCH',
    });
  }
  const options = { ...renderOptions };
  delete options.documentId;
  delete options.documentVersion;
  return {
    ...job,
    documentId,
    documentVersion: version,
    payloadJson: {
      ...(document.payloadJson || {}),
      ...options,
      copyNumber: Number(job.copyNumber ?? job.copy_number ?? options.copyNumber ?? 0),
      copyRequired: Boolean(job.copyRequired ?? job.copy_required ?? options.copyRequired),
    },
  };
}

module.exports = { hydrateReferencedJob };

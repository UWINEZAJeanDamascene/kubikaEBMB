const errorHandler = (err, req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';
  const exposeStack = process.env.NODE_ENV !== 'production';

  if (!isProd) {
    console.error(err);
  }

  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Server Error';
  let code = err.code;

  if (err.name === 'CastError') {
    statusCode = 422;
    message = 'Invalid id';
    code = 'INVALID_ID';
  } else if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    statusCode = 409;
    message = `Duplicate field value: ${field}. Please use another value`;
    code = 'DUPLICATE_KEY';
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors || {}).map((v) => v.message).join(', ');
    code = 'VALIDATION_ERROR';
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
    code = 'INVALID_TOKEN';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
    code = 'TOKEN_EXPIRED';
  } else if (err.code === 'PERIOD_CLOSED') {
    statusCode = 409;
    code = 'PERIOD_CLOSED';
    message = err.message || 'Accounting period is closed';
  } else if (err.code === 'INSUFFICIENT_STOCK') {
    statusCode = 409;
    code = 'INSUFFICIENT_STOCK';
    message = err.message || 'Insufficient stock';
  } else if (err.code === 'NOT_FOUND') {
    statusCode = 404;
    code = 'NOT_FOUND';
    message = err.message || 'Resource not found';
  } else if (typeof err.code === 'string' && /^P\d{4}$/.test(err.code)) {
    // Do not return raw Prisma constraint and database diagnostics to clients.
    statusCode = 500;
    code = 'INTERNAL_ERROR';
    message = 'An unexpected error occurred';
  } else if (err.code === 'AGGREGATE_ROW_LIMIT') {
    // The compatibility pipeline refuses to return a silently truncated
    // aggregate. Existing frontend dashboard/report error states surface this
    // response and offer retry rather than rendering wrong financial totals.
    statusCode = 413;
    code = 'AGGREGATE_ROW_LIMIT';
    message = err.message || 'This report is too large to calculate in the API process.';
  } else if (['QUERY_LIMIT_EXCEEDED', 'QUERY_PARAMETER_INVALID', 'READ_BATCH_EXCEEDED'].includes(err.code)) {
    statusCode = err.statusCode || (err.code === 'QUERY_PARAMETER_INVALID' ? 400 : 413);
    code = err.code;
    message = err.message || 'The requested read exceeds the allowed page or batch size.';
  } else if (err.code === 'TENANT_SCOPE_REQUIRED' || err.code === 'QUERY_LIMIT_REQUIRED') {
    statusCode = 500;
    code = err.code;
    message = err.message || 'The server rejected an unsafe data query.';
  } else if (err.code === 50 || err.codeName === 'MaxTimeMSExpired') {
    statusCode = 503;
    code = 'QUERY_TIMEOUT';
    message = err.message || 'Query timed out';
    if (req && req.method && req.path) {
      console.warn(`[QUERY_TIMEOUT] ${req.method} ${req.path}`);
    }
  }

  if (!code) {
    code = statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR';
  }

  if (isProd && statusCode >= 500) {
    console.error('[api-error]', {
      method: req && req.method,
      path: req && (req.originalUrl || req.path).split('?')[0],
      statusCode,
      errorName: err.name || 'Error',
      errorCode: err.code,
      errorMessage: err.message,
    });
  }

  if (isProd && statusCode === 500 && code === 'INTERNAL_ERROR') {
    message = 'An unexpected error occurred';
  }

  const payload = {
    success: false,
    message,
    code,
    ...(typeof err.resultCd === 'string' && /^\d{3}$/.test(err.resultCd)
      ? {
          resultCd: err.resultCd,
          ...(typeof err.resultCodeSystem === 'string' ? { resultCodeSystem: err.resultCodeSystem } : {}),
          ...(typeof err.resultCodeDescription === 'string' ? { resultCodeDescription: err.resultCodeDescription } : {}),
        }
      : {}),
    ...(typeof err.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(err.requestId)
      ? { requestId: err.requestId }
      : {}),
  };

  if (exposeStack && err.stack) {
    payload.stack = err.stack;
  }

  res.status(statusCode).json(payload);
};

module.exports = errorHandler;

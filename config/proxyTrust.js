'use strict';

function configureProxyTrust(app, nodeEnv = process.env.NODE_ENV) {
  const trustedHops = nodeEnv === 'production' ? 1 : false;
  app.set('trust proxy', trustedHops);
  return trustedHops;
}

module.exports = { configureProxyTrust };

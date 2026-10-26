'use strict';

const STOCK_SAVE_GATES = Object.freeze({
  '/stock/saveStockItems': Object.freeze({
    endpointFlag: 'EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED',
    contractFlag: 'EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED',
    sandboxFlag: 'EBM_STOCK_MOVEMENT_SANDBOX_VERIFIED',
    label: 'stock-movement',
    endpointCode: 'EBM_STOCK_MOVEMENT_ENDPOINT_UNCONFIRMED',
    contractCode: 'EBM_STOCK_MOVEMENT_CONTRACT_UNCONFIRMED',
    sandboxCode: 'EBM_STOCK_MOVEMENT_SANDBOX_UNVERIFIED',
    endpointMessage: 'Stock-movement endpoint path is not confirmed by an authorized RRA/integrator source.',
    contractMessage: 'Stock-movement field mappings and business semantics are not confirmed by an authorized RRA/integrator source.',
    sandboxMessage: 'Production stock-movement dispatch requires recorded approved sandbox verification.',
  }),
  '/stock/saveStockMaster': Object.freeze({
    endpointFlag: 'EBM_STOCK_MASTER_ENDPOINT_CONFIRMED',
    contractFlag: 'EBM_STOCK_MASTER_CONTRACT_CONFIRMED',
    sandboxFlag: 'EBM_STOCK_MASTER_SANDBOX_VERIFIED',
    label: 'stock-master',
    endpointCode: 'EBM_STOCK_MASTER_ENDPOINT_UNCONFIRMED',
    contractCode: 'EBM_STOCK_MASTER_CONTRACT_UNCONFIRMED',
    sandboxCode: 'EBM_STOCK_MASTER_SANDBOX_UNVERIFIED',
    endpointMessage: 'Stock-master endpoint path is not confirmed by an authorized RRA/integrator source.',
    contractMessage: 'Stock-master field mapping and business semantics are not confirmed by an authorized RRA/integrator source.',
    sandboxMessage: 'Production stock-master dispatch requires recorded approved sandbox verification.',
  }),
});

function getStockSaveBlock(endpoint, mode) {
  if (mode === 'mock') return null;
  const gate = STOCK_SAVE_GATES[endpoint];
  if (!gate) return null;

  if (process.env[gate.endpointFlag] !== 'true') {
    return { code: gate.endpointCode, message: gate.endpointMessage };
  }
  if (process.env[gate.contractFlag] !== 'true') {
    return { code: gate.contractCode, message: gate.contractMessage };
  }
  if (mode === 'production' && process.env[gate.sandboxFlag] !== 'true') {
    return { code: gate.sandboxCode, message: gate.sandboxMessage };
  }
  return null;
}

module.exports = { getStockSaveBlock, STOCK_SAVE_GATES };

'use strict';

const DEFAULT_DRAWER_SETTINGS = Object.freeze({
  cashSale: true,
  onlyWhenChangeDue: false,
  paidIn: false,
  paidOut: false,
  shiftOpen: false,
  shiftClose: false,
  noSale: true,
});
const PRINTER_ROLES = Object.freeze(['receipt', 'report', 'a4', 'kitchen', 'bar']);
const PRINT_PATHS = Object.freeze(['agent', 'serial', 'browser']);
const DEFAULT_PRINT_ROUTING = Object.freeze({
  order: Object.freeze(['agent', 'serial', 'browser']),
  pinnedPath: null,
  allowFallback: true,
});
const DRAWER_KEYS = Object.keys(DEFAULT_DRAWER_SETTINGS);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function resolveDrawerSettings(settings, tillType, registerId) {
  const saved = isRecord(settings) ? settings : {};
  const tillOverrides = isRecord(saved.tillTypeOverrides) ? saved.tillTypeOverrides : {};
  const registerOverrides = isRecord(saved.registerOverrides) ? saved.registerOverrides : {};
  const tillSettings = isRecord(tillOverrides[tillType]) ? tillOverrides[tillType] : {};
  const registerSettings = isRecord(registerOverrides[registerId]) ? registerOverrides[registerId] : {};
  const companySettings = isRecord(saved.companyDefaults) ? saved.companyDefaults : {};
  return {
    ...DEFAULT_DRAWER_SETTINGS,
    ...companySettings,
    ...tillSettings,
    ...registerSettings,
  };
}

function resolveHardwareSettings(settings, tillType, registerId) {
  const saved = isRecord(settings) ? settings : {};
  const tillOverrides = isRecord(saved.tillTypeOverrides) ? saved.tillTypeOverrides : {};
  const registerOverrides = isRecord(saved.registerOverrides) ? saved.registerOverrides : {};
  const companySettings = isRecord(saved.companyDefaults) ? saved.companyDefaults : {};
  const tillSettings = isRecord(tillOverrides[tillType]) ? tillOverrides[tillType] : {};
  const registerSettings = isRecord(registerOverrides[registerId]) ? registerOverrides[registerId] : {};
  const rawRouting = {
    ...DEFAULT_PRINT_ROUTING,
    ...(isRecord(companySettings.printRouting) ? companySettings.printRouting : {}),
    ...(isRecord(tillSettings.printRouting) ? tillSettings.printRouting : {}),
    ...(isRecord(registerSettings.printRouting) ? registerSettings.printRouting : {}),
  };
  return {
    printerRoles: {
      ...(isRecord(companySettings.printerRoles) ? companySettings.printerRoles : {}),
      ...(isRecord(tillSettings.printerRoles) ? tillSettings.printerRoles : {}),
      ...(isRecord(registerSettings.printerRoles) ? registerSettings.printerRoles : {}),
    },
    printRouting: validatePrintRouting(rawRouting) || DEFAULT_PRINT_ROUTING,
  };
}

function validateDrawerSettings(values) {
  if (!isRecord(values)) return null;
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    if (!DRAWER_KEYS.includes(key) || typeof value !== 'boolean') return null;
    result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

function validatePrinterRoles(values) {
  if (!isRecord(values)) return null;
  const result = {};
  for (const [role, printerId] of Object.entries(values)) {
    const isPrinterId = typeof printerId === 'string' && /^[a-f\d]{24}$/i.test(printerId);
    const isRoleSelector = typeof printerId === 'string' && /^role:(receipt|report|a4|kitchen|bar)$/.test(printerId);
    if (!PRINTER_ROLES.includes(role) || (printerId !== null && !isPrinterId && !isRoleSelector)) {
      return null;
    }
    result[role] = printerId;
  }
  return Object.keys(result).length ? result : null;
}

function validatePrintRouting(value) {
  if (!isRecord(value)) return null;
  const order = value.order;
  const pinnedPath = value.pinnedPath === null || value.pinnedPath === '' ? null : value.pinnedPath;
  if (!Array.isArray(order) || order.length < 1
    || order.some((path) => !PRINT_PATHS.includes(path))
    || new Set(order).size !== order.length
    || (pinnedPath !== null && !PRINT_PATHS.includes(pinnedPath))
    || (pinnedPath !== null && !order.includes(pinnedPath))
    || typeof value.allowFallback !== 'boolean') return null;
  return { order: [...order], pinnedPath, allowFallback: value.allowFallback };
}

function drawerActionEnabled(settings, actionType, context = {}) {
  switch (actionType) {
    case 'cash-sale':
      return settings.cashSale === true
        && Number(context.cashTenderAmount) > 0
        && (settings.onlyWhenChangeDue !== true || Number(context.changeDue) > 0);
    case 'no-sale':
      return settings.noSale === true && Boolean(context.approvalId) && Boolean(context.reason);
    case 'paid-in':
      return settings.paidIn === true;
    case 'paid-out':
      return settings.paidOut === true;
    case 'shift-open':
      return settings.shiftOpen === true;
    case 'shift-close':
      return settings.shiftClose === true;
    case 'test':
      return true;
    default:
      return false;
  }
}

function withDrawerSettings(settings, scope, key, values) {
  const next = {
    companyDefaults: { ...DEFAULT_DRAWER_SETTINGS },
    tillTypeOverrides: {},
    registerOverrides: {},
    ...(isRecord(settings) ? settings : {}),
  };
  if (scope === 'register') {
    if (!key) throw new TypeError('A register ID is required for register-scoped drawer settings.');
    next.registerOverrides = {
      ...next.registerOverrides,
      [key]: { ...(isRecord(next.registerOverrides?.[key]) ? next.registerOverrides[key] : {}), ...values },
    };
  } else if (scope === 'tillType') {
    if (!key) throw new TypeError('A till type is required for till-type drawer settings.');
    next.tillTypeOverrides = {
      ...next.tillTypeOverrides,
      [key]: { ...(isRecord(next.tillTypeOverrides?.[key]) ? next.tillTypeOverrides[key] : {}), ...values },
    };
  } else if (scope === 'company') {
    next.companyDefaults = { ...next.companyDefaults, ...values };
  } else {
    throw new TypeError('Drawer settings scope is invalid.');
  }
  return next;
}

function withHardwareSettings(settings, scope, key, printerRoles, printRouting) {
  const next = {
    companyDefaults: { printerRoles: {} },
    tillTypeOverrides: {},
    registerOverrides: {},
    ...(isRecord(settings) ? settings : {}),
  };
  if (scope === 'register') {
    if (!key) throw new TypeError('A register ID is required for register-scoped hardware settings.');
    const previous = isRecord(next.registerOverrides?.[key]) ? next.registerOverrides[key] : {};
    next.registerOverrides = {
      ...next.registerOverrides,
      [key]: {
        ...previous,
        ...(printerRoles ? { printerRoles: { ...(isRecord(previous.printerRoles) ? previous.printerRoles : {}), ...printerRoles } } : {}),
        ...(printRouting ? { printRouting } : {}),
      },
    };
  } else if (scope === 'tillType') {
    if (!key) throw new TypeError('A till type is required for till-type hardware settings.');
    const previous = isRecord(next.tillTypeOverrides?.[key]) ? next.tillTypeOverrides[key] : {};
    next.tillTypeOverrides = {
      ...next.tillTypeOverrides,
      [key]: {
        ...previous,
        ...(printerRoles ? { printerRoles: { ...(isRecord(previous.printerRoles) ? previous.printerRoles : {}), ...printerRoles } } : {}),
        ...(printRouting ? { printRouting } : {}),
      },
    };
  } else if (scope === 'company') {
    const previous = isRecord(next.companyDefaults) ? next.companyDefaults : {};
    next.companyDefaults = {
      ...previous,
      ...(printerRoles ? { printerRoles: { ...(isRecord(previous.printerRoles) ? previous.printerRoles : {}), ...printerRoles } } : {}),
      ...(printRouting ? { printRouting } : {}),
    };
  } else {
    throw new TypeError('Hardware settings scope is invalid.');
  }
  return next;
}

module.exports = {
  DEFAULT_DRAWER_SETTINGS,
  DEFAULT_PRINT_ROUTING,
  drawerActionEnabled,
  resolveDrawerSettings,
  resolveHardwareSettings,
  validateDrawerSettings,
  validatePrinterRoles,
  validatePrintRouting,
  withDrawerSettings,
  withHardwareSettings,
};

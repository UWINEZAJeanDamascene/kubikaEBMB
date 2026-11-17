'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  resolveDrawerSettings,
  resolveHardwareSettings,
  validateDrawerSettings,
  validatePrinterRoles,
  validatePrintRouting,
  withDrawerSettings,
  withHardwareSettings,
} = require('../services/posDrawerPolicyService');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');

exports.getHardwareSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.query.registerId || '');
    if (!/^[a-f\d]{24}$/i.test(registerId)) {
      return res.status(400).json({ success: false, code: 'POS_REGISTER_INVALID', message: 'Select a valid POS register.' });
    }
    const [register, saved] = await Promise.all([
      prisma.posRegister.findFirst({
        where: { id: registerId, companyId, isActive: true },
        select: { id: true, name: true, systemTillType: true },
      }),
      prisma.systemSettings.findUnique({
        where: { companyId },
        select: { posDrawerSettings: true, posHardwareSettings: true },
      }),
    ]);
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active register not found.' });
    const [devices, printers] = await Promise.all([
      prisma.posHardwareDevice.findMany({
        where: { companyId, registerId },
        include: { printer: true },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      }),
      prisma.posPrintPrinter.findMany({
        where: {
          companyId,
          agent: { registerId, status: 'active', revokedAt: null },
        },
        select: { id: true, name: true, role: true, paperSize: true, copies: true, tray: true, duplex: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return res.json({
      success: true,
      data: {
        register,
        drawerSettings: resolveDrawerSettings(saved?.posDrawerSettings, register.systemTillType, registerId),
        hardwareSettings: resolveHardwareSettings(saved?.posHardwareSettings, register.systemTillType, registerId),
        drawerConfiguration: saved?.posDrawerSettings || {},
        hardwareConfiguration: saved?.posHardwareSettings || {},
        devices,
        printers,
      },
    });
  } catch (error) { return next(error); }
};

exports.saveHardwareSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const scope = String(req.body.scope || '');
    const key = String(scope === 'register' ? req.body.registerId || '' : scope === 'tillType' ? req.body.tillType || '' : 'company');
    const drawerSettings = req.body.drawerSettings === undefined ? null : validateDrawerSettings(req.body.drawerSettings);
    const printerRoles = req.body.printerRoles === undefined ? null : validatePrinterRoles(req.body.printerRoles);
    const printRouting = req.body.printRouting === undefined ? null : validatePrintRouting(req.body.printRouting);
    if (!['company', 'tillType', 'register'].includes(scope)
      || (req.body.drawerSettings !== undefined && !drawerSettings)
      || (req.body.printerRoles !== undefined && !printerRoles)
      || (req.body.printRouting !== undefined && !printRouting)
      || (!drawerSettings && !printerRoles && !printRouting)
      || (scope === 'register' && !/^[a-f\d]{24}$/i.test(key))
      || (scope === 'tillType' && (!key || key.length > 40))) {
      return res.status(400).json({ success: false, code: 'POS_HARDWARE_SETTINGS_INVALID', message: 'Hardware settings are invalid.' });
    }
    if (scope === 'register') {
      const register = await prisma.posRegister.findFirst({
        where: { id: key, companyId, isActive: true },
        select: { id: true, systemTillType: true },
      });
      if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active register not found.' });
    }
    if (printerRoles) {
      const printerIds = Object.values(printerRoles).filter((value) => value && /^[a-f\d]{24}$/i.test(value));
      if (printerIds.length) {
        const validPrinters = await prisma.posPrintPrinter.findMany({
          where: {
            id: { in: printerIds },
            companyId,
            agent: { registerId: scope === 'register' ? key : undefined, status: 'active', revokedAt: null },
          },
          select: { id: true },
        });
        if (validPrinters.length !== new Set(printerIds).size) {
          return res.status(400).json({ success: false, code: 'PRINT_PRINTER_ROLE_INVALID', message: 'Printer roles must reference active printers assigned to this register.' });
        }
      }
    }
    const current = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: { posDrawerSettings: true, posHardwareSettings: true },
    });
    const nextDrawerSettings = drawerSettings
      ? withDrawerSettings(current?.posDrawerSettings, scope, key, drawerSettings)
      : current?.posDrawerSettings;
    const nextHardwareSettings = printerRoles || printRouting
      ? withHardwareSettings(current?.posHardwareSettings, scope, key, printerRoles, printRouting)
      : current?.posHardwareSettings;
    const settings = await prisma.systemSettings.upsert({
      where: { companyId },
      create: {
        id: generateObjectId(),
        companyId,
        ...(nextDrawerSettings ? { posDrawerSettings: nextDrawerSettings } : {}),
        ...(nextHardwareSettings ? { posHardwareSettings: nextHardwareSettings } : {}),
        lastUpdatedBy: String(req.user.id || req.user._id || '') || null,
      },
      update: {
        ...(nextDrawerSettings ? { posDrawerSettings: nextDrawerSettings } : {}),
        ...(nextHardwareSettings ? { posHardwareSettings: nextHardwareSettings } : {}),
        lastUpdatedBy: String(req.user.id || req.user._id || '') || null,
      },
      select: { posDrawerSettings: true, posHardwareSettings: true },
    });
    await writePosAuditLog({
      companyId,
      registerId: scope === 'register' ? key : null,
      userId: req.user.id || req.user._id,
      event: 'PRINT_DRAWER_SETTINGS_UPDATED',
      metadata: {
        scope,
        key,
        drawerSettingKeys: drawerSettings ? Object.keys(drawerSettings) : [],
        printerRoleKeys: printerRoles ? Object.keys(printerRoles) : [],
        printRoutingChanged: Boolean(printRouting),
      },
      ip: requestIp(req),
    });
    return res.json({
      success: true,
      data: {
        drawerSettings,
        hardwareSettings: printerRoles || printRouting
          ? resolveHardwareSettings(settings.posHardwareSettings, scope === 'tillType' ? key : '', scope === 'register' ? key : '')
          : null,
      },
    });
  } catch (error) { return next(error); }
};

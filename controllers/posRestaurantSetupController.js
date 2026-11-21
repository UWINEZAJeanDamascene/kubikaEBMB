'use strict';

const setupService = require('../services/posRestaurantSetupService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.company?.id || req.user?.companyId || req.companyId || '');
}

function handleError(error, res, next) {
  if (Number.isInteger(error?.statusCode)) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code || 'RESTAURANT_SETUP_INVALID',
      message: error.message,
    });
  }
  if (error?.code === 'P2002') {
    return res.status(409).json({
      success: false,
      code: 'RESTAURANT_SETUP_CONFLICT',
      message: 'A setup item with that name or product already exists.',
    });
  }
  if (error?.code === 'P2025') {
    return res.status(404).json({
      success: false,
      code: 'RESTAURANT_SETUP_NOT_FOUND',
      message: 'The setup item was not found for this company.',
    });
  }
  return next(error);
}

function action(statusCode, operation) {
  return async (req, res, next) => {
    try {
      const data = await operation(req, companyIdFor(req), setupService.createActor(req));
      return res.status(statusCode).json({ success: true, data });
    } catch (error) {
      return handleError(error, res, next);
    }
  };
}

exports.getSetup = action(200, (req, companyId) => (
  setupService.getSetup(companyId, req.query.productSearch)
));

exports.createMenuCategory = action(201, (req, companyId, actor) => (
  setupService.createMenuCategory(companyId, req.body, actor)
));

exports.updateMenuCategory = action(200, (req, companyId, actor) => (
  setupService.updateMenuCategory(companyId, req.params.categoryId, req.body, actor)
));

exports.createMenuItem = action(201, (req, companyId, actor) => (
  setupService.createMenuItem(companyId, req.body, actor)
));

exports.updateMenuItem = action(200, (req, companyId, actor) => (
  setupService.updateMenuItem(companyId, req.params.menuItemId, req.body, actor)
));

exports.createModifierGroup = action(201, (req, companyId, actor) => (
  setupService.createModifierGroup(companyId, req.body, actor)
));

exports.updateModifierGroup = action(200, (req, companyId, actor) => (
  setupService.updateModifierGroup(companyId, req.params.groupId, req.body, actor)
));

exports.createFloorArea = action(201, (req, companyId, actor) => (
  setupService.createFloorArea(companyId, req.body, actor)
));

exports.updateFloorArea = action(200, (req, companyId, actor) => (
  setupService.updateFloorArea(companyId, req.params.areaId, req.body, actor)
));

exports.createTable = action(201, (req, companyId, actor) => (
  setupService.createTable(companyId, req.params.areaId, req.body, actor)
));

exports.updateTable = action(200, (req, companyId, actor) => (
  setupService.updateTable(companyId, req.params.tableId, req.body, actor)
));


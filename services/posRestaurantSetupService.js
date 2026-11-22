'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { resolvePurchaseUnit, toBaseQuantity } = require('../utils/purchaseUnitRules');
const { activePromotion, normalizePromotion } = require('./posRestaurantPromotionRules');
const { requestIp, writePosAuditLog } = require('./posAuditService');

const DEFAULT_STATIONS = Object.freeze([
  { id: 'kitchen', code: 'KITCHEN', name: 'Kitchen', displayLabel: 'Kitchen screen', isActive: true },
  { id: 'bar', code: 'BAR', name: 'Bar', displayLabel: 'Bar screen', isActive: true },
]);
const MAX_SORT_ORDER = 100000;
const MAX_PRICE_ADJUSTMENT = 999999999999999;

function setupError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function requireCompany(companyId) {
  const normalized = String(companyId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(normalized)) {
    throw setupError('RESTAURANT_COMPANY_REQUIRED', 'Select a valid company before editing Restaurant setup.');
  }
  return normalized;
}

function normalizeName(value, field, maxLength = 100) {
  const name = String(value || '').normalize('NFKC').trim();
  if (!name || name.length > maxLength) {
    throw setupError('RESTAURANT_SETUP_INVALID', `${field} must be between 1 and ${maxLength} characters.`);
  }
  return name;
}

function normalizeSortOrder(value, fallback = 0) {
  const order = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(order) || order < 0 || order > MAX_SORT_ORDER) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Display order must be a whole number between 0 and 100000.');
  }
  return order;
}

function normalizeBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw setupError('RESTAURANT_SETUP_INVALID', `${field} must be true or false.`);
  }
  return value;
}

function normalizeId(value, field) {
  const id = String(value || '').trim();
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw setupError('RESTAURANT_SETUP_INVALID', `Choose a valid ${field}.`);
  }
  return id;
}

function normalizeStation(value, fallback = 'none') {
  const station = value === null || value === '' || value === undefined
    ? fallback
    : String(value).trim().toLowerCase();
  if (!['kitchen', 'bar', 'none'].includes(station)) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Choose Kitchen, Bar, or no preparation station.');
  }
  return station;
}

function normalizeStockMode(value, fallback = 'none') {
  const mode = value === undefined ? fallback : String(value).trim().toLowerCase();
  if (!['none', 'recipe', 'goods'].includes(mode)) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Choose recipe stock, packaged goods, or no direct stock mode.');
  }
  return mode;
}

function normalizeRecipeIngredients(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'A recipe can contain up to 50 ingredients.');
  }
  const seen = new Set();
  return value.map((ingredient) => {
    const productId = normalizeId(ingredient?.productId, 'recipe ingredient');
    const quantity = Number(ingredient?.quantity);
    const unitCode = String(ingredient?.unitCode || 'base').trim().toLowerCase();
    if (seen.has(productId)) {
      throw setupError('RESTAURANT_SETUP_INVALID', 'Each stock product can appear only once in a recipe.');
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000
      || !/^[a-z0-9_-]{1,24}$/.test(unitCode)) {
      throw setupError('RESTAURANT_SETUP_INVALID', 'Recipe quantities and units must be valid and greater than zero.');
    }
    seen.add(productId);
    return { productId, quantity, unitCode };
  });
}

async function normalizeBarMeasure(tx, companyId, value) {
  if (value == null || value.enabled === false) {
    return {
      barStockProductId: null,
      barPurchaseUnitCode: null,
      barServingVolume: null,
      barServingUnit: null,
    };
  }
  const stockProductId = normalizeId(value.stockProductId, 'bar stock product');
  const purchaseUnitCode = String(value.purchaseUnitCode || '').trim().toLowerCase();
  const servingVolume = Number(value.servingVolume);
  const measureName = normalizeName(value.measureName, 'Measure name', 32);
  if (!purchaseUnitCode || !Number.isFinite(servingVolume) || servingVolume <= 0) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Choose a bottle purchase unit and enter a serving volume greater than zero.');
  }
  const stockProduct = await tx.product.findFirst({
    where: { id: stockProductId, companyId, isActive: true, isArchived: false, isStockable: true },
    select: { id: true, unit: true, customFields: true },
  });
  if (!stockProduct) {
    throw setupError('RESTAURANT_STOCK_PRODUCT_NOT_FOUND', 'Choose an active stock product from this company for the bar measure.', 404);
  }
  if (String(value.servingUnit || '').trim().toLowerCase() !== String(stockProduct.unit || '').trim().toLowerCase()) {
    throw setupError('RESTAURANT_BAR_MEASURE_UNIT_MISMATCH', `The serving unit must match the stock product unit (${stockProduct.unit}).`);
  }
  let bottleUnit;
  try {
    bottleUnit = resolvePurchaseUnit(stockProduct, purchaseUnitCode);
  } catch (error) {
    throw setupError('RESTAURANT_BAR_PURCHASE_UNIT_INVALID', error.message);
  }
  if (bottleUnit.code === 'base' || servingVolume > bottleUnit.baseQuantity) {
    throw setupError('RESTAURANT_BAR_MEASURE_VOLUME_INVALID', 'A serving must be smaller than or equal to the selected bottle volume.');
  }
  const measuresPerBottle = Number((bottleUnit.baseQuantity / servingVolume).toFixed(4));
  if (!Number.isFinite(measuresPerBottle) || measuresPerBottle <= 0) {
    throw setupError('RESTAURANT_BAR_MEASURE_VOLUME_INVALID', 'The selected bottle cannot produce a valid serving count.');
  }
  return {
    barStockProductId: stockProduct.id,
    barPurchaseUnitCode,
    barServingVolume: String(servingVolume),
    barServingUnit: stockProduct.unit,
    measureName,
    measuresPerBottle: String(measuresPerBottle),
  };
}

async function saveRecipeIngredients(tx, companyId, menuItemId, ingredients) {
  const normalized = normalizeRecipeIngredients(ingredients);
  if (normalized.length) {
    const products = await tx.product.findMany({
      where: {
        companyId,
        id: { in: normalized.map((ingredient) => ingredient.productId) },
        isActive: true,
        isArchived: false,
        isStockable: true,
      },
      select: { id: true, unit: true, customFields: true },
    });
    const productById = new Map(products.map((product) => [product.id, product]));
    for (const ingredient of normalized) {
      const product = productById.get(ingredient.productId);
      if (!product) {
        throw setupError('RESTAURANT_RECIPE_PRODUCT_NOT_FOUND', 'Every recipe ingredient must be an active stock product in this company.', 404);
      }
      try {
        const unit = resolvePurchaseUnit(product, ingredient.unitCode);
        toBaseQuantity(ingredient.quantity, unit);
      } catch (error) {
        throw setupError('RESTAURANT_RECIPE_UNIT_INVALID', error.message);
      }
    }
  }
  await tx.restaurantRecipeIngredient.deleteMany({ where: { companyId, menuItemId } });
  for (const ingredient of normalized) {
    await tx.restaurantRecipeIngredient.create({
      data: {
        id: generateObjectId(),
        companyId,
        menuItemId,
        productId: ingredient.productId,
        quantity: String(ingredient.quantity),
        unitCode: ingredient.unitCode,
      },
    });
  }
}

async function saveMenuPromotions(tx, companyId, menuItemId, promotions) {
  if (!Array.isArray(promotions) || promotions.length > 20) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'A menu item can have up to 20 scheduled promotions.');
  }
  const normalized = promotions.map((promotion) => normalizePromotion(promotion));
  await tx.restaurantHappyHourPromotion.deleteMany({ where: { companyId, menuItemId } });
  for (const promotion of normalized) {
    const data = { ...promotion };
    delete data.id;
    await tx.restaurantHappyHourPromotion.create({
      data: { id: generateObjectId(), companyId, menuItemId, ...data },
    });
  }
}

function normalizePriceAdjustment(value) {
  const raw = String(value ?? '0').trim();
  if (!/^\d{1,15}(?:\.\d{1,2})?$/.test(raw) || Number(raw) > MAX_PRICE_ADJUSTMENT) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Modifier extra price must be zero or a positive amount with up to 2 decimal places.');
  }
  return raw;
}

function normalizeOptions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Add between 1 and 50 choices to a modifier group.');
  }
  const names = new Set();
  return value.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw setupError('RESTAURANT_SETUP_INVALID', 'Each modifier choice must have a name and extra price.');
    }
    const name = normalizeName(option.name, 'Modifier choice', 120);
    const nameKey = name.toLocaleLowerCase('en-US');
    if (names.has(nameKey)) {
      throw setupError('RESTAURANT_SETUP_INVALID', 'Modifier choice names must be unique within a group.');
    }
    names.add(nameKey);
    return {
      id: option.id ? normalizeId(option.id, 'modifier choice') : null,
      name,
      priceAdjustment: normalizePriceAdjustment(option.priceDelta ?? option.priceAdjustment),
      displayOrder: normalizeSortOrder(option.sortOrder ?? option.displayOrder, index),
      isAvailable: normalizeBoolean(option.isActive ?? option.isAvailable, 'Modifier choice availability', true),
    };
  });
}

function normalizeGroupRules(body, activeOptionCount) {
  const selectionMode = body.selectionMode === undefined ? 'single' : String(body.selectionMode).trim().toLowerCase();
  if (!['single', 'multiple'].includes(selectionMode)) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Choose single choice or multiple choices for this modifier group.');
  }
  const isRequired = normalizeBoolean(body.isRequired, 'Required choice', false);
  const maxSelections = body.maxSelections === undefined
    ? (selectionMode === 'single' ? 1 : activeOptionCount)
    : Number(body.maxSelections);
  const minSelections = isRequired
    ? Number(body.minSelections === undefined ? 1 : body.minSelections)
    : 0;
  if (!Number.isInteger(maxSelections) || !Number.isInteger(minSelections)
    || minSelections < 0 || maxSelections < 1 || minSelections > maxSelections
    || maxSelections > activeOptionCount
    || (selectionMode === 'single' && maxSelections !== 1)
    || (isRequired && minSelections < 1)) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Modifier selection limits do not match the group choices.');
  }
  return { selectionMode, isRequired, minSelections, maxSelections };
}

function toProduct(product, categoryNames) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    categoryId: product.categoryId,
    categoryName: categoryNames.get(product.categoryId) || '',
    sellingPrice: String(product.sellingPrice),
    taxCode: product.taxCode || '',
    taxRate: String(product.taxRate ?? '0'),
    unit: product.unit || 'unit',
    isStockable: product.isStockable !== false,
    purchaseUnits: Array.isArray(product.customFields?.purchaseUnits)
      ? product.customFields.purchaseUnits.map((unit) => ({
        code: String(unit.code || ''),
        label: String(unit.label || ''),
        baseQuantity: Number(unit.baseQuantity),
      }))
      : [],
  };
}

function toModifierGroup(group, options) {
  return {
    id: group.id,
    name: group.name,
    selectionMode: group.selectionMode,
    isRequired: group.isRequired,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    sortOrder: 0,
    isActive: group.isActive,
    options: options
      .filter((option) => option.groupId === group.id)
      .map((option) => ({
        id: option.id,
        name: option.name,
        priceDelta: String(option.priceAdjustment),
        sortOrder: option.displayOrder,
        isActive: option.isAvailable,
      })),
  };
}

async function auditedTransaction(companyId, actor, action, entityType, entityId, operation) {
  return prisma.$transaction(async (tx) => {
    const result = await operation(tx);
    const auditEntityId = entityId || result?.id || null;
    await writePosAuditLog({
      companyId,
      userId: actor?.userId || null,
      event: 'RESTAURANT_SETUP_UPDATED',
      entityType,
      entityId: auditEntityId,
      metadata: { action, entityType, entityId: auditEntityId },
      ip: actor?.ip || null,
    }, tx);
    return result;
  });
}

async function findOwned(tx, model, companyId, id, entityName) {
  const row = await tx[model].findFirst({ where: { id, companyId } });
  if (!row) throw setupError('RESTAURANT_SETUP_NOT_FOUND', `${entityName} was not found for this company.`, 404);
  return row;
}

async function validateCategory(tx, companyId, categoryId) {
  const category = await tx.category.findFirst({
    where: { id: categoryId, companyId, isActive: true },
    select: { id: true },
  });
  const menuCategory = await tx.restaurantMenuCategory.findFirst({
    where: { companyId, categoryId, isEnabled: true },
    select: { id: true },
  });
  if (!category || !menuCategory) {
    throw setupError('RESTAURANT_MENU_CATEGORY_NOT_FOUND', 'Enable the product category for the Restaurant menu before adding this item.', 404);
  }
}

async function validateProduct(tx, companyId, productId) {
  const product = await tx.product.findFirst({
    where: { id: productId, companyId, isActive: true, isArchived: false },
    select: { id: true, categoryId: true },
  });
  if (!product) throw setupError('RESTAURANT_PRODUCT_NOT_FOUND', 'Choose an active, non-archived product belonging to this company.', 404);
  await validateCategory(tx, companyId, product.categoryId);
  const menuItem = await tx.restaurantMenuItem.findFirst({
    where: { companyId, productId },
    select: { id: true },
  });
  if (menuItem) {
    throw setupError('RESTAURANT_PRODUCT_ALREADY_ON_MENU', 'This product is already on the Restaurant menu. Edit its existing menu entry instead.', 409);
  }
  return product;
}

function normalizeAssignments(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Modifier groups must be a list of no more than 50 groups.');
  }
  const seen = new Set();
  return value.map((assignment, index) => {
    const modifierGroupId = normalizeId(assignment?.modifierGroupId || assignment, 'modifier group');
    if (seen.has(modifierGroupId)) {
      throw setupError('RESTAURANT_SETUP_INVALID', 'A modifier group can only be attached once to a menu item.');
    }
    seen.add(modifierGroupId);
    return {
      modifierGroupId,
      displayOrder: normalizeSortOrder(assignment?.sortOrder ?? assignment?.displayOrder, index),
    };
  });
}

async function validateModifierAssignments(tx, companyId, assignments) {
  const normalized = normalizeAssignments(assignments);
  if (!normalized.length) return normalized;
  const groupIds = normalized.map((assignment) => assignment.modifierGroupId);
  const groups = await tx.restaurantModifierGroup.findMany({
    where: { companyId, id: { in: groupIds }, isActive: true },
    select: { id: true, name: true, maxSelections: true },
  });
  if (groups.length !== normalized.length) {
    throw setupError('RESTAURANT_MODIFIER_GROUP_NOT_FOUND', 'All selected modifier groups must be active and belong to this company.', 404);
  }
  const options = await tx.restaurantModifierOption.findMany({
    where: { companyId, groupId: { in: groupIds }, isAvailable: true },
    select: { groupId: true },
  });
  const availableByGroup = new Map();
  for (const option of options) availableByGroup.set(option.groupId, (availableByGroup.get(option.groupId) || 0) + 1);
  for (const group of groups) {
    if ((availableByGroup.get(group.id) || 0) < group.maxSelections) {
      throw setupError('RESTAURANT_MODIFIER_SELECTION_INVALID', `Keep enough available choices in "${group.name}" to satisfy its selection rules.`);
    }
  }
  return normalized;
}

async function replaceModifierAssignments(tx, companyId, menuItemId, assignments) {
  const normalized = await validateModifierAssignments(tx, companyId, assignments);
  const groupIds = normalized.map((assignment) => assignment.modifierGroupId);
  await tx.restaurantMenuItemModifierGroup.deleteMany({
    where: { companyId, menuItemId, ...(groupIds.length ? { modifierGroupId: { notIn: groupIds } } : {}) },
  });
  for (const assignment of normalized) {
    await tx.restaurantMenuItemModifierGroup.upsert({
      where: {
        companyId_menuItemId_modifierGroupId: {
          companyId,
          menuItemId,
          modifierGroupId: assignment.modifierGroupId,
        },
      },
      create: {
        id: generateObjectId(),
        companyId,
        menuItemId,
        modifierGroupId: assignment.modifierGroupId,
        displayOrder: assignment.displayOrder,
      },
      update: { displayOrder: assignment.displayOrder },
    });
  }
}

async function getSetup(companyId, productSearch = '') {
  const scopedCompanyId = requireCompany(companyId);
  const search = String(productSearch || '').trim();
  if (search.length > 100) throw setupError('RESTAURANT_SETUP_INVALID', 'Product search must be 100 characters or fewer.');

  return prisma.$transaction(async (tx) => {
    const [products, categoryRows, categorySettings, menuItems, modifierGroups, modifierOptions, areas] = await Promise.all([
      tx.product.findMany({
        where: {
          companyId: scopedCompanyId,
          isActive: true,
          isArchived: false,
          ...(search ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          } : {}),
        },
        select: {
          id: true, name: true, sku: true, categoryId: true, sellingPrice: true, taxCode: true,
          taxRate: true, unit: true, customFields: true, isStockable: true,
        },
        orderBy: { name: 'asc' },
        take: 100,
      }),
      tx.category.findMany({
        where: { companyId: scopedCompanyId },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      tx.restaurantMenuCategory.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ displayOrder: 'asc' }, { categoryId: 'asc' }],
      }),
      tx.restaurantMenuItem.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.restaurantModifierGroup.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
      tx.restaurantModifierOption.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
      tx.restaurantFloorArea.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const menuItemIds = menuItems.map((item) => item.id);
    const [recipeIngredients, promotions, company, inventorySettings, warehouses] = await Promise.all([
      menuItemIds.length
        ? tx.restaurantRecipeIngredient.findMany({
          where: { companyId: scopedCompanyId, menuItemId: { in: menuItemIds } },
          orderBy: [{ menuItemId: 'asc' }, { productId: 'asc' }],
        })
        : [],
      menuItemIds.length
        ? tx.restaurantHappyHourPromotion.findMany({
          where: { companyId: scopedCompanyId, menuItemId: { in: menuItemIds } },
          orderBy: [{ menuItemId: 'asc' }, { startMinute: 'asc' }, { id: 'asc' }],
        })
        : [],
      tx.company.findUnique({ where: { id: scopedCompanyId }, select: { timezone: true } }),
      tx.restaurantInventorySettings.findUnique({ where: { companyId: scopedCompanyId } }),
      tx.warehouse.findMany({
        where: { companyId: scopedCompanyId, isActive: true },
        select: { id: true, code: true, name: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    ]);
    const stockProductIds = [...new Set([
      ...menuItems.map((item) => item.barStockProductId).filter(Boolean),
      ...recipeIngredients.map((ingredient) => ingredient.productId),
    ])];
    const menuProductIds = [...new Set([...menuItems.map((item) => item.productId), ...stockProductIds])];
    const [menuProducts, assignments, tables] = await Promise.all([
      menuProductIds.length
        ? tx.product.findMany({
          where: { companyId: scopedCompanyId, id: { in: menuProductIds } },
          select: {
            id: true, name: true, sku: true, categoryId: true, sellingPrice: true, taxCode: true,
            taxRate: true, unit: true, customFields: true, isStockable: true,
          },
        })
        : [],
      menuItemIds.length
        ? tx.restaurantMenuItemModifierGroup.findMany({
          where: { companyId: scopedCompanyId, menuItemId: { in: menuItemIds } },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        })
        : [],
      tx.restaurantTable.findMany({
        where: { companyId: scopedCompanyId },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const categoryNames = new Map(categoryRows.map((category) => [category.id, category.name]));
    const categorySettingsById = new Map(categorySettings.map((category) => [category.categoryId, category]));
    const categories = categoryRows.map((category) => {
      const setting = categorySettingsById.get(category.id);
      return {
        id: setting?.id || category.id,
        categoryId: category.id,
        name: category.name,
        sortOrder: setting?.displayOrder || 0,
        isEnabled: Boolean(setting?.isEnabled),
        categoryActive: category.isActive,
      };
    });
    const productsById = new Map(menuProducts.map((product) => [product.id, product]));
    const recipesByMenuItemId = new Map();
    for (const ingredient of recipeIngredients) {
      const current = recipesByMenuItemId.get(ingredient.menuItemId) || [];
      const product = productsById.get(ingredient.productId);
      if (!product) {
        throw setupError('RESTAURANT_SETUP_DATA_INCONSISTENT', 'A recipe ingredient refers to a product that is unavailable in this company.', 409);
      }
      current.push({
        productId: ingredient.productId,
        productName: product.name,
        productSku: product.sku,
        quantity: String(ingredient.quantity),
        unitCode: ingredient.unitCode,
        unit: ingredient.unitCode === 'base' ? product.unit : (
          product.customFields?.purchaseUnits?.find((unit) => unit.code === ingredient.unitCode)?.label || ingredient.unitCode
        ),
      });
      recipesByMenuItemId.set(ingredient.menuItemId, current);
    }
    const promotionsByMenuItemId = new Map();
    for (const promotion of promotions) {
      const current = promotionsByMenuItemId.get(promotion.menuItemId) || [];
      current.push({
        id: promotion.id,
        name: promotion.name,
        kind: promotion.kind,
        value: Number(promotion.value),
        weekdays: promotion.weekdays,
        startMinute: promotion.startMinute,
        endMinute: promotion.endMinute,
        startsAt: promotion.startsAt,
        endsAt: promotion.endsAt,
        isEnabled: promotion.isEnabled,
      });
      promotionsByMenuItemId.set(promotion.menuItemId, current);
    }
    const stockProductById = productsById;
    const groupsById = new Map(modifierGroups.map((group) => [
      group.id,
      toModifierGroup(group, modifierOptions),
    ]));
    const assignmentsByItemId = new Map();
    for (const assignment of assignments) {
      const group = groupsById.get(assignment.modifierGroupId);
      if (!group) continue;
      const current = assignmentsByItemId.get(assignment.menuItemId) || [];
      current.push({
        id: assignment.id,
        modifierGroupId: assignment.modifierGroupId,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        sortOrder: assignment.displayOrder,
        modifierGroup: group,
      });
      assignmentsByItemId.set(assignment.menuItemId, current);
    }
    const tablesByAreaId = new Map();
    for (const table of tables) {
      const current = tablesByAreaId.get(table.areaId) || [];
      current.push({
        id: table.id,
        areaId: table.areaId,
        name: table.name,
        seats: table.capacity,
        sortOrder: table.displayOrder,
        state: table.state,
        guestCount: table.guestCount,
      });
      tablesByAreaId.set(table.areaId, current);
    }
    const productsByIdForMenu = new Map(products.map((product) => [product.id, product]));
    const menuProductMap = new Map([...productsByIdForMenu, ...productsById]);
    const menuItemDtos = menuItems.map((item) => {
      const product = menuProductMap.get(item.productId);
      if (!product) {
        throw setupError('RESTAURANT_SETUP_DATA_INCONSISTENT', 'A Restaurant menu item refers to a product that is unavailable in this company.', 409);
      }
      const categoryName = categoryNames.get(product.categoryId);
      const station = DEFAULT_STATIONS.find((entry) => entry.id === item.station) || null;
      const stockProduct = item.barStockProductId ? stockProductById.get(item.barStockProductId) : null;
      let barServingVolume = item.barServingVolume == null ? null : Number(item.barServingVolume);
      let barServingUnit = item.barServingUnit || stockProduct?.unit || null;
      let bottleVolume = null;
      if (stockProduct && item.barPurchaseUnitCode) {
        try {
          bottleVolume = resolvePurchaseUnit(stockProduct, item.barPurchaseUnitCode).baseQuantity;
        } catch (error) {
          bottleVolume = null;
        }
      }
      if (barServingVolume == null && bottleVolume && Number(item.measuresPerBottle) > 0) {
        barServingVolume = bottleVolume / Number(item.measuresPerBottle);
      }
      const activePrice = activePromotion(
        promotionsByMenuItemId.get(item.id) || [],
        Number(product.sellingPrice),
        new Date(),
        company?.timezone || 'Africa/Kigali',
      );
      return {
        id: item.id,
        productId: item.productId,
        categoryId: product.categoryId,
        stationId: item.station === 'none' ? null : item.station,
        sortOrder: item.displayOrder,
        isAvailable: item.isAvailable,
        serviceChargeExempt: item.serviceChargeExempt === true,
        isActive: true,
        menuName: item.menuName,
        stockMode: item.stockMode || 'none',
        barMeasure: item.barStockProductId ? {
          stockProductId: item.barStockProductId,
          stockProductName: stockProduct?.name || '',
          purchaseUnitCode: item.barPurchaseUnitCode,
          servingVolume: barServingVolume,
          servingUnit: barServingUnit,
          bottleVolume,
          poursPerBottle: barServingVolume && bottleVolume
            ? Number((bottleVolume / barServingVolume).toFixed(4))
            : Number(item.measuresPerBottle) || null,
          measureName: item.measureName,
          needsSetup: !barServingVolume || !bottleVolume,
        } : (item.measureName || item.measuresPerBottle != null ? {
          stockProductId: null,
          stockProductName: '',
          purchaseUnitCode: null,
          servingVolume: null,
          servingUnit: null,
          bottleVolume: null,
          poursPerBottle: Number(item.measuresPerBottle) || null,
          measureName: item.measureName,
          needsSetup: true,
        } : null),
        recipeIngredients: recipesByMenuItemId.get(item.id) || [],
        promotions: promotionsByMenuItemId.get(item.id) || [],
        currentPrice: activePrice.unitPrice,
        activePromotion: activePrice.promotion,
        product: toProduct(product, categoryNames),
        category: { id: product.categoryId, name: categoryName || '' },
        station,
        modifierGroups: assignmentsByItemId.get(item.id) || [],
      };
    });

    return {
      products: products.map((product) => toProduct(product, categoryNames)),
      companyTimeZone: company?.timezone || 'Africa/Kigali',
      categories,
      menuItems: menuItemDtos,
      modifierGroups: modifierGroups.map((group) => groupsById.get(group.id)),
      inventorySettings: {
        recipeShortageMode: inventorySettings?.recipeShortageMode || 'warn',
        stationWarehouseOverrides: inventorySettings?.stationWarehouseOverrides || {},
      },
      warehouses,
      areas: areas.map((area) => ({
        id: area.id,
        name: area.name,
        sortOrder: area.displayOrder,
        isActive: area.isActive,
        tables: tablesByAreaId.get(area.id) || [],
      })),
      stations: DEFAULT_STATIONS,
    };
  });
}

async function createMenuCategory(companyId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const categoryId = normalizeId(body?.categoryId, 'product category');
  const displayOrder = normalizeSortOrder(body?.sortOrder);
  return auditedTransaction(scopedCompanyId, actor, 'category.enabled', 'restaurant_menu_category', null, async (tx) => {
    const category = await tx.category.findFirst({
      where: { id: categoryId, companyId: scopedCompanyId, isActive: true },
      select: { id: true },
    });
    if (!category) throw setupError('RESTAURANT_CATEGORY_NOT_FOUND', 'Choose an active product category belonging to this company.', 404);
    return tx.restaurantMenuCategory.upsert({
      where: { companyId_categoryId: { companyId: scopedCompanyId, categoryId } },
      create: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        categoryId,
        isEnabled: true,
        displayOrder,
        gridColumns: 4,
      },
      update: { isEnabled: true, displayOrder },
    });
  });
}

async function updateMenuCategory(companyId, categoryIdValue, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const categoryId = normalizeId(categoryIdValue, 'product category');
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  if (Object.prototype.hasOwnProperty.call(source, 'isEnabled')) {
    data.isEnabled = normalizeBoolean(source.isEnabled, 'Menu category status');
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sortOrder')) {
    data.displayOrder = normalizeSortOrder(source.sortOrder);
  }
  if (!Object.keys(data).length) throw setupError('RESTAURANT_SETUP_INVALID', 'Provide at least one menu category change.');
  return auditedTransaction(scopedCompanyId, actor, 'category.updated', 'restaurant_menu_category', categoryId, async (tx) => {
    const current = await tx.restaurantMenuCategory.findFirst({ where: { companyId: scopedCompanyId, categoryId } });
    if (!current) throw setupError('RESTAURANT_MENU_CATEGORY_NOT_FOUND', 'Enable this product category for the menu first.', 404);
    if (data.isEnabled) {
      const category = await tx.category.findFirst({
        where: { id: categoryId, companyId: scopedCompanyId, isActive: true },
        select: { id: true },
      });
      if (!category) throw setupError('RESTAURANT_CATEGORY_NOT_FOUND', 'This product category is inactive and cannot be enabled.', 409);
    }
    return tx.restaurantMenuCategory.update({
      where: { companyId_id: { companyId: scopedCompanyId, id: current.id } },
      data,
    });
  });
}

async function createMenuItem(companyId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const productId = normalizeId(body?.productId, 'product');
  const station = normalizeStation(body?.stationId ?? body?.station);
  const displayOrder = normalizeSortOrder(body?.sortOrder ?? body?.displayOrder);
  const serviceChargeExempt = normalizeBoolean(body?.serviceChargeExempt, 'Service-charge exemption', false);
  const stockMode = normalizeStockMode(body?.stockMode);
  const assignments = body?.modifierGroups ?? [];
  const recipeIngredients = Object.prototype.hasOwnProperty.call(body || {}, 'recipeIngredients')
    ? normalizeRecipeIngredients(body.recipeIngredients)
    : [];
  if ((stockMode === 'recipe') !== (recipeIngredients.length > 0)) {
    throw setupError('RESTAURANT_RECIPE_CONFIGURATION_REQUIRED', 'Recipe stock mode requires at least one recipe ingredient, and recipe ingredients require recipe stock mode.');
  }
  return auditedTransaction(scopedCompanyId, actor, 'menu_item.created', 'restaurant_menu_item', null, async (tx) => {
    await validateProduct(tx, scopedCompanyId, productId);
    const barMeasure = Object.prototype.hasOwnProperty.call(body || {}, 'barMeasure')
      ? await normalizeBarMeasure(tx, scopedCompanyId, body.barMeasure)
      : {};
    const menuItem = await tx.restaurantMenuItem.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        productId,
        station,
        stockMode,
        isAvailable: true,
        displayOrder,
        serviceChargeExempt,
        ...barMeasure,
      },
    });
    await replaceModifierAssignments(tx, scopedCompanyId, menuItem.id, assignments);
    if (Object.prototype.hasOwnProperty.call(body || {}, 'recipeIngredients')) {
      await saveRecipeIngredients(tx, scopedCompanyId, menuItem.id, body.recipeIngredients);
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'promotions')) {
      await saveMenuPromotions(tx, scopedCompanyId, menuItem.id, body.promotions);
    }
    return menuItem;
  });
}

async function updateMenuItem(companyId, menuItemId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const id = normalizeId(menuItemId, 'menu item');
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  if (Object.prototype.hasOwnProperty.call(source, 'stationId') || Object.prototype.hasOwnProperty.call(source, 'station')) {
    data.station = normalizeStation(source.stationId ?? source.station);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sortOrder') || Object.prototype.hasOwnProperty.call(source, 'displayOrder')) {
    data.displayOrder = normalizeSortOrder(source.sortOrder ?? source.displayOrder);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'isAvailable')) {
    data.isAvailable = normalizeBoolean(source.isAvailable, 'Menu item availability');
  }
  if (Object.prototype.hasOwnProperty.call(source, 'serviceChargeExempt')) {
    data.serviceChargeExempt = normalizeBoolean(source.serviceChargeExempt, 'Service-charge exemption');
  }
  if (Object.prototype.hasOwnProperty.call(source, 'stockMode')) {
    data.stockMode = normalizeStockMode(source.stockMode);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'menuName')) {
    const name = source.menuName === null || source.menuName === '' ? null : normalizeName(source.menuName, 'Menu name', 180);
    data.menuName = name;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'menuDescription')) {
    data.menuDescription = source.menuDescription === null || source.menuDescription === ''
      ? null
      : String(source.menuDescription).normalize('NFKC').trim();
  }
  const hasModifierGroups = Object.prototype.hasOwnProperty.call(source, 'modifierGroups');
  const hasBarMeasure = Object.prototype.hasOwnProperty.call(source, 'barMeasure');
  const hasRecipeIngredients = Object.prototype.hasOwnProperty.call(source, 'recipeIngredients');
  const hasPromotions = Object.prototype.hasOwnProperty.call(source, 'promotions');
  if (!Object.keys(data).length && !hasModifierGroups && !hasBarMeasure && !hasRecipeIngredients && !hasPromotions) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Provide at least one menu item change.');
  }
  return auditedTransaction(scopedCompanyId, actor, 'menu_item.updated', 'restaurant_menu_item', id, async (tx) => {
    const current = await findOwned(tx, 'restaurantMenuItem', scopedCompanyId, id, 'Menu item');
    const targetStockMode = data.stockMode || current.stockMode || 'none';
    const recipeCount = hasRecipeIngredients
      ? normalizeRecipeIngredients(source.recipeIngredients).length
      : await tx.restaurantRecipeIngredient.count({
        where: { companyId: scopedCompanyId, menuItemId: id },
      });
    if ((targetStockMode === 'recipe') !== (recipeCount > 0)) {
      throw setupError('RESTAURANT_RECIPE_CONFIGURATION_REQUIRED', 'Recipe stock mode requires at least one recipe ingredient, and recipe ingredients require recipe stock mode.');
    }
    if (hasBarMeasure) Object.assign(data, await normalizeBarMeasure(tx, scopedCompanyId, source.barMeasure));
    const updated = Object.keys(data).length
      ? await tx.restaurantMenuItem.update({
        where: { companyId_id: { companyId: scopedCompanyId, id } },
        data,
      })
      : current;
    if (hasModifierGroups) await replaceModifierAssignments(tx, scopedCompanyId, id, source.modifierGroups);
    if (hasRecipeIngredients) await saveRecipeIngredients(tx, scopedCompanyId, id, source.recipeIngredients);
    if (hasPromotions) await saveMenuPromotions(tx, scopedCompanyId, id, source.promotions);
    return updated;
  });
}

async function updateInventorySettings(companyId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const mode = source.recipeShortageMode === undefined
    ? undefined
    : String(source.recipeShortageMode).trim().toLowerCase();
  if (mode !== undefined && !['warn', 'require_manager', 'block'].includes(mode)) {
    throw setupError('RESTAURANT_INVENTORY_SETTINGS_INVALID', 'Choose warn, manager approval, or block for recipe stock shortages.');
  }
  const hasOverrides = Object.prototype.hasOwnProperty.call(source, 'stationWarehouseOverrides');
  let overrides;
  if (hasOverrides) {
    const raw = source.stationWarehouseOverrides;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some((station) => !['kitchen', 'bar'].includes(station))) {
      throw setupError('RESTAURANT_INVENTORY_SETTINGS_INVALID', 'Warehouse overrides may be set only for Kitchen and Bar.');
    }
    overrides = {};
    for (const [station, value] of Object.entries(raw)) {
      if (value == null || value === '') continue;
      overrides[station] = normalizeId(value, `${station} warehouse`);
    }
  }
  if (mode === undefined && !hasOverrides) {
    throw setupError('RESTAURANT_INVENTORY_SETTINGS_INVALID', 'Provide a shortage mode or station warehouse override.');
  }
  return auditedTransaction(
    scopedCompanyId,
    actor,
    'inventory_settings.updated',
    'restaurant_inventory_settings',
    scopedCompanyId,
    async (tx) => {
      if (overrides && Object.keys(overrides).length) {
        const found = await tx.warehouse.findMany({
          where: { companyId: scopedCompanyId, id: { in: Object.values(overrides) }, isActive: true },
          select: { id: true },
        });
        if (found.length !== new Set(Object.values(overrides)).size) {
          throw setupError('RESTAURANT_INVENTORY_WAREHOUSE_INVALID', 'Choose active warehouses belonging to this company.', 404);
        }
      }
      const current = await tx.restaurantInventorySettings.findUnique({ where: { companyId: scopedCompanyId } });
      return tx.restaurantInventorySettings.upsert({
        where: { companyId: scopedCompanyId },
        create: {
          companyId: scopedCompanyId,
          recipeShortageMode: mode || 'warn',
          stationWarehouseOverrides: overrides || {},
          updatedById: actor?.userId || null,
        },
        update: {
          ...(mode !== undefined ? { recipeShortageMode: mode } : {}),
          ...(overrides ? { stationWarehouseOverrides: overrides } : {}),
          updatedById: actor?.userId || null,
        },
      }).then((updated) => ({
        ...updated,
        recipeShortageMode: mode ?? current?.recipeShortageMode ?? updated.recipeShortageMode,
        stationWarehouseOverrides: overrides ?? current?.stationWarehouseOverrides ?? updated.stationWarehouseOverrides,
      }));
    },
  );
}

async function createModifierGroup(companyId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const name = normalizeName(body?.name, 'Modifier group name', 120);
  const options = normalizeOptions(body?.options);
  const activeOptions = options.filter((option) => option.isAvailable);
  if (!activeOptions.length) throw setupError('RESTAURANT_SETUP_INVALID', 'A modifier group needs at least one available choice.');
  const rules = normalizeGroupRules(body || {}, activeOptions.length);
  return auditedTransaction(scopedCompanyId, actor, 'modifier_group.created', 'restaurant_modifier_group', null, async (tx) => {
    const group = await tx.restaurantModifierGroup.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        name,
        ...rules,
        isActive: true,
      },
    });
    for (const option of options) {
      await tx.restaurantModifierOption.create({
        data: {
          id: generateObjectId(),
          companyId: scopedCompanyId,
          groupId: group.id,
          name: option.name,
          priceAdjustment: option.priceAdjustment,
          isAvailable: option.isAvailable,
          displayOrder: option.displayOrder,
        },
      });
    }
    return group;
  });
}

async function updateModifierGroup(companyId, groupId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const id = normalizeId(groupId, 'modifier group');
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const name = normalizeName(source.name, 'Modifier group name', 120);
  const options = normalizeOptions(source.options);
  const activeOptions = options.filter((option) => option.isAvailable);
  if (!activeOptions.length) throw setupError('RESTAURANT_SETUP_INVALID', 'A modifier group needs at least one available choice.');
  const rules = normalizeGroupRules(source, activeOptions.length);
  return auditedTransaction(scopedCompanyId, actor, 'modifier_group.updated', 'restaurant_modifier_group', id, async (tx) => {
    const current = await findOwned(tx, 'restaurantModifierGroup', scopedCompanyId, id, 'Modifier group');
    const isActive = normalizeBoolean(source.isActive, 'Modifier group status', current.isActive);
    const assignedItems = await tx.restaurantMenuItemModifierGroup.count({
      where: { companyId: scopedCompanyId, modifierGroupId: id },
    });
    if (!isActive && assignedItems) {
      throw setupError('RESTAURANT_MODIFIER_GROUP_IN_USE', 'Remove this modifier group from menu items before archiving it.', 409);
    }
    const currentOptions = await tx.restaurantModifierOption.findMany({
      where: { companyId: scopedCompanyId, groupId: id },
      select: { id: true },
    });
    const currentIds = new Set(currentOptions.map((option) => option.id));
    const submittedIds = new Set(options.filter((option) => option.id).map((option) => option.id));
    if ([...submittedIds].some((optionId) => !currentIds.has(optionId))) {
      throw setupError('RESTAURANT_MODIFIER_OPTION_NOT_FOUND', 'A modifier choice does not belong to this group.', 404);
    }
    await tx.restaurantModifierGroup.update({
      where: { companyId_id: { companyId: scopedCompanyId, id } },
      data: { name, ...rules, isActive },
    });
    for (const option of options) {
      if (option.id) {
        await tx.restaurantModifierOption.update({
          where: { companyId_id: { companyId: scopedCompanyId, id: option.id } },
          data: {
            name: option.name,
            priceAdjustment: option.priceAdjustment,
            displayOrder: option.displayOrder,
            isAvailable: option.isAvailable,
          },
        });
      } else {
        await tx.restaurantModifierOption.create({
          data: {
            id: generateObjectId(),
            companyId: scopedCompanyId,
            groupId: id,
            name: option.name,
            priceAdjustment: option.priceAdjustment,
            displayOrder: option.displayOrder,
            isAvailable: option.isAvailable,
          },
        });
      }
    }
    const removedIds = [...currentIds].filter((optionId) => !submittedIds.has(optionId));
    if (removedIds.length) {
      await tx.restaurantModifierOption.updateMany({
        where: { companyId: scopedCompanyId, groupId: id, id: { in: removedIds } },
        data: { isAvailable: false },
      });
    }
    return tx.restaurantModifierGroup.findFirst({ where: { id, companyId: scopedCompanyId } });
  });
}

async function createFloorArea(companyId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const name = normalizeName(body?.name, 'Area name', 80);
  const displayOrder = normalizeSortOrder(body?.sortOrder);
  return auditedTransaction(scopedCompanyId, actor, 'floor_area.created', 'restaurant_floor_area', null, async (tx) => (
    tx.restaurantFloorArea.create({
      data: { id: generateObjectId(), companyId: scopedCompanyId, name, displayOrder, isActive: true },
    })
  ));
}

async function updateFloorArea(companyId, areaId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const id = normalizeId(areaId, 'floor area');
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  if (Object.prototype.hasOwnProperty.call(source, 'name')) data.name = normalizeName(source.name, 'Area name', 80);
  if (Object.prototype.hasOwnProperty.call(source, 'sortOrder')) data.displayOrder = normalizeSortOrder(source.sortOrder);
  if (Object.prototype.hasOwnProperty.call(source, 'isActive')) data.isActive = normalizeBoolean(source.isActive, 'Area status');
  if (!Object.keys(data).length) throw setupError('RESTAURANT_SETUP_INVALID', 'Provide at least one floor area change.');
  return auditedTransaction(scopedCompanyId, actor, 'floor_area.updated', 'restaurant_floor_area', id, async (tx) => {
    await findOwned(tx, 'restaurantFloorArea', scopedCompanyId, id, 'Floor area');
    if (data.isActive === false) {
      const busyTables = await tx.restaurantTable.count({
        where: { companyId: scopedCompanyId, areaId: id, state: { not: 'free' } },
      });
      if (busyTables) throw setupError('RESTAURANT_AREA_IN_USE', 'Move or clear occupied tables before archiving this area.', 409);
    }
    return tx.restaurantFloorArea.update({
      where: { companyId_id: { companyId: scopedCompanyId, id } },
      data,
    });
  });
}

function normalizeSeats(value, fallback = 2) {
  const seats = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(seats) || seats < 1 || seats > 100) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Table capacity must be a whole number between 1 and 100.');
  }
  return seats;
}

async function createTable(companyId, areaId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const scopedAreaId = normalizeId(areaId, 'floor area');
  const name = normalizeName(body?.name, 'Table name', 40);
  const capacity = normalizeSeats(body?.seats ?? body?.capacity);
  const displayOrder = normalizeSortOrder(body?.sortOrder);
  return auditedTransaction(scopedCompanyId, actor, 'table.created', 'restaurant_table', null, async (tx) => {
    const area = await tx.restaurantFloorArea.findFirst({
      where: { id: scopedAreaId, companyId: scopedCompanyId, isActive: true },
      select: { id: true },
    });
    if (!area) throw setupError('RESTAURANT_AREA_NOT_FOUND', 'Choose an active floor area belonging to this company.', 404);
    return tx.restaurantTable.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        areaId: scopedAreaId,
        name,
        capacity,
        displayOrder,
        state: 'free',
        guestCount: 0,
        version: 1,
      },
    });
  });
}

async function updateTable(companyId, tableId, body, actor) {
  const scopedCompanyId = requireCompany(companyId);
  const id = normalizeId(tableId, 'table');
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  if (Object.prototype.hasOwnProperty.call(source, 'name')) data.name = normalizeName(source.name, 'Table name', 40);
  if (Object.prototype.hasOwnProperty.call(source, 'seats') || Object.prototype.hasOwnProperty.call(source, 'capacity')) {
    data.capacity = normalizeSeats(source.seats ?? source.capacity);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sortOrder')) data.displayOrder = normalizeSortOrder(source.sortOrder);
  if (Object.prototype.hasOwnProperty.call(source, 'areaId')) data.areaId = normalizeId(source.areaId, 'floor area');
  if (!Object.keys(data).length) throw setupError('RESTAURANT_SETUP_INVALID', 'Provide at least one table change.');
  return auditedTransaction(scopedCompanyId, actor, 'table.updated', 'restaurant_table', id, async (tx) => {
    const current = await findOwned(tx, 'restaurantTable', scopedCompanyId, id, 'Table');
    const identityChanged = ['name', 'capacity', 'areaId'].some((key) => Object.prototype.hasOwnProperty.call(data, key));
    if (identityChanged && (current.state !== 'free' || current.guestCount > 0 || current.mergedIntoTableId)) {
      throw setupError('RESTAURANT_TABLE_IN_USE', 'Only a free table can be renamed, moved, or resized.', 409);
    }
    if (data.areaId) {
      const area = await tx.restaurantFloorArea.findFirst({
        where: { id: data.areaId, companyId: scopedCompanyId, isActive: true },
        select: { id: true },
      });
      if (!area) throw setupError('RESTAURANT_AREA_NOT_FOUND', 'Choose an active floor area belonging to this company.', 404);
    }
    return tx.restaurantTable.update({
      where: { companyId_id: { companyId: scopedCompanyId, id } },
      data: { ...data, version: { increment: 1 } },
    });
  });
}

function createActor(req) {
  return {
    userId: String(req.user?.id || req.user?._id || ''),
    ip: requestIp(req),
  };
}

module.exports = {
  DEFAULT_STATIONS,
  createActor,
  createFloorArea,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
  createTable,
  getSetup,
  setupError,
  updateFloorArea,
  updateMenuCategory,
  updateMenuItem,
  updateModifierGroup,
  updateInventorySettings,
  updateTable,
};

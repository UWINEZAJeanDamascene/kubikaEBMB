'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
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
        select: { id: true, name: true, sku: true, categoryId: true, sellingPrice: true, taxCode: true, taxRate: true },
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

    const menuProductIds = [...new Set(menuItems.map((item) => item.productId))];
    const menuItemIds = menuItems.map((item) => item.id);
    const [menuProducts, assignments, tables] = await Promise.all([
      menuProductIds.length
        ? tx.product.findMany({
          where: { companyId: scopedCompanyId, id: { in: menuProductIds } },
          select: { id: true, name: true, sku: true, categoryId: true, sellingPrice: true, taxCode: true, taxRate: true },
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
      return {
        id: item.id,
        productId: item.productId,
        categoryId: product.categoryId,
        stationId: item.station === 'none' ? null : item.station,
        sortOrder: item.displayOrder,
        isAvailable: item.isAvailable,
        isActive: true,
        menuName: item.menuName,
        product: toProduct(product, categoryNames),
        category: { id: product.categoryId, name: categoryName || '' },
        station,
        modifierGroups: assignmentsByItemId.get(item.id) || [],
      };
    });

    return {
      products: products.map((product) => toProduct(product, categoryNames)),
      categories,
      menuItems: menuItemDtos,
      modifierGroups: modifierGroups.map((group) => groupsById.get(group.id)),
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
  const assignments = body?.modifierGroups ?? [];
  return auditedTransaction(scopedCompanyId, actor, 'menu_item.created', 'restaurant_menu_item', null, async (tx) => {
    await validateProduct(tx, scopedCompanyId, productId);
    const menuItem = await tx.restaurantMenuItem.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        productId,
        station,
        stockMode: 'none',
        isAvailable: true,
        displayOrder,
      },
    });
    await replaceModifierAssignments(tx, scopedCompanyId, menuItem.id, assignments);
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
  if (!Object.keys(data).length && !hasModifierGroups) {
    throw setupError('RESTAURANT_SETUP_INVALID', 'Provide at least one menu item change.');
  }
  return auditedTransaction(scopedCompanyId, actor, 'menu_item.updated', 'restaurant_menu_item', id, async (tx) => {
    const current = await findOwned(tx, 'restaurantMenuItem', scopedCompanyId, id, 'Menu item');
    const updated = Object.keys(data).length
      ? await tx.restaurantMenuItem.update({
        where: { companyId_id: { companyId: scopedCompanyId, id } },
        data,
      })
      : current;
    if (hasModifierGroups) await replaceModifierAssignments(tx, scopedCompanyId, id, source.modifierGroups);
    return updated;
  });
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
  updateTable,
};

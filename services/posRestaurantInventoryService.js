'use strict';

const { generateObjectId } = require('../utils/objectId');
const { resolvePurchaseUnit, toBaseQuantity } = require('../utils/purchaseUnitRules');

const ID_PATTERN = /^[a-f\d]{24}$/i;

function inventoryError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function decimal(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw inventoryError('RESTAURANT_RECIPE_INVALID', 'A recipe quantity is invalid.', 400);
  return parsed;
}

function roundedCost(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw inventoryError('RESTAURANT_STOCK_COST_INVALID', 'A stock cost is invalid.', 409);
  return Number(parsed.toFixed(4));
}

function currentUnitCost(level, product) {
  const parsed = Number(level.avgCost || product.averageCost || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw inventoryError('RESTAURANT_STOCK_COST_INVALID', `The average stock cost for ${product.name} is invalid.`, 409);
  }
  return Number(parsed.toFixed(6));
}

function committedUnitCost(commitment, level, product) {
  if (commitment.unitCost == null) return currentUnitCost(level, product);
  const parsed = Number(commitment.unitCost);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw inventoryError('RESTAURANT_STOCK_COST_INVALID', `The saved stock cost for ${product.name} is invalid.`, 409);
  }
  return Number(parsed.toFixed(6));
}

function toStockQuantity(quantity, unit) {
  try {
    return toBaseQuantity(quantity, unit);
  } catch (error) {
    throw inventoryError('RESTAURANT_RECIPE_UNIT_INVALID', error.message, 400);
  }
}

async function lockStockLevel(tx, companyId, productId, warehouseId) {
  await tx.stockLevel.upsert({
    where: { companyId_productId_warehouseId: { companyId, productId, warehouseId } },
    create: {
      id: generateObjectId(),
      companyId,
      productId,
      warehouseId,
      qtyOnHand: 0,
      qtyReserved: 0,
      qtyOnOrder: 0,
      avgCost: 0,
      totalValue: 0,
    },
    update: {},
  });
  await tx.$queryRawUnsafe(
    'SELECT id FROM stock_levels WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3 FOR UPDATE',
    companyId,
    productId,
    warehouseId,
  );
  const level = await tx.stockLevel.findUnique({
    where: { companyId_productId_warehouseId: { companyId, productId, warehouseId } },
  });
  if (!level) throw inventoryError('RESTAURANT_STOCK_LEVEL_MISSING', 'The stock level could not be locked. Refresh and retry.');
  return level;
}

function groupComponents(components) {
  const grouped = new Map();
  for (const component of components) {
    const key = `${component.orderItemId}:${component.productId}:${component.warehouseId}:${component.sourceType}:${component.purchaseUnitCode || ''}`;
    const current = grouped.get(key);
    if (current) {
      current.quantity += component.quantity;
      current.servingCount += component.servingCount || 0;
    }
    else grouped.set(key, { ...component });
  }
  return [...grouped.values()];
}

async function prepareRoundCommitments(tx, {
  companyId,
  order,
  items,
  actor,
  stockApprovalReason,
}) {
  const menuProductIds = [...new Set(items.map((item) => item.productId))];
  if (!menuProductIds.length) return { warnings: [], commitments: [] };
  const [menuItems, settings, register, company] = await Promise.all([
    tx.restaurantMenuItem.findMany({
      where: { companyId, productId: { in: menuProductIds }, isAvailable: true },
    }),
    tx.restaurantInventorySettings.findUnique({ where: { companyId } }),
    tx.posRegister.findFirst({
      where: { id: order.registerId, companyId },
      select: { branchId: true },
    }),
    tx.company.findUnique({ where: { id: companyId }, select: { ebmEnabled: true } }),
  ]);
  const menuByProductId = new Map(menuItems.map((item) => [item.productId, item]));
  const menuItemIds = menuItems.map((item) => item.id);
  const recipeIngredients = menuItemIds.length
    ? await tx.restaurantRecipeIngredient.findMany({
      where: { companyId, menuItemId: { in: menuItemIds } },
    })
    : [];
  const recipesByMenuItemId = new Map();
  for (const ingredient of recipeIngredients) {
    const list = recipesByMenuItemId.get(ingredient.menuItemId) || [];
    list.push(ingredient);
    recipesByMenuItemId.set(ingredient.menuItemId, list);
  }
  const ingredientProductIds = [...new Set([
    ...recipeIngredients.map((ingredient) => ingredient.productId),
    ...menuItems.map((item) => item.barStockProductId).filter(Boolean),
    ...items.filter((item) => menuByProductId.get(item.productId)?.stockMode === 'goods').map((item) => item.productId),
  ])];
  const stockProducts = ingredientProductIds.length
    ? await tx.product.findMany({
      where: { companyId, id: { in: ingredientProductIds }, isActive: true, isArchived: false },
      select: { id: true, name: true, unit: true, customFields: true, isStockable: true, averageCost: true },
    })
    : [];
  const productById = new Map(stockProducts.map((product) => [product.id, product]));
  const overrides = settings?.stationWarehouseOverrides && typeof settings.stationWarehouseOverrides === 'object'
    ? settings.stationWarehouseOverrides
    : {};
  const defaultWarehouseId = String(register?.branchId || '');
  const components = [];

  for (const item of items) {
    const menuItem = menuByProductId.get(item.productId);
    if (!menuItem) throw inventoryError('RESTAURANT_MENU_ITEM_UNAVAILABLE', 'A sent item is no longer available on the Restaurant menu.');
    const warehouseId = String(overrides[menuItem.station] || defaultWarehouseId);
    const itemRecipes = recipesByMenuItemId.get(menuItem.id) || [];
    const requiresWarehouse = itemRecipes.length > 0
      || Boolean(menuItem.barStockProductId)
      || (company?.ebmEnabled && menuItem.stockMode === 'goods');
    if (requiresWarehouse && !ID_PATTERN.test(warehouseId)) {
      throw inventoryError('POS_REGISTER_WAREHOUSE_REQUIRED', 'Assign a stock warehouse to this register or preparation station before sending this order.');
    }

    for (const recipe of itemRecipes) {
      const product = productById.get(recipe.productId);
      if (!product || product.isStockable === false) {
        throw inventoryError('RESTAURANT_RECIPE_PRODUCT_NOT_FOUND', 'A recipe ingredient is no longer an active stock product.');
      }
      let purchaseUnit;
      try {
        purchaseUnit = resolvePurchaseUnit(product, recipe.unitCode);
      } catch (error) {
        throw inventoryError('RESTAURANT_RECIPE_UNIT_INVALID', error.message, 400);
      }
      components.push({
        orderId: order.id,
        orderItemId: item.id,
        productId: product.id,
        productName: product.name,
        warehouseId,
        station: menuItem.station,
        sourceType: 'recipe',
        quantity: toStockQuantity(decimal(recipe.quantity) * Number(item.quantity), purchaseUnit),
      });
    }

    if (menuItem.barStockProductId) {
      const product = productById.get(menuItem.barStockProductId);
      const servingVolume = Number(menuItem.barServingVolume);
      let bottleUnit;
      try {
        bottleUnit = resolvePurchaseUnit(product, menuItem.barPurchaseUnitCode);
      } catch (error) {
        throw inventoryError('RESTAURANT_BAR_PURCHASE_UNIT_INVALID', error.message, 400);
      }
      if (!product || product.isStockable === false || !Number.isFinite(servingVolume) || servingVolume <= 0
        || String(menuItem.barServingUnit || '').toLowerCase() !== String(product.unit || '').toLowerCase()
        || bottleUnit.code === 'base' || servingVolume > bottleUnit.baseQuantity) {
        throw inventoryError('RESTAURANT_BAR_MEASURE_SETUP_REQUIRED', 'Complete the bar measure stock product, serving volume, and matching base unit before sending this item.');
      }
      components.push({
        orderId: order.id,
        orderItemId: item.id,
        productId: product.id,
        productName: product.name,
        warehouseId,
        station: menuItem.station,
        sourceType: 'bar_measure',
        servingCount: Number(item.quantity),
        purchaseUnitCode: bottleUnit.code,
        purchaseUnitVolume: bottleUnit.baseQuantity,
        quantity: toStockQuantity(servingVolume * Number(item.quantity), {
          code: 'base',
          label: product.unit || 'unit',
          baseQuantity: 1,
        }),
      });
    }

    if (company?.ebmEnabled && menuItem.stockMode === 'goods') {
      const product = productById.get(item.productId);
      if (!product || product.isStockable === false) continue;
      const level = await lockStockLevel(tx, companyId, product.id, warehouseId);
      const available = Number(level.qtyOnHand || 0) - Number(level.qtyReserved || 0);
      if (available < Number(item.quantity)) {
        throw inventoryError(
          'RESTAURANT_EBM_GOODS_STOCK_SHORTAGE',
          `${product.name} has insufficient stock for a fiscal sale. Ask a manager to record the stock adjustment, then retry.`,
        );
      }
    }
  }

  const commitments = groupComponents(components);
  const warnings = [];
  const shortageMode = settings?.recipeShortageMode || 'warn';
  const approvalReason = String(stockApprovalReason || '').normalize('NFKC').trim();
  for (const commitment of commitments) {
    const level = await lockStockLevel(tx, companyId, commitment.productId, commitment.warehouseId);
    const available = Number(level.qtyOnHand || 0) - Number(level.qtyReserved || 0);
    const stockProduct = productById.get(commitment.productId);
    if (!stockProduct) {
      throw inventoryError('RESTAURANT_STOCK_PRODUCT_NOT_FOUND', 'A recipe or bar stock product is unavailable.', 409);
    }
    const unitCost = currentUnitCost(level, stockProduct);
    const totalCost = roundedCost(commitment.quantity * unitCost);
    if (available < commitment.quantity) {
      const warning = {
        productId: commitment.productId,
        productName: commitment.productName,
        unit: productById.get(commitment.productId)?.unit || '',
        warehouseId: commitment.warehouseId,
        required: commitment.quantity,
        available: Math.max(0, available),
        shortage: commitment.quantity - Math.max(0, available),
      };
      if (shortageMode === 'block') {
        throw inventoryError(
          'RESTAURANT_RECIPE_STOCK_SHORTAGE',
          `${commitment.productName} has insufficient available stock. Reduce the order or ask a manager to update the stock record.`,
        );
      }
      if (shortageMode === 'require_manager'
        && (!actor.permissions?.includes('pos.till.void') || !approvalReason || approvalReason.length > 500)) {
        throw inventoryError(
          'RESTAURANT_STOCK_MANAGER_APPROVAL_REQUIRED',
          'A manager must approve this stock shortage with a reason before the round can be sent.',
          403,
        );
      }
      warnings.push(warning);
    }

    await tx.restaurantStockCommitment.create({
      data: {
        id: generateObjectId(),
        companyId,
        orderId: order.id,
        orderItemId: commitment.orderItemId,
        productId: commitment.productId,
        warehouseId: commitment.warehouseId,
        quantity: String(commitment.quantity),
        sourceType: commitment.sourceType || 'recipe',
        servingCount: commitment.servingCount || 0,
        purchaseUnitCode: commitment.purchaseUnitCode || null,
        purchaseUnitVolume: commitment.purchaseUnitVolume == null ? null : String(commitment.purchaseUnitVolume),
        status: 'committed',
        unitCost: String(unitCost),
        totalCost: String(totalCost),
        committedAt: new Date(),
      },
    });
    await tx.stockLevel.update({
      where: { companyId_productId_warehouseId: {
        companyId,
        productId: commitment.productId,
        warehouseId: commitment.warehouseId,
      } },
      data: { qtyReserved: { increment: commitment.quantity } },
    });
  }

  return {
    warnings,
    commitments,
    approval: warnings.length && shortageMode === 'require_manager'
      ? { reason: approvalReason, approvedById: actor.userId }
      : null,
  };
}

async function releaseCommitment(tx, commitment, {
  companyId,
  actorId,
  reason,
  decision,
  prepared,
}) {
  if (decision === 'return' && (prepared || !actorId)) {
    throw inventoryError(
      'RESTAURANT_VOID_RETURN_NOT_ALLOWED',
      prepared
        ? 'A prepared or poured item cannot be returned to stock. Record it as waste.'
        : 'A manager must approve an unprepared stock return.',
      403,
    );
  }
  const product = await tx.product.findFirst({
    where: { id: commitment.productId, companyId },
    select: { id: true, name: true, currentStock: true, averageCost: true },
  });
  if (!product) throw inventoryError('RESTAURANT_STOCK_PRODUCT_NOT_FOUND', 'A committed stock product is no longer available.');
  const level = await lockStockLevel(tx, companyId, commitment.productId, commitment.warehouseId);
  const quantity = Number(commitment.quantity);
  const previousStock = Number(level.qtyOnHand || 0);
  const unitCost = committedUnitCost(commitment, level, product);
  const totalCost = roundedCost(quantity * unitCost);
  const isWaste = decision === 'waste';
  await tx.stockLevel.update({
    where: { companyId_productId_warehouseId: {
      companyId,
      productId: commitment.productId,
      warehouseId: commitment.warehouseId,
    } },
    data: {
      qtyReserved: { decrement: quantity },
      ...(isWaste ? {
        qtyOnHand: { decrement: quantity },
        totalValue: { decrement: totalCost },
        lastMovementAt: new Date(),
        lastMovementType: 'dispatch',
      } : {}),
    },
  });
  if (isWaste) {
    await tx.product.update({
      where: { id: commitment.productId },
      data: { currentStock: { decrement: quantity } },
    });
    await tx.stockMovement.create({
      data: {
        id: generateObjectId(),
        companyId,
        productId: commitment.productId,
        type: 'out',
        reason: 'restaurant_recipe',
        quantity: String(quantity),
        previousStock: String(previousStock),
        newStock: String(previousStock - quantity),
        unitCost: String(unitCost),
        totalCost: String(totalCost),
        warehouseId: commitment.warehouseId,
        referenceType: 'other',
        referenceNumber: `Restaurant order ${commitment.orderId}`,
        referenceDocumentId: commitment.orderId,
        referenceModel: 'RestaurantOrder',
        performedById: actorId,
        notes: `Restaurant item ${commitment.orderItemId} voided as waste: ${reason}`,
      },
    });
  }
  await tx.restaurantStockCommitment.update({
    where: { id: commitment.id },
    data: {
      status: isWaste ? 'waste' : 'returned',
      unitCost: String(unitCost),
      totalCost: String(totalCost),
      voidedAt: new Date(),
      voidDecision: decision,
    },
  });
  return { quantity, unitCost, totalCost, productName: product.name };
}

async function voidItemCommitments(tx, { companyId, itemId, actorId, reason, decision, prepared }) {
  const commitments = await tx.restaurantStockCommitment.findMany({
    where: { companyId, orderItemId: itemId, status: 'committed' },
    orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
  });
  const results = [];
  for (const commitment of commitments) {
    results.push(await releaseCommitment(tx, commitment, {
      companyId,
      actorId,
      reason,
      decision,
      prepared,
    }));
  }
  return results;
}

async function closeOrderCommitments(tx, { companyId, orderId, actorId }) {
  const commitments = await tx.restaurantStockCommitment.findMany({
    where: { companyId, orderId, status: 'committed' },
    orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }, { orderItemId: 'asc' }],
  });
  for (const commitment of commitments) {
    const product = await tx.product.findFirst({
      where: { id: commitment.productId, companyId },
      select: { id: true, name: true, currentStock: true, averageCost: true },
    });
    if (!product) throw inventoryError('RESTAURANT_STOCK_PRODUCT_NOT_FOUND', 'A committed recipe ingredient is no longer available.');
    const level = await lockStockLevel(tx, companyId, commitment.productId, commitment.warehouseId);
    const quantity = Number(commitment.quantity);
    const previousStock = Number(level.qtyOnHand || 0);
    const unitCost = committedUnitCost(commitment, level, product);
    const totalCost = roundedCost(quantity * unitCost);
    await tx.stockLevel.update({
      where: { companyId_productId_warehouseId: {
        companyId,
        productId: commitment.productId,
        warehouseId: commitment.warehouseId,
      } },
      data: {
        qtyOnHand: { decrement: quantity },
        qtyReserved: { decrement: quantity },
        totalValue: { decrement: totalCost },
        lastMovementAt: new Date(),
        lastMovementType: 'dispatch',
      },
    });
    await tx.product.update({
      where: { id: commitment.productId },
      data: { currentStock: { decrement: quantity }, lastSaleDate: new Date() },
    });
    await tx.stockMovement.create({
      data: {
        id: generateObjectId(),
        companyId,
        productId: commitment.productId,
        type: 'out',
        reason: 'restaurant_recipe',
        quantity: String(quantity),
        previousStock: String(previousStock),
        newStock: String(previousStock - quantity),
        unitCost: String(unitCost),
        totalCost: String(totalCost),
        warehouseId: commitment.warehouseId,
        referenceType: 'other',
        referenceNumber: `Restaurant order ${orderId}`,
        referenceDocumentId: orderId,
        referenceModel: 'RestaurantOrder',
        performedById: actorId,
        notes: `Restaurant recipe/measure consumption at order close for item ${commitment.orderItemId}`,
      },
    });
    await tx.restaurantStockCommitment.update({
      where: { id: commitment.id },
      data: {
        status: 'deducted',
        unitCost: String(unitCost),
        totalCost: String(totalCost),
        closedAt: new Date(),
      },
    });
  }
  return commitments.length;
}

module.exports = {
  closeOrderCommitments,
  prepareRoundCommitments,
  voidItemCommitments,
};

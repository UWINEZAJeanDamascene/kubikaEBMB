'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const restaurantSetupService = require('./posRestaurantSetupService');
const socketService = require('./socketService');

const ID_PATTERN = /^[a-f0-9]{24}$/i;
const STATIONS = new Set(['kitchen', 'bar']);
const OPEN_ORDER_STATUS = 'open';
const ACTIVE_ORDER_STATUSES = ['open', 'billed'];
const ACTIVE_TICKET_STATUSES = ['queued', 'preparing', 'ready'];

function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requireCompany(value) {
  const companyId = String(value || '').trim();
  if (!ID_PATTERN.test(companyId)) {
    throw fail('RESTAURANT_COMPANY_REQUIRED', 'A valid company context is required.', 400);
  }
  return companyId;
}

function requireActor(actor) {
  const userId = String(actor?.userId || '').trim();
  if (!ID_PATTERN.test(userId)) {
    throw fail('RESTAURANT_ACTOR_REQUIRED', 'A valid signed-in POS user is required.', 401);
  }
  const registerId = String(actor?.registerId || '').trim();
  if (!ID_PATTERN.test(registerId)) {
    throw fail('RESTAURANT_REGISTER_REQUIRED', 'A valid POS register is required.', 401);
  }
  return { ...actor, userId, registerId };
}

function normalizeId(value, label) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw fail('RESTAURANT_ORDER_INVALID', `Choose a valid ${label}.`);
  return id;
}

function normalizeText(value, label, maxLength, { required = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (required && !text) throw fail('RESTAURANT_ORDER_INVALID', `${label} is required.`);
  if (text.length > maxLength) throw fail('RESTAURANT_ORDER_INVALID', `${label} must be ${maxLength} characters or fewer.`);
  return text;
}

function normalizeExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw fail('RESTAURANT_ORDER_VERSION_REQUIRED', 'Refresh the order before making this change.', 409);
  }
  return version;
}

function emptySnapshot(trainingMode = false) {
  return { items: [], rounds: [], trainingMode: Boolean(trainingMode) };
}

function readSnapshot(event) {
  const payload = event?.payloadJson;
  const snapshot = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.snapshot
    : null;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return emptySnapshot();
  return {
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    rounds: Array.isArray(snapshot.rounds) ? snapshot.rounds : [],
    trainingMode: Boolean(snapshot.trainingMode),
  };
}

async function findOrder(tx, companyId, orderId) {
  const order = await tx.restaurantOrder.findFirst({
    where: { id: orderId, companyId },
  });
  if (!order) throw fail('RESTAURANT_ORDER_NOT_FOUND', 'This order is not available in this company.', 404);
  return order;
}

async function findSnapshot(tx, companyId, order) {
  const event = await tx.restaurantOrderEvent.findFirst({
    where: { companyId, orderId: order.id, version: order.version },
  });
  return readSnapshot(event);
}

function orderView(order, snapshot) {
  return {
    id: order.id,
    companyId: order.companyId,
    registerId: order.registerId,
    tableId: order.tableId,
    orderKind: order.orderKind,
    status: order.status,
    version: order.version,
    guestCount: order.guestCount,
    waiterId: order.waiterId,
    tabName: order.tabName,
    openedAt: order.openedAt,
    updatedAt: order.updatedAt,
    items: snapshot.items,
    rounds: snapshot.rounds,
    trainingMode: snapshot.trainingMode,
  };
}

async function listShiftHandoverOrders(client, companyId, registerId) {
  const orders = await client.restaurantOrder.findMany({
    where: { companyId, registerId, status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  });
  if (!orders.length) return [];

  const [events, tables] = await Promise.all([
    client.restaurantOrderEvent.findMany({
      where: { companyId, orderId: { in: orders.map((order) => order.id) } },
      orderBy: [{ orderId: 'asc' }, { version: 'desc' }],
    }),
    client.restaurantTable.findMany({
      where: { companyId, id: { in: orders.map((order) => order.tableId).filter(Boolean) } },
      select: { id: true, name: true },
    }),
  ]);
  const snapshots = new Map();
  for (const event of events) {
    if (!snapshots.has(event.orderId)) snapshots.set(event.orderId, readSnapshot(event));
  }
  const tableNames = new Map(tables.map((table) => [table.id, table.name]));

  return orders.map((order) => {
    const snapshot = snapshots.get(order.id) || emptySnapshot();
    return {
      id: order.id,
      orderKind: order.orderKind,
      status: order.status,
      tableId: order.tableId,
      tableName: order.tableId ? tableNames.get(order.tableId) || null : null,
      tabName: order.tabName,
      waiterId: order.waiterId,
      openedAt: order.openedAt,
      itemCount: snapshot.items.filter((item) => item.status !== 'voided')
        .reduce((count, item) => count + Number(item.quantity || 0), 0),
    };
  });
}

async function carryOpenOrdersForShiftHandover(tx, {
  companyId,
  registerId,
  fromUserId,
  toUserId,
  shiftId,
}) {
  const openOrders = await tx.restaurantOrder.findMany({
    where: { companyId, registerId, status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  });
  const billedOrders = openOrders.filter((order) => order.status === 'billed');
  if (billedOrders.length) {
    return {
      code: 'RESTAURANT_OPEN_BILLED_ORDERS_BLOCKED',
      blockedOrders: await listShiftHandoverOrders(tx, companyId, registerId),
    };
  }

  const carriedOrders = [];
  for (const order of openOrders) {
    if (order.waiterId === toUserId) continue;
    const snapshot = await findSnapshot(tx, companyId, order);
    const updated = await writeOrderVersion(
      tx,
      order,
      snapshot,
      'TAB_CARRIED',
      {
        handover: {
          shiftId,
          fromUserId,
          toUserId,
        },
      },
      { userId: fromUserId },
      `shift-handover:${shiftId}:${order.id}:${order.version + 1}`,
      { waiterId: toUserId },
    );
    carriedOrders.push(orderView(updated, snapshot));
  }
  return { orders: carriedOrders };
}

function notifyHandoverOrders(companyId, orders) {
  for (const order of orders) {
    socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
      orderId: order.id,
      version: order.version,
      change: 'tab_carried',
    });
  }
}

function decimalText(value) {
  return value == null ? '0' : String(value);
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw fail('RESTAURANT_ORDER_INVALID', 'Item quantity must be a whole number from 1 to 99.');
  }
  return quantity;
}

function eventKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 160) throw fail('POS_IDEMPOTENCY_KEY_REQUIRED', 'Refresh and retry this action.');
  return key;
}

async function writeOrderVersion(
  tx,
  order,
  snapshot,
  eventType,
  eventPayload,
  actor,
  key,
  extraData = {},
  expectedStatus = OPEN_ORDER_STATUS,
) {
  const nextVersion = order.version + 1;
  const now = new Date();
  const updated = await tx.restaurantOrder.updateMany({
    where: {
      id: order.id,
      companyId: order.companyId,
      status: expectedStatus,
      version: order.version,
    },
    data: { ...extraData, version: nextVersion, updatedAt: now },
  });
  if (updated.count !== 1) {
    throw fail('RESTAURANT_ORDER_VERSION_CONFLICT', 'Another staff member changed this order. Refresh and try again.', 409);
  }
  await tx.restaurantOrderEvent.create({
    data: {
      id: generateObjectId(),
      companyId: order.companyId,
      orderId: order.id,
      version: nextVersion,
      idempotencyKey: key,
      eventType,
      payloadJson: { ...eventPayload, snapshot },
      actorId: actor.userId,
      createdAt: now,
    },
  });
  return { ...order, ...extraData, version: nextVersion, updatedAt: now };
}

async function getOverview(companyIdValue) {
  const companyId = requireCompany(companyIdValue);
  const setup = await restaurantSetupService.getSetup(companyId);
  const orders = await prisma.restaurantOrder.findMany({
    where: { companyId, status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: [{ updatedAt: 'desc' }, { openedAt: 'desc' }],
  });
  const orderIds = orders.map((order) => order.id);
  const [events, readyTickets] = await Promise.all([
    orderIds.length
      ? prisma.restaurantOrderEvent.findMany({
        where: { companyId, orderId: { in: orderIds } },
        orderBy: { version: 'desc' },
      })
      : [],
    prisma.restaurantKitchenTicket.findMany({
      where: { companyId, status: 'ready' },
      orderBy: [{ updatedAt: 'desc' }],
    }),
  ]);
  const snapshots = new Map();
  for (const event of events) {
    if (!snapshots.has(event.orderId)) snapshots.set(event.orderId, readSnapshot(event));
  }
  const enabledCategoryIds = new Set(
    setup.categories.filter((category) => category.isEnabled && category.categoryActive)
      .map((category) => category.categoryId),
  );
  const menuItems = setup.menuItems.filter((item) => item.isAvailable && enabledCategoryIds.has(item.categoryId));

  return {
    categories: setup.categories.filter((category) => category.isEnabled && category.categoryActive),
    menuItems,
    areas: setup.areas.filter((area) => area.isActive),
    orders: orders.map((order) => orderView(order, snapshots.get(order.id) || emptySnapshot())),
    readyTickets,
    displays: {
      kitchen: socketService.hasRestaurantDisplay(companyId, 'kitchen'),
      bar: socketService.hasRestaurantDisplay(companyId, 'bar'),
    },
  };
}

async function getOrder(companyIdValue, orderIdValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  return prisma.$transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId);
    const snapshot = await findSnapshot(tx, companyId, order);
    const tickets = await tx.restaurantKitchenTicket.findMany({
      where: { companyId, orderId },
      orderBy: [{ roundNumber: 'asc' }, { station: 'asc' }],
    });
    return { ...orderView(order, snapshot), tickets };
  });
}

async function claimBill(companyIdValue, orderIdValue, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const result = await prisma.$transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId);
    if (String(order.registerId) !== actor.registerId) {
      throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Open this order on the register that created it.', 403);
    }
    const snapshot = await findSnapshot(tx, companyId, order);
    if (order.status === 'billed') return { order: orderView(order, snapshot), changed: false };
    if (order.status !== OPEN_ORDER_STATUS) {
      throw fail('RESTAURANT_ORDER_CLOSED', 'This order is no longer available for billing.', 409);
    }
    if (actor.trainingMode || snapshot.trainingMode) {
      throw fail('RESTAURANT_TRAINING_ORDER', 'Training orders cannot be billed as real sales.', 409);
    }
    if (snapshot.items.some((item) => item.status === 'unsent')) {
      throw fail('RESTAURANT_ORDER_UNSENT_ITEMS', 'Send or remove every unsent item before issuing the bill.', 409);
    }
    if (!snapshot.items.some((item) => item.status === 'sent')) {
      throw fail('RESTAURANT_ORDER_EMPTY', 'Add and send at least one item before issuing the bill.', 409);
    }

    const billedOrder = await writeOrderVersion(
      tx,
      order,
      snapshot,
      'BILL_ISSUED',
      {},
      actor,
      key,
      { status: 'billed' },
    );
    if (order.tableId) {
      const table = await tx.restaurantTable.updateMany({
        where: { id: order.tableId, companyId, state: 'occupied' },
        data: { state: 'bill_printed', version: { increment: 1 } },
      });
      if (table.count !== 1) {
        throw fail('RESTAURANT_TABLE_STATE_CONFLICT', 'Refresh the floor before issuing this bill.', 409);
      }
    }
    return { order: orderView(billedOrder, snapshot), changed: true };
  });
  if (result.changed) {
    socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
      orderId,
      version: result.order.version,
      change: 'bill',
    });
  }
  return result.order;
}

async function markBillPaid(tx, companyIdValue, orderIdValue, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const order = await findOrder(tx, companyId, orderId);
  const snapshot = await findSnapshot(tx, companyId, order);
  if (String(order.registerId) !== actor.registerId) {
    throw fail('RESTAURANT_ORDER_REGISTER_MISMATCH', 'Complete payment on the register that created this order.', 403);
  }
  if (order.status === 'paid') return orderView(order, snapshot);
  if (order.status !== 'billed') {
    throw fail('RESTAURANT_ORDER_BILL_REQUIRED', 'Issue a bill before completing payment.', 409);
  }

  const paidOrder = await writeOrderVersion(
    tx,
    order,
    snapshot,
    'BILL_PAID',
    {},
    actor,
    key,
    { status: 'paid' },
    'billed',
  );
  if (order.tableId) {
    const table = await tx.restaurantTable.updateMany({
      where: { id: order.tableId, companyId, state: { in: ['bill_printed', 'occupied'] } },
      data: { state: 'free', guestCount: 0, version: { increment: 1 } },
    });
    if (table.count !== 1) {
      throw fail('RESTAURANT_TABLE_STATE_CONFLICT', 'The paid sale completed, but its table could not be released. Refresh or ask a manager to review the floor.', 409);
    }
  }
  return orderView(paidOrder, snapshot);
}

async function openOrder(companyIdValue, body, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const requestedOrderKind = String(source.orderKind || '');
  const orderKind = requestedOrderKind === 'counter' ? 'quick_sale' : requestedOrderKind;
  if (!['dining', 'bar_tab', 'quick_sale'].includes(orderKind)) {
    throw fail('RESTAURANT_ORDER_INVALID', 'Choose table service, a bar tab, or a counter order.');
  }
  const tableId = source.tableId ? normalizeId(source.tableId, 'table') : null;
  if (orderKind === 'dining' && !tableId) {
    throw fail('RESTAURANT_ORDER_INVALID', 'Choose a table for table service.');
  }
  const tabName = orderKind === 'bar_tab'
    ? normalizeText(source.tabName, 'Tab name', 120, { required: true })
    : null;
  const guestCount = Number(source.guestCount ?? 1);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 100) {
    throw fail('RESTAURANT_ORDER_INVALID', 'Guest count must be a whole number from 1 to 100.');
  }
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    if (tableId) {
      const active = await tx.restaurantOrder.findFirst({
        where: { companyId, tableId, status: { in: ACTIVE_ORDER_STATUSES } },
      });
      if (active) throw fail('RESTAURANT_TABLE_IN_USE', 'This table already has an open order. Open that order instead.', 409);
      const table = await tx.restaurantTable.findFirst({
        where: { id: tableId, companyId },
        select: { id: true, state: true, capacity: true },
      });
      if (!table) throw fail('RESTAURANT_TABLE_NOT_FOUND', 'This table is not available in this company.', 404);
      if (table.state !== 'free') throw fail('RESTAURANT_TABLE_IN_USE', 'This table is not free. Refresh the floor and try again.', 409);
      if (guestCount > table.capacity) throw fail('RESTAURANT_ORDER_INVALID', 'Guest count cannot exceed the table capacity.');
      const claimed = await tx.restaurantTable.updateMany({
        where: { id: tableId, companyId, state: 'free' },
        data: { state: 'occupied', guestCount, version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw fail('RESTAURANT_TABLE_IN_USE', 'Another staff member opened this table. Refresh the floor.', 409);
    }

    const order = await tx.restaurantOrder.create({
      data: {
        id: generateObjectId(),
        companyId,
        registerId: actor.registerId,
        tableId,
        status: OPEN_ORDER_STATUS,
        version: 1,
        guestCount,
        openedById: actor.userId,
        waiterId: actor.userId,
        openedAt: now,
        updatedAt: now,
        orderKind,
        tabName,
      },
    });
    const snapshot = emptySnapshot(actor.trainingMode);
    await tx.restaurantOrderEvent.create({
      data: {
        id: generateObjectId(),
        companyId,
        orderId: order.id,
        version: 1,
        idempotencyKey: key,
        eventType: 'ORDER_OPENED',
        payloadJson: { snapshot, tableId, orderKind },
        actorId: actor.userId,
        createdAt: now,
      },
    });
    return orderView(order, snapshot);
  });
  socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
    orderId: result.id,
    version: result.version,
    change: 'opened',
  });
  return result;
}

async function buildLines(tx, companyId, inputItems) {
  if (!Array.isArray(inputItems) || inputItems.length > 100) {
    throw fail('RESTAURANT_ORDER_INVALID', 'An order can contain up to 100 unsent lines.');
  }
  if (!inputItems.length) return [];

  const prepared = inputItems.map((item) => {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return {
      productId: normalizeId(source.productId, 'menu item'),
      quantity: normalizeQuantity(source.quantity),
      note: normalizeText(source.note, 'Item note', 240),
      modifierOptionIds: Array.isArray(source.modifierOptionIds)
        ? [...new Set(source.modifierOptionIds.map((id) => normalizeId(id, 'modifier choice')))]
        : [],
    };
  });
  const productIds = [...new Set(prepared.map((item) => item.productId))];
  const [menuItems, products] = await Promise.all([
    tx.restaurantMenuItem.findMany({
      where: { companyId, productId: { in: productIds }, isAvailable: true },
    }),
    tx.product.findMany({
      where: { companyId, id: { in: productIds }, isActive: true, isArchived: false },
      select: { id: true, name: true, sku: true, categoryId: true, sellingPrice: true, taxCode: true, taxRate: true },
    }),
  ]);
  const menuByProductId = new Map(menuItems.map((item) => [item.productId, item]));
  const productById = new Map(products.map((product) => [product.id, product]));
  if (productIds.some((id) => !menuByProductId.has(id) || !productById.has(id))) {
    throw fail('RESTAURANT_MENU_ITEM_UNAVAILABLE', 'A selected item is no longer available. Refresh the menu.', 409);
  }

  const menuItemIds = [...new Set(menuItems.map((item) => item.id))];
  const categoryIds = [...new Set(products.map((product) => product.categoryId))];
  const [categorySettings, assignments] = await Promise.all([
    tx.restaurantMenuCategory.findMany({
      where: { companyId, categoryId: { in: categoryIds }, isEnabled: true },
      select: { categoryId: true },
    }),
    tx.restaurantMenuItemModifierGroup.findMany({
      where: { companyId, menuItemId: { in: menuItemIds } },
    }),
  ]);
  const enabledCategoryIds = new Set(categorySettings.map((category) => category.categoryId));
  if (products.some((product) => !enabledCategoryIds.has(product.categoryId))) {
    throw fail('RESTAURANT_MENU_ITEM_UNAVAILABLE', 'A selected menu section is disabled. Refresh the menu.', 409);
  }
  const groupIds = [...new Set(assignments.map((assignment) => assignment.modifierGroupId))];
  const [groups, options] = groupIds.length
    ? await Promise.all([
      tx.restaurantModifierGroup.findMany({
        where: { companyId, id: { in: groupIds }, isActive: true },
      }),
      tx.restaurantModifierOption.findMany({
        where: { companyId, groupId: { in: groupIds }, isAvailable: true },
      }),
    ])
    : [[], []];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const optionById = new Map(options.map((option) => [option.id, option]));
  const assignmentsByMenuItem = new Map();
  for (const assignment of assignments) {
    if (!groupById.has(assignment.modifierGroupId)) continue;
    const current = assignmentsByMenuItem.get(assignment.menuItemId) || [];
    current.push(assignment.modifierGroupId);
    assignmentsByMenuItem.set(assignment.menuItemId, current);
  }

  return prepared.map((input) => {
    const menuItem = menuByProductId.get(input.productId);
    const product = productById.get(input.productId);
    const assignedGroups = new Set(assignmentsByMenuItem.get(menuItem.id) || []);
    const selected = input.modifierOptionIds.map((id) => optionById.get(id));
    if (selected.some((option) => !option || !assignedGroups.has(option.groupId))) {
      throw fail('RESTAURANT_MODIFIER_INVALID', 'A selected modifier is not available for this item.');
    }
    for (const groupId of assignedGroups) {
      const group = groupById.get(groupId);
      const count = selected.filter((option) => option.groupId === groupId).length;
      if (count < group.minSelections || count > group.maxSelections) {
        throw fail('RESTAURANT_MODIFIER_REQUIRED', `Choose ${group.minSelections === group.maxSelections ? group.minSelections : `between ${group.minSelections} and ${group.maxSelections}`} option(s) for ${group.name}.`);
      }
    }
    const modifiers = selected.map((option) => ({
      id: option.id,
      groupId: option.groupId,
      groupName: groupById.get(option.groupId).name,
      name: option.name,
      priceAdjustment: decimalText(option.priceAdjustment),
    }));
    return {
      id: generateObjectId(),
      productId: product.id,
      name: menuItem.menuName || product.name,
      sku: product.sku,
      quantity: input.quantity,
      unitPrice: decimalText(product.sellingPrice),
      taxCode: product.taxCode,
      taxRate: decimalText(product.taxRate),
      station: STATIONS.has(menuItem.station) ? menuItem.station : 'none',
      modifiers,
      note: input.note,
      status: 'unsent',
      roundNumber: null,
    };
  });
}

async function updateUnsentItems(companyIdValue, orderIdValue, body, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const expectedVersion = normalizeExpectedVersion(body?.expectedVersion);
  const updated = await prisma.$transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId);
    if (order.status !== OPEN_ORDER_STATUS) throw fail('RESTAURANT_ORDER_CLOSED', 'This order is no longer open.', 409);
    if (order.version !== expectedVersion) throw fail('RESTAURANT_ORDER_VERSION_CONFLICT', 'Another staff member changed this order. Refresh and try again.', 409);
    const snapshot = await findSnapshot(tx, companyId, order);
    const newLines = await buildLines(tx, companyId, body?.items);
    const sentLines = snapshot.items.filter((item) => item.status !== 'unsent');
    const nextSnapshot = {
      ...snapshot,
      items: [...sentLines, ...newLines],
    };
    const savedOrder = await writeOrderVersion(tx, order, nextSnapshot, 'ITEMS_UPDATED', {}, actor, key);
    return orderView(savedOrder, nextSnapshot);
  });
  socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
    orderId,
    version: updated.version,
    change: 'items',
  });
  return updated;
}

function ticketPayload(order, roundNumber, station, items, tableName, waiterName, createdAt) {
  return {
    orderId: order.id,
    orderKind: order.orderKind,
    tableId: order.tableId,
    tableName,
    tabName: order.tabName,
    waiterName,
    roundNumber,
    station,
    sentAt: createdAt.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      modifiers: item.modifiers,
      note: item.note,
      status: item.status,
    })),
  };
}

function ticketKey(companyId, orderId, roundNumber, station, requestKey) {
  return crypto.createHash('sha256')
    .update(`${companyId}:${orderId}:${roundNumber}:${station}:${requestKey}`)
    .digest('hex');
}

async function sendRound(companyIdValue, orderIdValue, body, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const expectedVersion = normalizeExpectedVersion(body?.expectedVersion);
  const result = await prisma.$transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId);
    if (order.status !== OPEN_ORDER_STATUS) throw fail('RESTAURANT_ORDER_CLOSED', 'This order is no longer open.', 409);
    if (order.version !== expectedVersion) throw fail('RESTAURANT_ORDER_VERSION_CONFLICT', 'Another staff member changed this order. Refresh and try again.', 409);
    const snapshot = await findSnapshot(tx, companyId, order);
    const unsent = snapshot.items.filter((item) => item.status === 'unsent');
    if (!unsent.length) throw fail('RESTAURANT_ORDER_NO_UNSENT_ITEMS', 'Add items before sending a new round.');
    const roundNumber = snapshot.rounds.reduce((max, round) => Math.max(max, Number(round.roundNumber) || 0), 0) + 1;
    const now = new Date();
    const nextItems = snapshot.items.map((item) => item.status === 'unsent'
      ? { ...item, status: 'sent', roundNumber, sentAt: now.toISOString() }
      : item);
    const tickets = [];
    const stations = actor.trainingMode ? [] : [...STATIONS].filter((station) => unsent.some((item) => item.station === station));
    const table = order.tableId
      ? await tx.restaurantTable.findFirst({ where: { id: order.tableId, companyId }, select: { name: true } })
      : null;
    for (const station of stations) {
      const id = generateObjectId();
      const payloadJson = ticketPayload(
        order,
        roundNumber,
        station,
        nextItems.filter((item) => item.station === station && item.roundNumber === roundNumber),
        table?.name || null,
        actor.name || 'Staff',
        now,
      );
      const displayOnline = socketService.hasRestaurantDisplay(companyId, station);
      const ticket = await tx.restaurantKitchenTicket.create({
        data: {
          id,
          companyId,
          orderId,
          roundNumber,
          station,
          status: 'queued',
          idempotencyKey: ticketKey(companyId, orderId, roundNumber, station, key),
          payloadJson,
          reprintCount: 0,
          retryCount: 0,
          lastError: displayOnline ? null : `${station === 'kitchen' ? 'Kitchen' : 'Bar'} display is offline. The ticket is saved and will appear when the display reconnects.`,
          createdAt: now,
          updatedAt: now,
          fallbackAttempted: false,
        },
      });
      tickets.push({ ...ticket, displayOnline });
    }
    const nextSnapshot = {
      ...snapshot,
      items: nextItems,
      rounds: [...snapshot.rounds, { roundNumber, sentAt: now.toISOString(), ticketIds: tickets.map((ticket) => ticket.id) }],
    };
    const savedOrder = await writeOrderVersion(tx, order, nextSnapshot, 'ROUND_SENT', {
      roundNumber,
      ticketIds: tickets.map((ticket) => ticket.id),
      trainingMode: actor.trainingMode,
    }, actor, key);
    return {
      order: orderView(savedOrder, nextSnapshot),
      tickets,
      stationDelivery: Object.fromEntries([...STATIONS].map((station) => [
        station,
        { online: socketService.hasRestaurantDisplay(companyId, station), ticketCreated: tickets.some((ticket) => ticket.station === station) },
      ])),
    };
  });
  socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
    orderId,
    version: result.order.version,
    change: 'round_sent',
  });
  for (const ticket of result.tickets) {
    socketService.emitToRestaurantStation(companyId, ticket.station, 'restaurant:ticket-new', {
      ticketId: ticket.id,
      orderId,
      station: ticket.station,
      roundNumber: ticket.roundNumber,
    });
  }
  return result;
}

async function listStationTickets(companyIdValue, stationValue) {
  const companyId = requireCompany(companyIdValue);
  const station = String(stationValue || '').trim().toLowerCase();
  if (!STATIONS.has(station)) throw fail('RESTAURANT_STATION_INVALID', 'Choose Kitchen or Bar.');
  const tickets = await prisma.restaurantKitchenTicket.findMany({
    where: { companyId, station, status: { in: ACTIVE_TICKET_STATUSES } },
    orderBy: [{ createdAt: 'asc' }, { roundNumber: 'asc' }],
  });
  return {
    station,
    displayOnline: socketService.hasRestaurantDisplay(companyId, station),
    tickets,
  };
}

async function updateTicketStatus(companyIdValue, ticketIdValue, body, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const ticketId = normalizeId(ticketIdValue, 'ticket');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const targetStatus = String(body?.status || '').trim().toLowerCase();
  if (!['preparing', 'ready', 'picked_up'].includes(targetStatus)) {
    throw fail('RESTAURANT_TICKET_STATUS_INVALID', 'Choose Preparing, Ready, or Picked up.');
  }
  const result = await prisma.$transaction(async (tx) => {
    const ticket = await tx.restaurantKitchenTicket.findFirst({ where: { id: ticketId, companyId } });
    if (!ticket) throw fail('RESTAURANT_TICKET_NOT_FOUND', 'This ticket is not available in this company.', 404);
    if (ticket.status === targetStatus) return { ticket, orderVersion: null };
    const allowed = (ticket.status === 'queued' && targetStatus === 'preparing')
      || (ticket.status === 'preparing' && targetStatus === 'ready')
      || (ticket.status === 'ready' && targetStatus === 'picked_up');
    if (!allowed) throw fail('RESTAURANT_TICKET_STATUS_CONFLICT', 'This ticket has already changed. Refresh the station screen.', 409);
    const order = await findOrder(tx, companyId, ticket.orderId);
    const snapshot = await findSnapshot(tx, companyId, order);
    const now = new Date();
    const changed = await tx.restaurantKitchenTicket.updateMany({
      where: { id: ticketId, companyId, status: ticket.status },
      data: { status: targetStatus, updatedAt: now, lastError: null },
    });
    if (changed.count !== 1) throw fail('RESTAURANT_TICKET_STATUS_CONFLICT', 'Another staff member changed this ticket. Refresh and try again.', 409);
    const savedOrder = await writeOrderVersion(tx, order, snapshot, 'TICKET_STATUS_UPDATED', {
      ticketId,
      station: ticket.station,
      status: targetStatus,
    }, actor, key);
    return {
      ticket: { ...ticket, status: targetStatus, updatedAt: now, lastError: null },
      orderVersion: savedOrder.version,
    };
  });
  socketService.emitToRestaurantPos(companyId, 'restaurant:ticket-updated', {
    ticketId,
    orderId: result.ticket.orderId,
    station: result.ticket.station,
    status: result.ticket.status,
    version: result.orderVersion,
  });
  if (targetStatus === 'ready') {
    socketService.emitToRestaurantPos(companyId, 'restaurant:ticket-ready', {
      ticketId,
      orderId: result.ticket.orderId,
      station: result.ticket.station,
      payload: result.ticket.payloadJson,
    });
  }
  return result.ticket;
}

async function retryTicket(companyIdValue, ticketIdValue, actorValue) {
  const companyId = requireCompany(companyIdValue);
  const ticketId = normalizeId(ticketIdValue, 'ticket');
  const actor = requireActor(actorValue);
  const ticket = await prisma.restaurantKitchenTicket.findFirst({
    where: { id: ticketId, companyId },
  });
  if (!ticket) throw fail('RESTAURANT_TICKET_NOT_FOUND', 'This ticket is not available in this company.', 404);
  if (!ACTIVE_TICKET_STATUSES.includes(ticket.status)) {
    throw fail('RESTAURANT_TICKET_STATUS_CONFLICT', 'Only an active ticket can be retried.', 409);
  }
  const displayOnline = socketService.hasRestaurantDisplay(companyId, ticket.station);
  const updated = await prisma.restaurantKitchenTicket.update({
    where: { id: ticket.id },
    data: {
      retryCount: { increment: 1 },
      lastError: displayOnline ? null : `${ticket.station === 'kitchen' ? 'Kitchen' : 'Bar'} display is offline. The ticket remains saved.`,
      updatedAt: new Date(),
    },
  });
  if (displayOnline) {
    socketService.emitToRestaurantStation(companyId, ticket.station, 'restaurant:ticket-new', {
      ticketId: ticket.id,
      orderId: ticket.orderId,
      station: ticket.station,
      retry: true,
    });
  }
  return {
    ticket: updated,
    displayOnline,
    message: displayOnline
      ? 'The saved ticket was sent to the station display again.'
      : 'The ticket remains saved. Connect the station display and retry.',
    requestedBy: actor.userId,
  };
}

async function voidSentItem(companyIdValue, orderIdValue, itemIdValue, body, actorValue, idempotencyKeyValue) {
  const companyId = requireCompany(companyIdValue);
  const orderId = normalizeId(orderIdValue, 'order');
  const itemId = normalizeId(itemIdValue, 'order item');
  const actor = requireActor(actorValue);
  const key = eventKey(idempotencyKeyValue);
  const reason = normalizeText(body?.reason, 'Void reason', 240, { required: true });
  const decision = String(body?.decision || '').trim().toLowerCase();
  if (!['waste', 'return'].includes(decision)) {
    throw fail('RESTAURANT_VOID_DECISION_REQUIRED', 'Choose whether the item was wasted or returned.');
  }
  const result = await prisma.$transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId);
    if (order.status !== OPEN_ORDER_STATUS) throw fail('RESTAURANT_ORDER_CLOSED', 'This order is no longer open.', 409);
    const snapshot = await findSnapshot(tx, companyId, order);
    const item = snapshot.items.find((line) => line.id === itemId);
    if (!item || item.status !== 'sent') throw fail('RESTAURANT_ORDER_ITEM_NOT_VOIDABLE', 'Only a sent, active item can be voided.', 409);
    const nextItem = { ...item, status: 'voided', voidReason: reason, voidDecision: decision, voidedById: actor.userId, voidedAt: new Date().toISOString() };
    const nextSnapshot = { ...snapshot, items: snapshot.items.map((line) => line.id === itemId ? nextItem : line) };
    const tickets = await tx.restaurantKitchenTicket.findMany({
      where: { companyId, orderId },
    });
    for (const ticket of tickets) {
      const payload = ticket.payloadJson && typeof ticket.payloadJson === 'object' ? ticket.payloadJson : {};
      if (!Array.isArray(payload.items) || !payload.items.some((line) => line.id === itemId)) continue;
      await tx.restaurantKitchenTicket.update({
        where: { id: ticket.id },
        data: {
          payloadJson: {
            ...payload,
            items: payload.items.map((line) => line.id === itemId
              ? { ...line, status: 'voided', voidReason: reason }
              : line),
          },
          updatedAt: new Date(),
        },
      });
    }
    const savedOrder = await writeOrderVersion(tx, order, nextSnapshot, 'SENT_ITEM_VOIDED', {
      itemId,
      reason,
      decision,
    }, actor, key);
    return { order: orderView(savedOrder, nextSnapshot), tickets };
  });
  socketService.emitToRestaurantPos(companyId, 'restaurant:order-updated', {
    orderId,
    version: result.order.version,
    change: 'item_voided',
  });
  for (const ticket of result.tickets) {
    if (ticket.station === 'kitchen' || ticket.station === 'bar') {
      socketService.emitToRestaurantStation(companyId, ticket.station, 'restaurant:ticket-updated', {
        ticketId: ticket.id,
        orderId,
        change: 'item_voided',
        itemId,
      });
    }
  }
  return result.order;
}

module.exports = {
  carryOpenOrdersForShiftHandover,
  claimBill,
  getOrder,
  getOverview,
  listShiftHandoverOrders,
  markBillPaid,
  listStationTickets,
  notifyHandoverOrders,
  openOrder,
  retryTicket,
  sendRound,
  updateTicketStatus,
  updateUnsentItems,
  voidSentItem,
};

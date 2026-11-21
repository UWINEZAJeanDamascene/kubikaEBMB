'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posRestaurantSetupService', () => ({ getSetup: jest.fn() }));
jest.mock('../services/socketService', () => ({
  emitToCompany: jest.fn(),
  emitToRestaurantPos: jest.fn(),
  emitToRestaurantStation: jest.fn(),
  hasRestaurantDisplay: jest.fn(() => false),
}));

const { prisma } = require('../lib/prisma');
const socketService = require('../services/socketService');
const setupService = require('../services/posRestaurantSetupService');
const orderService = require('../services/posRestaurantOrderService');

const COMPANY_ID = 'a'.repeat(24);
const REGISTER_ID = 'b'.repeat(24);
const USER_ID = 'c'.repeat(24);
const ORDER_ID = 'd'.repeat(24);
const TABLE_ID = 'e'.repeat(24);
const PRODUCT_ID = 'f'.repeat(24);
const MENU_ITEM_ID = '1'.repeat(24);
const TICKET_ID = '2'.repeat(24);

function createTransactionClient() {
  return {
    restaurantOrder: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantOrderEvent: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    restaurantKitchenTicket: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantTable: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantMenuItem: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    restaurantMenuCategory: { findMany: jest.fn() },
    restaurantMenuItemModifierGroup: { findMany: jest.fn() },
    restaurantModifierGroup: { findMany: jest.fn() },
    restaurantModifierOption: { findMany: jest.fn() },
  };
}

const actor = { userId: USER_ID, registerId: REGISTER_ID, name: 'Waiter', trainingMode: false };

describe('Restaurant order service', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = createTransactionClient();
    prisma.$transaction = jest.fn((callback) => callback(tx));
  });

  test('claims a free table atomically and records the opening snapshot', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue(null);
    tx.restaurantTable.findFirst.mockResolvedValue({ id: TABLE_ID, state: 'free', capacity: 4 });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantOrder.create.mockImplementation(({ data }) => Promise.resolve(data));

    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'dining',
      tableId: TABLE_ID,
      guestCount: 2,
    }, actor, 'restaurant-open-order-0001');

    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: 'free' },
      data: expect.objectContaining({ state: 'occupied', guestCount: 2 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        orderId: order.id,
        eventType: 'ORDER_OPENED',
        payloadJson: expect.objectContaining({ snapshot: { items: [], rounds: [], trainingMode: false } }),
      }),
    }));
  });

  test('persists counter orders using the database quick-sale kind', async () => {
    tx.restaurantOrder.create.mockImplementation(({ data }) => Promise.resolve(data));

    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'counter',
    }, actor, 'restaurant-counter-order-0001');

    expect(tx.restaurantOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orderKind: 'quick_sale', tableId: null }),
    }));
    expect(order.orderKind).toBe('quick_sale');
  });

  test('rejects stale order versions before validating or writing lines', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      status: 'open',
      version: 3,
    });

    await expect(orderService.updateUnsentItems(COMPANY_ID, ORDER_ID, {
      expectedVersion: 2,
      items: [],
    }, actor, 'restaurant-update-items-0001')).rejects.toMatchObject({
      code: 'RESTAURANT_ORDER_VERSION_CONFLICT',
      statusCode: 409,
    });
    expect(tx.restaurantOrderEvent.findFirst).not.toHaveBeenCalled();
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
  });

  test('routes a mixed round into separate price-free Kitchen and Bar tickets', async () => {
    const order = {
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: null,
      status: 'open',
      version: 1,
      guestCount: 1,
      openedById: USER_ID,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'quick_sale',
      tabName: null,
    };
    tx.restaurantOrder.findFirst.mockResolvedValue(order);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [
            { id: '3'.repeat(24), productId: PRODUCT_ID, name: 'Soup', quantity: 1, unitPrice: '5.00', station: 'kitchen', modifiers: [], note: '', status: 'unsent', roundNumber: null },
            { id: '4'.repeat(24), productId: '5'.repeat(24), name: 'Juice', quantity: 2, unitPrice: '3.00', station: 'bar', modifiers: [], note: 'No ice', status: 'unsent', roundNumber: null },
          ],
        },
      },
    });
    tx.restaurantKitchenTicket.create.mockImplementation(({ data }) => Promise.resolve(data));
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.sendRound(COMPANY_ID, ORDER_ID, { expectedVersion: 1 }, actor, 'restaurant-round-send-0001');

    expect(result.tickets.map((ticket) => ticket.station).sort()).toEqual(['bar', 'kitchen']);
    expect(result.tickets.find((ticket) => ticket.station === 'kitchen').payloadJson.items.map((item) => item.name)).toEqual(['Soup']);
    expect(result.tickets.find((ticket) => ticket.station === 'bar').payloadJson.items.map((item) => item.name)).toEqual(['Juice']);
    for (const ticket of result.tickets) {
      expect(ticket.payloadJson.items[0]).not.toHaveProperty('unitPrice');
      expect(ticket.lastError).toContain('display is offline');
    }
    expect(tx.restaurantKitchenTicket.create).toHaveBeenCalledTimes(2);
    expect(socketService.emitToRestaurantStation).toHaveBeenCalledTimes(2);
  });

  test('marks a station ticket ready independently and accepts waiter pickup acknowledgement', async () => {
    tx.restaurantKitchenTicket.findFirst
      .mockResolvedValueOnce({
        id: TICKET_ID,
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        station: 'bar',
        status: 'preparing',
        payloadJson: { tableName: 'Patio 2', items: [{ name: 'Juice' }] },
      })
      .mockResolvedValueOnce({
        id: TICKET_ID,
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        station: 'bar',
        status: 'ready',
        payloadJson: { tableName: 'Patio 2', items: [{ name: 'Juice' }] },
      });
    tx.restaurantOrder.findFirst
      .mockResolvedValueOnce({
        id: ORDER_ID,
        companyId: COMPANY_ID,
        status: 'open',
        version: 2,
      })
      .mockResolvedValueOnce({
        id: ORDER_ID,
        companyId: COMPANY_ID,
        status: 'open',
        version: 3,
      });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: false } },
    });
    tx.restaurantKitchenTicket.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const ticket = await orderService.updateTicketStatus(
      COMPANY_ID,
      TICKET_ID,
      { status: 'ready' },
      actor,
      'restaurant-ticket-ready-0001',
    );

    expect(ticket.status).toBe('ready');
    expect(socketService.emitToRestaurantPos).toHaveBeenCalledWith(COMPANY_ID, 'restaurant:ticket-ready', expect.objectContaining({
      ticketId: TICKET_ID,
      station: 'bar',
    }));

    const pickedUp = await orderService.updateTicketStatus(
      COMPANY_ID,
      TICKET_ID,
      { status: 'picked_up' },
      actor,
      'restaurant-ticket-picked-up-0001',
    );

    expect(pickedUp.status).toBe('picked_up');
    expect(tx.restaurantKitchenTicket.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: TICKET_ID, companyId: COMPANY_ID, status: 'ready' },
      data: expect.objectContaining({ status: 'picked_up' }),
    }));
    expect(socketService.emitToRestaurantPos).toHaveBeenCalledTimes(3);
  });

  test('marks a billed order paid and releases its table using the billed state guard', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'billed',
      version: 3,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{ id: '3'.repeat(24), status: 'sent' }],
        },
      },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });

    const paid = await orderService.markBillPaid(
      tx,
      COMPANY_ID,
      ORDER_ID,
      actor,
      'restaurant-bill-paid-order-0001',
    );

    expect(tx.restaurantOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'billed', version: 3 }),
      data: expect.objectContaining({ status: 'paid', version: 4 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'BILL_PAID', version: 4 }),
    }));
    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: { in: ['bill_printed', 'occupied'] } },
      data: expect.objectContaining({ state: 'free', guestCount: 0 }),
    }));
    expect(paid.status).toBe('paid');
  });

  test('carries open orders to the incoming cashier as a versioned tab event', async () => {
    tx.restaurantOrder.findMany.mockResolvedValue([{
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'open',
      version: 2,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    }]);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{ id: '3'.repeat(24), status: 'sent', quantity: 2 }],
        },
      },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.carryOpenOrdersForShiftHandover(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: '4'.repeat(24),
      shiftId: '5'.repeat(24),
    });

    expect(result.orders).toHaveLength(1);
    expect(tx.restaurantOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'open', version: 2 }),
      data: expect.objectContaining({ waiterId: '4'.repeat(24), version: 3 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'TAB_CARRIED',
        version: 3,
        payloadJson: expect.objectContaining({
          handover: expect.objectContaining({ fromUserId: USER_ID, toUserId: '4'.repeat(24) }),
        }),
      }),
    }));
  });

  test('blocks carrying an issued unpaid bill to a different cashier', async () => {
    tx.restaurantOrder.findMany.mockResolvedValue([{
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'billed',
      version: 2,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    }]);
    tx.restaurantOrderEvent.findMany.mockResolvedValue([]);
    tx.restaurantTable.findMany.mockResolvedValue([]);

    const result = await orderService.carryOpenOrdersForShiftHandover(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: '4'.repeat(24),
      shiftId: '5'.repeat(24),
    });

    expect(result.code).toBe('RESTAURANT_OPEN_BILLED_ORDERS_BLOCKED');
    expect(result.blockedOrders).toMatchObject([{ id: ORDER_ID, status: 'billed' }]);
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.restaurantOrderEvent.create).not.toHaveBeenCalled();
  });
});

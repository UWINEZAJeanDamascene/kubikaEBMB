'use strict';

jest.mock('../middleware/posAuthMiddleware', () => ({
  resolvePosSession: jest.fn(),
  hasPosPermission: jest.fn(),
}));
jest.mock('../src/config/environment', () => ({
  getConfig: () => ({
    jwt: { secret: 'test-secret' },
    server: { corsOrigins: [] },
    env: { isProduction: false },
  }),
}));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('socket.io', () => ({
  Server: function FakeSocketServer() {
    return global.__restaurantFakeIo;
  },
}));

const { resolvePosSession, hasPosPermission } = require('../middleware/posAuthMiddleware');
const socketService = require('../services/socketService');

const COMPANY_ID = 'company-1';

function fakeSocket() {
  const handlers = new Map();
  const socket = {
    id: 'socket-1',
    connected: true,
    user: { id: 'erp-user-1', companyId: COMPANY_ID },
    join: jest.fn(),
    leave: jest.fn(),
    on: jest.fn((event, handler) => handlers.set(event, handler)),
  };
  return { socket, handlers };
}

function setupSocketServer() {
  const handlers = new Map();
  const fakeIo = {
    use: jest.fn(),
    on: jest.fn((event, handler) => handlers.set(event, handler)),
    to: jest.fn(() => ({ emit: jest.fn() })),
    sockets: { sockets: new Map() },
  };
  global.__restaurantFakeIo = fakeIo;
  socketService.init({});
  return { fakeIo, handlers };
}

function authorizedContext() {
  return {
    claims: { exp: Math.floor(Date.now() / 1000) + 3600 },
    company: { id: COMPANY_ID },
    user: { id: 'pos-user-1' },
    settings: { posRolePermissions: {} },
  };
}

describe('Restaurant socket authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('joins the POS and station rooms only after validating the POS session and permission', async () => {
    resolvePosSession.mockResolvedValue(authorizedContext());
    hasPosPermission.mockResolvedValue(true);
    const { fakeIo, handlers: ioHandlers } = setupSocketServer();
    const { socket, handlers } = fakeSocket();
    fakeIo.sockets.sockets.set(socket.id, socket);
    ioHandlers.get('connection')(socket);

    const acknowledge = jest.fn();
    await handlers.get('restaurant:display:join')({
      station: 'kitchen',
      sessionToken: 'pos-session-token',
      deviceToken: 'paired-device-token',
    }, acknowledge);

    expect(resolvePosSession).toHaveBeenCalledWith(expect.objectContaining({
      headers: {
        'x-pos-session': 'pos-session-token',
        'x-device-token': 'paired-device-token',
      },
    }));
    expect(hasPosPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pos-user-1' }),
      COMPANY_ID,
      {},
      'pos.till.sell',
    );
    expect(socket.join).toHaveBeenCalledWith(`restaurant_pos_${COMPANY_ID}`);
    expect(socket.join).toHaveBeenCalledWith(`restaurant_display_${COMPANY_ID}:kitchen`);
    expect(acknowledge).toHaveBeenCalledWith({ success: true, station: 'kitchen' });

    handlers.get('disconnect')();
  });

  test('rejects a station join when the POS role lacks order access', async () => {
    resolvePosSession.mockResolvedValue(authorizedContext());
    hasPosPermission.mockResolvedValue(false);
    const { fakeIo, handlers: ioHandlers } = setupSocketServer();
    const { socket, handlers } = fakeSocket();
    fakeIo.sockets.sockets.set(socket.id, socket);
    ioHandlers.get('connection')(socket);

    const acknowledge = jest.fn();
    await handlers.get('restaurant:display:join')({
      station: 'bar',
      sessionToken: 'pos-session-token',
      deviceToken: 'paired-device-token',
    }, acknowledge);

    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(socket.join).not.toHaveBeenCalledWith(`restaurant_pos_${COMPANY_ID}`);
    expect(socket.join).not.toHaveBeenCalledWith(`restaurant_display_${COMPANY_ID}:bar`);
    expect(socket.leave).not.toHaveBeenCalled();
  });

  test('scopes Restaurant rooms to the validated POS session company', async () => {
    const posCompanyId = 'another-company';
    resolvePosSession.mockResolvedValue({
      ...authorizedContext(),
      company: { id: posCompanyId },
    });
    hasPosPermission.mockResolvedValue(true);
    const { fakeIo, handlers: ioHandlers } = setupSocketServer();
    const { socket, handlers } = fakeSocket();
    fakeIo.sockets.sockets.set(socket.id, socket);
    ioHandlers.get('connection')(socket);

    const acknowledge = jest.fn();
    await handlers.get('restaurant:display:join')({
      station: 'kitchen',
      sessionToken: 'pos-session-token',
      deviceToken: 'paired-device-token',
    }, acknowledge);

    expect(acknowledge).toHaveBeenCalledWith({ success: true, station: 'kitchen' });
    expect(socket.join).toHaveBeenCalledWith(`restaurant_pos_${posCompanyId}`);
    expect(socket.join).toHaveBeenCalledWith(`restaurant_display_${posCompanyId}:kitchen`);
    handlers.get('disconnect')();
  });
});

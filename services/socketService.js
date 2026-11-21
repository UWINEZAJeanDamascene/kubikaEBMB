const jwt = require('jsonwebtoken');
const { resolvePosSession, hasPosPermission } = require('../middleware/posAuthMiddleware');
let io = null;
const restaurantDisplays = new Map();
const displayMembership = new Map();
const restaurantPosMembership = new Map();

function restaurantDisplayKey(companyId, station) {
  return `${String(companyId)}:${String(station)}`;
}

function removeRestaurantDisplay(socketId) {
  const membership = displayMembership.get(socketId);
  if (!membership) return;
  displayMembership.delete(socketId);
  const key = restaurantDisplayKey(membership.companyId, membership.station);
  const sockets = restaurantDisplays.get(key);
  if (!sockets) return;
  sockets.delete(socketId);
  if (!sockets.size) {
    restaurantDisplays.delete(key);
    emitToRestaurantPos(membership.companyId, 'restaurant:display-status', {
      station: membership.station,
      online: false,
    });
  }
}

function removeRestaurantPosAccess(socketId) {
  const membership = restaurantPosMembership.get(socketId);
  if (!membership) return;
  removeRestaurantDisplay(socketId);
  restaurantPosMembership.delete(socketId);
  clearTimeout(membership.expiryTimer);
  const socket = io?.sockets?.sockets?.get(socketId);
  socket?.leave(`restaurant_pos_${membership.companyId}`);
}

async function authorizeRestaurantSocket(socket, payload) {
  const sessionToken = String(payload?.sessionToken || '').trim();
  const deviceToken = String(payload?.deviceToken || '').trim();
  if (!String(socket.user?.id || '') || !sessionToken || !deviceToken) {
    return { authorized: false, message: 'An active Restaurant POS session is required.' };
  }

  const headers = {
    'x-pos-session': sessionToken,
    'x-device-token': deviceToken,
  };
  const request = {
    headers,
    get: (name) => headers[String(name || '').toLowerCase()],
  };
  const context = await resolvePosSession(request);
  if (context.error || !context.company?.id) {
    return { authorized: false, message: 'An active Restaurant POS session is required.' };
  }
  const allowed = await hasPosPermission(
    context.user,
    context.company.id,
    context.settings?.posRolePermissions,
    'pos.till.sell',
  );
  if (!allowed) {
    return { authorized: false, message: 'Your POS role does not allow Restaurant orders.' };
  }
  return { authorized: true, context };
}

async function registerRestaurantPosAccess(socket, context) {
  removeRestaurantPosAccess(socket.id);
  const companyId = String(context.company.id);
  const expiry = Number(context.claims?.exp) * 1000;
  const expiryTimer = setTimeout(
    () => removeRestaurantPosAccess(socket.id),
    Math.max(0, expiry - Date.now()),
  );
  expiryTimer.unref?.();
  restaurantPosMembership.set(socket.id, { companyId, expiryTimer });
  await socket.join(`restaurant_pos_${companyId}`);
}

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const JWT_SECRET = config.jwt.secret;
const CORS_ORIGINS = config.server.corsOrigins;

const init = (server, options = {}) => {
  const { Server } = require('socket.io');
  
  // For socket.io, when credentials: true, we cannot use '*'
  // Must use explicit origins array or a function
  const corsOrigins = CORS_ORIGINS && CORS_ORIGINS.length > 0
    ? CORS_ORIGINS
    : config.env.isProduction ? [] : ['http://localhost:3000', 'http://localhost:5173'];
  
  io = new Server(server, {
    cors: {
      origin: corsOrigins,
      credentials: true
    },
    ...options
  });

  // Authenticate sockets using JWT token provided in handshake.auth.token
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication error'));
      const payload = jwt.verify(token, JWT_SECRET);
      socket.user = { id: payload.id || payload._id, companyId: payload.companyId };
      return next();
    } catch (err) {
      return next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    try {
      const uid = socket.user && socket.user.id;
      if (uid) {
        const room = `user_${uid}`;
        socket.join(room);
      }
      // Tenant-wide room: lets a write from one user's tab invalidate every
      // other connected user's React Query cache for the same company,
      // instead of only the acting user's own tabs.
      const companyId = socket.user && socket.user.companyId;
      if (companyId) {
        socket.join(`company_${companyId}`);
      }

      socket.on('restaurant:pos:join', async (payload, acknowledge) => {
        try {
          const access = await authorizeRestaurantSocket(socket, payload);
          if (!access.authorized || !socket.connected) {
            removeRestaurantPosAccess(socket.id);
            if (typeof acknowledge === 'function') {
              acknowledge({ success: false, message: access.message || 'Restaurant POS access is no longer active.' });
            }
            return;
          }
          await registerRestaurantPosAccess(socket, access.context);
          if (typeof acknowledge === 'function') acknowledge({ success: true });
        } catch (error) {
          removeRestaurantPosAccess(socket.id);
          console.error('Could not authorize Restaurant POS socket access:', error);
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'Could not verify Restaurant POS access.' });
          }
        }
      });

      socket.on('restaurant:pos:leave', () => removeRestaurantPosAccess(socket.id));

      socket.on('restaurant:display:join', async (payload, acknowledge) => {
        const station = String(payload?.station || '').trim().toLowerCase();
        if (!['kitchen', 'bar'].includes(station)) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'Choose Kitchen or Bar.' });
          }
          return;
        }
        try {
          const access = await authorizeRestaurantSocket(socket, payload);
          if (!access.authorized || !socket.connected) {
            removeRestaurantPosAccess(socket.id);
            if (typeof acknowledge === 'function') {
              acknowledge({ success: false, message: access.message || 'Restaurant POS access is no longer active.' });
            }
            return;
          }
          await registerRestaurantPosAccess(socket, access.context);
          removeRestaurantDisplay(socket.id);
          const authorizedCompanyId = String(access.context.company.id);
          const key = restaurantDisplayKey(authorizedCompanyId, station);
          const sockets = restaurantDisplays.get(key) || new Set();
          sockets.add(socket.id);
          restaurantDisplays.set(key, sockets);
          displayMembership.set(socket.id, { companyId: authorizedCompanyId, station });
          await socket.join(`restaurant_display_${key}`);
          if (typeof acknowledge === 'function') acknowledge({ success: true, station });
          emitToRestaurantPos(authorizedCompanyId, 'restaurant:display-status', { station, online: true });
        } catch (error) {
          removeRestaurantPosAccess(socket.id);
          console.error('Could not authorize Restaurant station display:', error);
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'Could not verify Restaurant POS access.' });
          }
        }
      });

      socket.on('restaurant:display:leave', () => removeRestaurantPosAccess(socket.id));
      socket.on('disconnect', () => {
        removeRestaurantPosAccess(socket.id);
      });
    } catch (err) {
      // ignore
    }
  });

  console.log('Socket.io initialized');
};

const emitToUser = (userId, event, payload) => {
  if (!io) return;
  try {
    const room = `user_${userId}`;
    io.to(room).emit(event, payload);
  } catch (err) {
    console.error('Failed to emit socket event', err);
  }
};

/** Broadcast to every connected session for a tenant (cross-user signal). */
const emitToCompany = (companyId, event, payload) => {
  if (!io || !companyId) return;
  try {
    const room = `company_${companyId}`;
    io.to(room).emit(event, payload);
  } catch (err) {
    console.error('Failed to emit company socket event', err);
  }
};

const emitToRestaurantStation = (companyId, station, event, payload) => {
  if (!io || !companyId || !['kitchen', 'bar'].includes(String(station))) return;
  try {
    io.to(`restaurant_display_${restaurantDisplayKey(companyId, station)}`).emit(event, payload);
  } catch (err) {
    console.error('Failed to emit Restaurant station event', err);
  }
};

const emitToRestaurantPos = (companyId, event, payload) => {
  if (!io || !companyId) return;
  try {
    io.to(`restaurant_pos_${companyId}`).emit(event, payload);
  } catch (err) {
    console.error('Failed to emit Restaurant POS event', err);
  }
};

const hasRestaurantDisplay = (companyId, station) => {
  if (!companyId || !['kitchen', 'bar'].includes(String(station))) return false;
  return Boolean(restaurantDisplays.get(restaurantDisplayKey(companyId, station))?.size);
};

const getIo = () => io;

module.exports = {
  emitToCompany,
  emitToRestaurantPos,
  emitToRestaurantStation,
  emitToUser,
  getIo,
  hasRestaurantDisplay,
  init,
  authorizeRestaurantSocket,
};

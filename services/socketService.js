const jwt = require('jsonwebtoken');
let io = null;

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

      socket.on('disconnect', () => {
        // clean up if needed
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

const getIo = () => io;

module.exports = { init, emitToUser, emitToCompany, getIo };

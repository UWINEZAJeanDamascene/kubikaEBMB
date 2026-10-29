const { redisClient } = require('../config/redis');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();

// Session configuration (SESSION_TTL = Redis session + token mapping TTL in seconds)
const SESSION_TTL = config.session.ttl; // 24 hours default
// Max concurrent access tokens per user (Redis FIFO eviction of oldest). Default 5 devices.
// Set SESSION_MAX_CONCURRENT=0 for unlimited (not recommended in production).
const SESSION_MAX_CONCURRENT = config.session.maxConcurrent;
const SESSION_PREFIX = 'session:';
const TOKEN_BLACKLIST_PREFIX = 'blacklist:';
const TOKENS_LIST_SUFFIX = 'tokens:';

function tokenBlacklistTtlSeconds(token) {
  try {
    const dec = jwt.decode(token);
    if (dec && typeof dec.exp === 'number') {
      const left = dec.exp - Math.floor(Date.now() / 1000);
      return Math.max(1, left);
    }
  } catch (_) {
    /* ignore */
  }
  return SESSION_TTL;
}

// Session data structure
class SessionService {
  _tokensListKey(userId) {
    return `${SESSION_PREFIX}${TOKENS_LIST_SUFFIX}${userId}`;
  }

  _deviceSessionKey(userId, token) {
    const tokenId = crypto.createHash('sha256').update(String(token)).digest('hex');
    return `${SESSION_PREFIX}device:${userId}:${tokenId}`;
  }

  _refreshSessionKey(userId, sessionId) {
    return `${SESSION_PREFIX}refresh:${userId}:${sessionId}`;
  }

  async storeRefreshTokenForSession(userId, sessionId, token) {
    if (!userId || !sessionId || !token) return false;
    const decoded = jwt.decode(token);
    const ttl = decoded?.exp ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : SESSION_TTL;
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    await redisClient.setex(this._refreshSessionKey(userId, sessionId), ttl, hash);
    return true;
  }

  async getRefreshTokenHashForSession(userId, sessionId) {
    if (!userId || !sessionId) return null;
    return redisClient.get(this._refreshSessionKey(userId, sessionId));
  }

  async deleteRefreshTokenForSession(userId, sessionId) {
    if (!userId || !sessionId) return false;
    await redisClient.del(this._refreshSessionKey(userId, sessionId));
    return true;
  }

  /**
   * Enforce max concurrent access tokens per user (FIFO eviction of oldest).
   */
  async _registerAccessTokenForConcurrency(userId, token) {
    const listKey = this._tokensListKey(userId);
    await redisClient.rpush(listKey, token);
    await redisClient.expire(listKey, SESSION_TTL);

    // Keep the token index even when concurrency limits are disabled; it is
    // also the source for the user's device/session list and per-device revoke.
    if (!SESSION_MAX_CONCURRENT || SESSION_MAX_CONCURRENT < 1) return;

    const currentSessionId = jwt.decode(token)?.sid || null;
    while (true) {
      const indexed = await redisClient.lrange(listKey, 0, -1);
      const families = [];
      for (const indexedToken of indexed || []) {
        const decoded = jwt.decode(indexedToken);
        const familyId = decoded?.sid || crypto.createHash('sha256').update(String(indexedToken)).digest('hex');
        if (!families.includes(familyId)) families.push(familyId);
      }
      if (families.length <= SESSION_MAX_CONCURRENT) break;
      const evictedFamily = families.find((familyId) => familyId !== currentSessionId);
      if (!evictedFamily) break;
      const familyTokens = (indexed || []).filter((indexedToken) => {
        const decoded = jwt.decode(indexedToken);
        const familyId = decoded?.sid || crypto.createHash('sha256').update(String(indexedToken)).digest('hex');
        return familyId === evictedFamily;
      });
      for (const oldToken of familyTokens) {
        const blacklisted = await this.blacklistToken(oldToken, tokenBlacklistTtlSeconds(oldToken));
        if (!blacklisted) throw new Error('Could not revoke an evicted session token');
        await redisClient.del(`${SESSION_PREFIX}token:${oldToken}`, this._deviceSessionKey(userId, oldToken));
        await redisClient.lrem(listKey, 0, oldToken);
      }
      if (familyTokens.length && jwt.decode(familyTokens[0])?.sid) {
        await this.deleteRefreshTokenForSession(userId, jwt.decode(familyTokens[0]).sid);
      }
    }
  }

  /**
   * Map an access token to userId in Redis and apply concurrent-session rules.
   * Use after refresh when the session blob already exists.
   */
  async registerAccessToken(userId, token) {
    const tokenKey = `${SESSION_PREFIX}token:${token}`;
    try {
      await redisClient.setex(tokenKey, SESSION_TTL, userId);
      await this._registerAccessTokenForConcurrency(userId, token);
      const current = await redisClient.get(`${SESSION_PREFIX}${userId}`);
      const parsed = current ? JSON.parse(current) : {};
      const decoded = jwt.decode(token);
      let deviceMetadata = null;
      if (decoded?.sid) {
        const indexedTokens = await redisClient.lrange(this._tokensListKey(userId), 0, -1);
        for (const priorToken of [...new Set(indexedTokens || [])]) {
          if (priorToken === token || String(jwt.decode(priorToken)?.sid || '') !== String(decoded.sid)) continue;
          const priorRaw = await redisClient.get(this._deviceSessionKey(userId, priorToken));
          try {
            const prior = priorRaw ? JSON.parse(priorRaw) : null;
            if (prior) {
              deviceMetadata = prior;
              break;
            }
          } catch (_) { /* ignore stale metadata */ }
        }
      }
      await redisClient.setex(this._deviceSessionKey(userId, token), SESSION_TTL, JSON.stringify({
        userId: String(userId),
        companyId: deviceMetadata?.companyId || parsed.companyId || null,
        role: deviceMetadata?.role || parsed.role || null,
        email: deviceMetadata?.email || parsed.email || null,
        name: deviceMetadata?.name || parsed.name || null,
        userAgent: deviceMetadata?.userAgent || parsed.userAgent || null,
        ipAddress: deviceMetadata?.ipAddress || parsed.ipAddress || null,
        createdAt: deviceMetadata?.createdAt || (decoded?.iat ? new Date(decoded.iat * 1000).toISOString() : new Date().toISOString()),
        lastActivity: new Date().toISOString(),
        sessionId: decoded?.sid || null,
      }));
    } catch (error) {
      console.error('Error registering access token:', error);
      throw error;
    }
  }

  /**
   * Create a new session for a user
   * @param {string} userId - User ID
   * @param {string} companyId - Company ID
   * @param {string} role - User role
   * @param {string} token - JWT token
   * @param {Object} additionalData - Additional session data
   */
  async createSession(userId, companyId, role, token, additionalData = {}) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    const sessionData = {
      userId,
      companyId,
      role,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      ...additionalData,
    };

    try {
      // Store session data
      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(sessionData));

      // Store token-to-user mapping for quick lookup
      const tokenKey = `${SESSION_PREFIX}token:${token}`;
      await redisClient.setex(tokenKey, SESSION_TTL, userId);
      await this._registerAccessTokenForConcurrency(userId, token);
      await redisClient.setex(this._deviceSessionKey(userId, token), SESSION_TTL, JSON.stringify({
        ...sessionData,
        userAgent: additionalData.userAgent || null,
        ipAddress: additionalData.ipAddress || null,
        sessionId: jwt.decode(token)?.sid || null,
      }));

      console.log(`Session created for user: ${userId}`);
      return sessionData;
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }

  /**
   * Get session data by user ID
   * @param {string} userId - User ID
   */
  async getSession(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      const sessionData = await redisClient.get(sessionKey);
      if (!sessionData) {
        return null;
      }

      const parsed = JSON.parse(sessionData);
      // Update last activity
      parsed.lastActivity = new Date().toISOString();
      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(parsed));

      return parsed;
    } catch (error) {
      console.error('Error getting session:', error);
      return null;
    }
  }

  /**
   * Get user by token (quick lookup)
   * @param {string} token - JWT token
   */
  async getUserByToken(token) {
    const tokenKey = `${SESSION_PREFIX}token:${token}`;

    try {
      const userId = await redisClient.get(tokenKey);
      if (!userId) {
        return null;
      }

      return await this.getSession(userId);
    } catch (error) {
      console.error('Error getting user by token:', error);
      return null;
    }
  }

  /**
   * Update session data
   * @param {string} userId - User ID
   * @param {Object} data - Data to update
   */
  async updateSession(userId, data) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      const currentSession = await this.getSession(userId);
      if (!currentSession) {
        return null;
      }

      const updatedSession = {
        ...currentSession,
        ...data,
        lastActivity: new Date().toISOString(),
      };

      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(updatedSession));
      return updatedSession;
    } catch (error) {
      console.error('Error updating session:', error);
      throw error;
    }
  }

  async touchDeviceSession(userId, token) {
    if (!userId || !token) return false;
    const key = this._deviceSessionKey(userId, token);
    try {
      const raw = await redisClient.get(key);
      if (!raw) return false;
      const metadata = JSON.parse(raw);
      metadata.lastActivity = new Date().toISOString();
      await redisClient.setex(key, SESSION_TTL, JSON.stringify(metadata));
      return true;
    } catch (error) {
      console.error('Could not update device session activity:', error.message || error);
      return false;
    }
  }

  /**
   * Delete a session (logout)
   * @param {string} userId - User ID
   * @param {string} token - JWT token
   */
  async deleteSession(userId, token = null) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    const listKey = this._tokensListKey(userId);

    try {
      // Delete token mapping if provided
      if (token) {
        const tokenKey = `${SESSION_PREFIX}token:${token}`;
        const metadataRaw = await redisClient.get(this._deviceSessionKey(userId, token));
        let metadata = {};
        try { metadata = metadataRaw ? JSON.parse(metadataRaw) : {}; } catch (_) { metadata = {}; }
        const sessionId = metadata.sessionId || jwt.decode(token)?.sid;
        await redisClient.del(tokenKey);
        await redisClient.del(this._deviceSessionKey(userId, token));
        if (sessionId) await this.deleteRefreshTokenForSession(userId, sessionId);
        await redisClient.lrem(listKey, 1, token);
        if (!(await redisClient.llen(listKey))) await redisClient.del(sessionKey);
      } else {
        await redisClient.del(sessionKey);
      }

      console.log(`Session deleted for user: ${userId}`);
      return true;
    } catch (error) {
      console.error('Error deleting session:', error);
      return false;
    }
  }

  /**
   * Delete all sessions for a user (force logout from all devices)
   * @param {string} userId - User ID
   */
  async deleteAllSessions(userId) {
    const listKey = this._tokensListKey(userId);
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      const tokens = await redisClient.lrange(listKey, 0, -1);
      if (tokens && tokens.length) {
        for (const t of tokens) {
          await redisClient.del(`${SESSION_PREFIX}token:${t}`);
          const metadataRaw = await redisClient.get(this._deviceSessionKey(userId, t));
          try {
            const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
            const sessionId = metadata?.sessionId || jwt.decode(t)?.sid;
            if (sessionId) await this.deleteRefreshTokenForSession(userId, sessionId);
          } catch (_) { /* keep revocation of the access token moving */ }
          await redisClient.del(this._deviceSessionKey(userId, t));
          await this.blacklistToken(t, tokenBlacklistTtlSeconds(t));
        }
      }
      await redisClient.del(listKey);
      await redisClient.del(sessionKey);

      console.log(`All sessions deleted for user: ${userId}`);
      return true;
    } catch (error) {
      console.error('Error deleting all sessions:', error);
      return false;
    }
  }

  async deleteOtherSessions(userId, currentToken) {
    const listKey = this._tokensListKey(userId);
    const tokens = await redisClient.lrange(listKey, 0, -1);
    const keep = String(currentToken || '');
    const keepSessionId = keep ? String(jwt.decode(keep)?.sid || '') : '';
    for (const token of [...new Set(tokens || [])]) {
      if (token === keep || (keepSessionId && String(jwt.decode(token)?.sid || '') === keepSessionId)) continue;
      const mappedUserId = await redisClient.get(`${SESSION_PREFIX}token:${token}`);
      if (String(mappedUserId || '') !== String(userId)) continue;
      const blacklisted = await this.blacklistToken(token, tokenBlacklistTtlSeconds(token));
      if (!blacklisted) throw new Error('Could not revoke a session token');
      const metadataRaw = await redisClient.get(this._deviceSessionKey(userId, token));
      try {
        const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
        const sessionId = metadata?.sessionId || jwt.decode(token)?.sid;
        if (sessionId) await this.deleteRefreshTokenForSession(userId, sessionId);
      } catch (_) { /* continue removing the access token */ }
      await redisClient.del(`${SESSION_PREFIX}token:${token}`, this._deviceSessionKey(userId, token));
      await redisClient.lrem(listKey, 0, token);
    }
    if (keep && tokens?.includes(keep)) {
      await redisClient.expire(listKey, SESSION_TTL);
      return true;
    }
    if (!(await redisClient.llen(listKey))) await redisClient.del(`${SESSION_PREFIX}${userId}`);
    return true;
  }

  /**
   * Check if session exists
   * @param {string} userId - User ID
   */
  async hasSession(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      const exists = await redisClient.exists(sessionKey);
      return exists === 1;
    } catch (error) {
      console.error('Error checking session:', error);
      return false;
    }
  }

  /**
   * Get session TTL remaining
   * @param {string} userId - User ID
   */
  async getSessionTTL(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      return await redisClient.ttl(sessionKey);
    } catch (error) {
      console.error('Error getting session TTL:', error);
      return 0;
    }
  }

  /**
   * Extend session TTL
   * @param {string} userId - User ID
   * @param {number} additionalTime - Additional time in seconds
   */
  async extendSession(userId, additionalTime = SESSION_TTL) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      await redisClient.expire(sessionKey, additionalTime);
      return true;
    } catch (error) {
      console.error('Error extending session:', error);
      return false;
    }
  }

  /**
   * Get all active sessions count (for admin)
   */
  async getActiveSessionsCount() {
    try {
      // Use SCAN to avoid blocking Redis with KEYS
      const pattern = `${SESSION_PREFIX}*`;
      let cursor = '0';
      let count = 0;
      do {
        const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        if (Array.isArray(reply)) {
          cursor = reply[0];
          const keys = reply[1] || [];
          const sessionKeys = keys.filter(k => !k.includes('token:') && !k.includes('tokens:') && !k.includes('device:') && !k.includes('refresh:'));
          count += sessionKeys.length;
        } else if (reply && reply.cursor !== undefined) {
          cursor = reply.cursor;
          const keys = reply.keys || [];
          const sessionKeys = keys.filter(k => !k.includes('token:') && !k.includes('tokens:') && !k.includes('device:') && !k.includes('refresh:'));
          count += sessionKeys.length;
        } else {
          break;
        }
      } while (cursor !== '0');

      return count;
    } catch (error) {
      console.error('Error getting active sessions count:', error);
      return 0;
    }
  }

  /**
   * Get all active sessions for a specific user
   * @param {string} userId - User ID
   */
  async getUserSessions(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    const listKey = this._tokensListKey(userId);
    
    try {
      // Get main session data
      const sessionData = await redisClient.get(sessionKey);
      const tokens = await redisClient.lrange(listKey, 0, -1);
      
      const session = sessionData ? JSON.parse(sessionData) : null;
      
      // Get TTL for session
      const ttl = await redisClient.ttl(sessionKey);
      
      const sessionsById = new Map();
      for (const token of [...new Set(tokens || [])]) {
        const mappedUserId = await redisClient.get(`${SESSION_PREFIX}token:${token}`);
        const decoded = jwt.decode(token);
        if (String(mappedUserId || '') !== String(userId) || !decoded || (decoded.exp && decoded.exp <= Math.floor(Date.now() / 1000)) || await this.isTokenBlacklisted(token)) continue;
        const tokenId = crypto.createHash('sha256').update(String(token)).digest('hex');
        const metadataRaw = await redisClient.get(this._deviceSessionKey(userId, token));
        let metadata = {};
        try { metadata = metadataRaw ? JSON.parse(metadataRaw) : {}; } catch { metadata = {}; }
        const tokenTtl = await redisClient.ttl(`${SESSION_PREFIX}token:${token}`);
        const stableSessionId = metadata.sessionId || decoded.sid || tokenId;
        const candidate = {
          id: stableSessionId,
          sessionId: decoded.sid || metadata.sessionId || null,
          role: metadata.role || decoded.memberships?.[0]?.role || null,
          companyId: metadata.companyId || decoded.memberships?.[0]?.companyId || null,
          name: metadata.name || null,
          userAgent: metadata.userAgent || null,
          ipAddress: metadata.ipAddress || null,
          createdAt: metadata.createdAt || (decoded.iat ? new Date(decoded.iat * 1000).toISOString() : null),
          lastActivity: metadata.lastActivity || null,
          ttlSeconds: tokenTtl > 0 ? tokenTtl : (decoded.exp ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)) : 0),
        };
        const existing = sessionsById.get(stableSessionId);
        if (!existing) sessionsById.set(stableSessionId, candidate);
        else {
          if (!existing.userAgent && candidate.userAgent) existing.userAgent = candidate.userAgent;
          if (!existing.ipAddress && candidate.ipAddress) existing.ipAddress = candidate.ipAddress;
          if (candidate.createdAt && (!existing.createdAt || candidate.createdAt < existing.createdAt)) existing.createdAt = candidate.createdAt;
          if (candidate.lastActivity && (!existing.lastActivity || candidate.lastActivity > existing.lastActivity)) existing.lastActivity = candidate.lastActivity;
          existing.ttlSeconds = Math.max(existing.ttlSeconds, candidate.ttlSeconds);
        }
      }
      const activeSessions = [...sessionsById.values()];

      return {
        active: activeSessions.length > 0,
        session: session,
        activeSessions,
        maxConcurrent: SESSION_MAX_CONCURRENT > 0 ? SESSION_MAX_CONCURRENT : null,
        ttlSeconds: ttl > 0 ? ttl : 0,
        lastActivity: session?.lastActivity || null,
        createdAt: session?.createdAt || null
      };
    } catch (error) {
      console.error('Error getting user sessions:', error);
      return { active: false, session: null, activeSessions: [], maxConcurrent: SESSION_MAX_CONCURRENT > 0 ? SESSION_MAX_CONCURRENT : null, ttlSeconds: 0 };
    }
  }

  async revokeUserSession(userId, sessionId) {
    const listKey = this._tokensListKey(userId);
    const tokens = await redisClient.lrange(listKey, 0, -1);
    const token = (tokens || []).find((candidate) => {
      const decoded = jwt.decode(candidate);
      const tokenHash = crypto.createHash('sha256').update(String(candidate)).digest('hex');
      return String(decoded?.sid || '') === String(sessionId) || tokenHash === String(sessionId);
    });
    if (!token) return false;
    const mappedUserId = await redisClient.get(`${SESSION_PREFIX}token:${token}`);
    if (String(mappedUserId || '') !== String(userId)) return false;
    const blacklisted = await this.blacklistToken(token, tokenBlacklistTtlSeconds(token));
    if (!blacklisted) throw new Error('Could not revoke the selected session token');
    const metadataRaw = await redisClient.get(this._deviceSessionKey(userId, token));
    let metadata = {};
    try { metadata = metadataRaw ? JSON.parse(metadataRaw) : {}; } catch (_) { metadata = {}; }
    const familyId = metadata.sessionId || jwt.decode(token)?.sid;
    if (familyId) await this.deleteRefreshTokenForSession(userId, familyId);
    await redisClient.del(`${SESSION_PREFIX}token:${token}`, this._deviceSessionKey(userId, token));
    await redisClient.lrem(listKey, 0, token);
    if (familyId) await this.revokeSessionFamily(userId, familyId);
    const remaining = await redisClient.llen(listKey);
    if (!remaining) await redisClient.del(`${SESSION_PREFIX}${userId}`);
    return true;
  }

  async revokeSessionFamily(userId, sessionId) {
    if (!userId || !sessionId) return false;
    const listKey = this._tokensListKey(userId);
    const tokens = await redisClient.lrange(listKey, 0, -1);
    for (const candidate of [...new Set(tokens || [])]) {
      if (String(jwt.decode(candidate)?.sid || '') !== String(sessionId)) continue;
      const mappedUserId = await redisClient.get(`${SESSION_PREFIX}token:${candidate}`);
      if (String(mappedUserId || '') !== String(userId)) continue;
      const blacklisted = await this.blacklistToken(candidate, tokenBlacklistTtlSeconds(candidate));
      if (!blacklisted) throw new Error('Could not revoke a session token');
      await redisClient.del(`${SESSION_PREFIX}token:${candidate}`, this._deviceSessionKey(userId, candidate));
      await redisClient.lrem(listKey, 0, candidate);
    }
    await this.deleteRefreshTokenForSession(userId, sessionId);
    if (!(await redisClient.llen(listKey))) await redisClient.del(`${SESSION_PREFIX}${userId}`);
    return true;
  }

  /**
   * Get detailed list of all active sessions (for admin)
   */
  async getAllSessionsDetailed(limit = 100) {
    const pattern = `${SESSION_PREFIX}*`;
    let cursor = '0';
    const sessions = [];
    
    try {
      do {
        const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        if (Array.isArray(reply)) {
          cursor = reply[0];
          const keys = reply[1] || [];
          const sessionKeys = keys.filter(k => !k.includes('token:') && !k.includes('tokens:') && !k.includes('device:') && !k.includes('refresh:'));
          
          for (const key of sessionKeys) {
            if (sessions.length >= limit) break;
            
            const userId = key.replace(SESSION_PREFIX, '');
            const sessionData = await redisClient.get(key);
            const ttl = await redisClient.ttl(key);
            
            if (sessionData) {
              const parsed = JSON.parse(sessionData);
              sessions.push({
                userId,
                companyId: parsed.companyId,
                role: parsed.role,
                lastActivity: parsed.lastActivity,
                createdAt: parsed.createdAt,
                ttlSeconds: ttl > 0 ? ttl : 0
              });
            }
          }
        } else if (reply && reply.cursor !== undefined) {
          cursor = reply.cursor;
        } else {
          break;
        }
      } while (cursor !== '0' && sessions.length < limit);
      
      return sessions;
    } catch (error) {
      console.error('Error getting all sessions:', error);
      return [];
    }
  }

  /**
   * Blacklist a token (for immediate logout)
   * @param {string} token - JWT token to blacklist
   * @param {number} expiresIn - Token expiration time in seconds
   */
  async blacklistToken(token, expiresIn = 86400) {
    const blacklistKey = `${TOKEN_BLACKLIST_PREFIX}${token}`;
    try {
      await redisClient.setex(blacklistKey, expiresIn, '1');
      return true;
    } catch (error) {
      console.error('Error blacklisting token:', error);
      return false;
    }
  }

  /**
   * Check if token is blacklisted
   * @param {string} token - JWT token
   */
  async isTokenBlacklisted(token) {
    const blacklistKey = `${TOKEN_BLACKLIST_PREFIX}${token}`;
    try {
      const result = await redisClient.get(blacklistKey);
      return result === '1';
    } catch (error) {
      console.error('Error checking token blacklist:', error);
      return false;
    }
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions() {
    try {
      // Redis handles TTL automatically, but we can log stats
      const info = await redisClient.info('stats');
      console.log('Redis stats:', info);
      return true;
    } catch (error) {
      console.error('Error cleaning up sessions:', error);
      return false;
    }
  }
}

module.exports = new SessionService();

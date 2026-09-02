/**
 * Auth & RBAC middleware.
 * - JWT read from httpOnly cookie "td_token" OR "Authorization: Bearer <token>"
 * - req.user  = authenticated user record (sans passwordHash)
 * - req.org   = user's organization record
 * - requirePerm(module, action) enforces the RBAC matrix server-side
 */
'use strict';
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const store = require('../db/store');
const { can } = require('./util');

const configuredSecret = String(process.env.JWT_SECRET || '');
if (process.env.NODE_ENV === 'production' && configuredSecret.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production');
}
const SECRET = configuredSecret.length >= 32
  ? configuredSecret
  : crypto.randomBytes(48).toString('hex');

function safeUser(user) {
  if (!user) return null;
  const { passwordHash, resetToken, resetTokenHash, resetTokenAt, tempPassword, googleSub, ...safe } = user;
  return {
    ...safe,
    moduleAccess: { ...(safe.moduleAccess || {}) },
    dashboardWidgets: { ...(safe.dashboardWidgets || {}) }
  };
}

function signToken(user, activeOrgId) {
  const selectedOrgId = user.role === 'super_admin' && activeOrgId ? activeOrgId : user.orgId;
  return jwt.sign(
    { uid: user.id, orgId: user.orgId, activeOrgId: selectedOrgId, role: user.role, tv: user.tokenVersion || 0 },
    SECRET,
    { expiresIn: (process.env.SESSION_DAYS || '7') + 'd' }
  );
}

function attachUser(req, res, next) {
  let token = null;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) token = h.slice(7);
  else if (req.cookies && req.cookies.td_token) token = req.cookies.td_token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, SECRET);
    const user = store.byId('users', payload.uid);
    if (!user || !user.active) return next();
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) return next(); // revoked
    req.user = safeUser(user);
    const activeOrgId = user.role === 'super_admin' && payload.activeOrgId
      ? payload.activeOrgId
      : user.orgId;
    req.org = store.byId('organizations', activeOrgId);
  } catch (_) { /* invalid/expired token -> anonymous */ }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.org) return res.status(401).json({ error: 'Organization not found' });
  if (req.user.mustChangePassword && ![
    '/api/auth/me', '/api/auth/change-password', '/api/auth/logout'
  ].includes(req.originalUrl.split('?')[0])) {
    return res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function requirePerm(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!can(req.user, module, action)) {
      return res.status(403).json({ error: `Permission denied: ${module}:${action} for role "${req.user.role}"` });
    }
    next();
  };
}

function requireModule(module) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!can(req.user, module, 'view')) return res.status(403).json({ error: `Section access disabled: ${module}` });
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin access required' });
  next();
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
    maxAge: (Number(process.env.SESSION_DAYS) || 7) * 24 * 3600 * 1000,
    path: '/'
  };
}

function clearSessionCookieOptions() {
  const { maxAge, ...options } = sessionCookieOptions();
  return options;
}

/* naive in-memory rate limiter for sensitive endpoints */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const nowTs = Date.now();
  let arr = buckets.get(key) || [];
  arr = arr.filter(t => nowTs - t < windowMs);
  arr.push(nowTs);
  buckets.set(key, arr);
  return arr.length <= max;
}
function loginLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit('login:' + ip, 12, 60_000)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and retry.' });
  }
  next();
}

module.exports = {
  signToken, SECRET, safeUser, attachUser, requireAuth, requirePerm, requireModule,
  requireSuperAdmin, sessionCookieOptions, clearSessionCookieOptions, rateLimit, loginLimiter
};

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
const { can, canUseApp } = require('./util');

const configuredSecret = String(process.env.JWT_SECRET || '');
if (process.env.NODE_ENV === 'production' && configuredSecret.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production');
}
const SECRET = configuredSecret.length >= 32
  ? configuredSecret
  : crypto.randomBytes(48).toString('hex');

function safeUser(user) {
  if (!user) return null;
  const { passwordHash, resetToken, resetTokenHash, resetTokenAt, tempPassword, googleSub, mfaSecret, ...safe } = user;
  return {
    ...safe,
    moduleAccess: { ...(safe.moduleAccess || {}) },
    dashboardWidgets: { ...(safe.dashboardWidgets || {}) }
  };
}

function signToken(user, activeOrgId, sessionId) {
  const selectedOrgId = user.role === 'super_admin' && activeOrgId ? activeOrgId : user.orgId;
  return jwt.sign(
    { uid: user.id, orgId: user.orgId, activeOrgId: selectedOrgId, role: user.role, tv: user.tokenVersion || 0, sid: sessionId || null },
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
    if (payload.sid) {
      const session = store.findOne('authSessions', row => row.id === payload.sid && row.userId === user.id && !row.revokedAt);
      if (!session || (session.expiresAt && new Date(session.expiresAt) <= new Date())) return next();
      req.authSession = session;
    }
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
  const subscription = store.findOne('subscriptions', row => row.orgId === req.org.id);
  const trialExpired = subscription && subscription.status === 'trial' && subscription.trialEndsAt && new Date(subscription.trialEndsAt) < new Date();
  const blocked = subscription && ['suspended', 'cancelled'].includes(subscription.status);
  const path = req.originalUrl.split('?')[0];
  if (req.user.role !== 'super_admin' && (trialExpired || blocked) && !['/api/auth/me', '/api/auth/logout', '/api/subscription/current'].includes(path)) {
    return res.status(402).json({ error: trialExpired ? 'Trial expired. Contact Tech Defenders to renew access.' : 'Workspace access is suspended. Contact Tech Defenders to renew.', code: trialExpired ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_SUSPENDED' });
  }
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

const APP_API_RULES = [
  [/^\/api\/crm\/leads(?:\/|$)/, 'crm/leads'], [/^\/api\/crm\/customers(?:\/|$)/, 'crm/customers'],
  [/^\/api\/crm\/contacts(?:\/|$)/, 'crm/contacts'], [/^\/api\/crm\/meetings(?:\/|$)/, 'crm/meetings'],
  [/^\/api\/crm\/daily-work(?:\/|$)/, 'crm/daily-work'], [/^\/api\/crm\/late-payments(?:\/|$)/, 'crm/late-payments'],
  [/^\/api\/crm\/deals(?:\/|$)/, 'crm/deals'], [/^\/api\/crm\/tasks(?:\/|$)/, 'crm/tasks'],
  [/^\/api\/crm\/activities(?:\/|$)/, 'crm/customers'],
  [/^\/api\/sales\/quotations(?:\/|$)/, 'sales/quotations'], [/^\/api\/sales\/sales-orders(?:\/|$)/, 'sales/orders'],
  [/^\/api\/sales\/invoices(?:\/|$)/, 'sales/invoices'], [/^\/api\/sales\/receipts(?:\/|$)/, 'sales/receipts'],
  [/^\/api\/sales\/credit-notes(?:\/|$)/, 'sales/credit-notes'],
  [/^\/api\/purchase\/requisitions(?:\/|$)/, 'purchase/requisitions'], [/^\/api\/purchase\/rfqs(?:\/|$)/, 'purchase/rfqs'],
  [/^\/api\/purchase\/purchase-orders(?:\/|$)/, 'purchase/orders'], [/^\/api\/purchase\/grns(?:\/|$)/, 'purchase/grns'],
  [/^\/api\/purchase\/suppliers(?:\/|$)/, 'purchase/suppliers'],
  [/^\/api\/inventory\/products(?:\/|$)/, 'inventory/products'], [/^\/api\/inventory\/summary(?:\/|$)/, 'inventory/summary'],
  [/^\/api\/inventory\/ledger(?:\/|$)/, 'inventory/ledger'],
  [/^\/api\/manufacturing\/boms(?:\/|$)/, 'manufacturing/boms'], [/^\/api\/manufacturing\/job-orders(?:\/|$)/, 'manufacturing/jobs'],
  [/^\/api\/service\/amc(?:\/|$)/, 'service/amc'], [/^\/api\/service\/tickets(?:\/|$)/, 'service/tickets'],
  [/^\/api\/service\/sla(?:\/|$)/, 'service/sla-control'],
  [/^\/api\/finance\/accounts(?:\/|$)/, 'finance/accounts'], [/^\/api\/finance\/journals(?:\/|$)/, 'finance/journals'],
  [/^\/api\/finance\/expenses(?:\/|$)/, 'finance/expenses'], [/^\/api\/finance\/pnl(?:\/|$)/, 'finance/pnl'],
  [/^\/api\/ai-command(?:\/|$)/, 'ai/command-centre'], [/^\/api\/customer-tools(?:\/|$)/, 'crm/intelligence'],
  [/^\/api\/collections(?:\/|$)/, 'sales/collections'], [/^\/api\/inventory-controls(?:\/|$)/, 'inventory/quality'],
  [/^\/api\/p0\/attendance(?:\/|$)/, 'hr/attendance'], [/^\/api\/p0\/shifts(?:\/|$)/, 'hr/attendance'], [/^\/api\/p0\/(?:salary-components|payroll-policy|payroll-runs|my\/payslips)(?:\/|$)/, 'hr/payroll'],
  [/^\/api\/finance-controls\/bank(?:-|\/|$)/, 'finance/banking'], [/^\/api\/finance-controls\/gst(?:-|\/|$)/, 'finance/gst-dashboard'],
  [/^\/api\/enterprise-controls\/sales\/recurring(?:\/|$)/, 'sales/recurring'], [/^\/api\/enterprise-controls\/purchase(?:\/|$)/, 'purchase/matching'],
  [/^\/api\/enterprise-controls\/manufacturing(?:\/|$)/, 'manufacturing/planning'], [/^\/api\/enterprise-controls\/service(?:\/|$)/, 'service/dispatch'],
  [/^\/api\/report-controls(?:\/|$)/, 'reports/builder'], [/^\/api\/business-hub\/api(?:\/|$)/, 'admin/api-hub'],
  [/^\/api\/business-hub\/communication(?:\/|$)/, 'communication/governance'], [/^\/api\/business-hub\/commerce(?:\/|$)/, 'sales/b2b-commerce'],
  [/^\/api\/workspace\/self-service(?:\/|$)/, 'hr/self-service']
];
function enforceAppAccess(req, res, next) {
  if (!req.user) return next();
  const rule = APP_API_RULES.find(([pattern]) => pattern.test(req.path));
  if (rule && !canUseApp(req.user, rule[1])) return res.status(403).json({ error: `App access disabled: ${rule[1]}`, code: 'APP_ACCESS_DISABLED' });
  next();
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
  requireSuperAdmin, enforceAppAccess, sessionCookieOptions, clearSessionCookieOptions, rateLimit, loginLimiter
};

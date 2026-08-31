/**
 * Authentication routes:
 * POST /api/auth/register/request-otp - email a signup verification code
 * POST /api/auth/register/verify-otp  - verify code + create workspace
 * POST /api/auth/login     - email/password sign-in
 * POST /api/auth/login/request-otp    - email a passwordless sign-in code
 * POST /api/auth/login/verify-otp     - verify code + sign in
 * POST /api/auth/forgot    - request reset token (returned in dev mode)
 * POST /api/auth/reset     - consume reset token
 * GET  /api/auth/me        - current user + org + permissions
 * POST /api/auth/logout
 */
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('../../db/store');
const {
  signToken, safeUser, requireAuth, loginLimiter, rateLimit,
  sessionCookieOptions, clearSessionCookieOptions
} = require('../middleware');
const { audit, effectiveAccess } = require('../util');
const { sendSystemEmail, ProviderError } = require('../services/integrations');

const router = express.Router();
function publicUser(u) {
  return safeUser(u);
}

const OTP_TTL_MS = Math.max(5, Math.min(Number(process.env.EMAIL_OTP_TTL_MINUTES) || 10, 30)) * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const normEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(value));
const htmlEsc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function otpHash(salt, otp) {
  return crypto.createHash('sha256').update(`${salt}:${String(otp)}`).digest('hex');
}

function otpMatches(challenge, otp) {
  if (!challenge || !challenge.otpHash || !challenge.salt) return false;
  const left = Buffer.from(challenge.otpHash, 'hex');
  const right = Buffer.from(otpHash(challenge.salt, otp), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function expireOldChallenges() {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const challenge of store.find('authChallenges', item => Number(item.expiresAt || 0) < cutoff)) {
    store.remove('authChallenges', challenge.id);
  }
}

function invalidateActiveChallenges(email, purpose) {
  for (const item of store.find('authChallenges', challenge =>
    challenge.email === email && challenge.purpose === purpose && !challenge.consumedAt
  )) store.update('authChallenges', item.id, { consumedAt: new Date().toISOString(), outcome: 'superseded' });
}

function createChallenge({ purpose, email, userId, registration }) {
  invalidateActiveChallenges(email, purpose);
  const otp = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(18).toString('hex');
  const challenge = store.insert('authChallenges', {
    purpose, email, userId: userId || null, registration: registration || null,
    salt, otpHash: otpHash(salt, otp), expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0, maxAttempts: OTP_MAX_ATTEMPTS, consumedAt: null
  });
  return { challenge, otp };
}

function challengeResponse(challenge, otp, message) {
  const response = { challengeId: challenge.id, expiresInSeconds: Math.round(OTP_TTL_MS / 1000), message };
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_OTP_DELIVERY === 'capture') response.testOtp = otp;
  return response;
}

async function deliverOtp({ challenge, otp, name, heading }) {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_OTP_DELIVERY === 'capture') return;
  await sendSystemEmail({
    to: challenge.email,
    name,
    subject: `${otp} is your Tech Defenders OS verification code`,
    text: `${heading}\n\nYour verification code is ${otp}. It expires in ${Math.round(OTP_TTL_MS / 60_000)} minutes. Do not share this code.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;border:1px solid #e6e4dd;border-radius:12px"><div style="font-size:12px;letter-spacing:.18em;color:#9a7721;font-weight:700">TECH DEFENDERS OS</div><h2 style="color:#151515">${htmlEsc(heading)}</h2><p style="color:#555">Use this one-time verification code:</p><div style="font-size:32px;letter-spacing:.24em;font-weight:800;color:#151515;background:#f7f2df;border:1px solid #d4af37;border-radius:10px;padding:16px;text-align:center">${otp}</div><p style="color:#666">It expires in ${Math.round(OTP_TTL_MS / 60_000)} minutes. Do not share this code with anyone.</p></div>`
  });
}

function validateChallenge(challengeId, otp, purpose) {
  const challenge = store.byId('authChallenges', String(challengeId || ''));
  if (!challenge || challenge.purpose !== purpose || challenge.consumedAt) return { error: 'Verification code is invalid or already used' };
  if (Date.now() > Number(challenge.expiresAt || 0)) {
    store.update('authChallenges', challenge.id, { consumedAt: new Date().toISOString(), outcome: 'expired' });
    return { error: 'Verification code has expired. Request a new code.' };
  }
  const attempts = Number(challenge.attempts || 0) + 1;
  if (!otpMatches(challenge, otp)) {
    store.update('authChallenges', challenge.id, {
      attempts,
      ...(attempts >= OTP_MAX_ATTEMPTS ? { consumedAt: new Date().toISOString(), outcome: 'attempts_exhausted' } : {})
    });
    return { error: attempts >= OTP_MAX_ATTEMPTS ? 'Too many incorrect attempts. Request a new code.' : 'Verification code is incorrect' };
  }
  store.update('authChallenges', challenge.id, { attempts, consumedAt: new Date().toISOString(), outcome: 'verified' });
  return { challenge };
}

function otpRequestAllowed(req, email, purpose) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = crypto.createHash('sha256').update(`${purpose}:${ip}:${email}`).digest('hex');
  return rateLimit('email-otp:' + key, 3, 10 * 60_000);
}

/* default chart of accounts for a new organization */
function seedChartOfAccounts(orgId) {
  const coa = [
    ['1000', 'Cash in Hand', 'asset'], ['1010', 'Bank Account', 'asset'],
    ['1100', 'Accounts Receivable', 'asset'], ['1200', 'Inventory', 'asset'],
    ['1300', 'GST Input Credit', 'asset'],
    ['2000', 'Accounts Payable', 'liability'], ['2100', 'GST Output Payable', 'liability'],
    ['3000', 'Owner Capital', 'equity'], ['3100', 'Retained Earnings', 'equity'],
    ['4000', 'Sales Revenue', 'income'], ['4100', 'Service Revenue', 'income'],
    ['4200', 'AMC Revenue', 'income'],
    ['5000', 'Cost of Goods Sold', 'expense'], ['5100', 'Salaries', 'expense'],
    ['5200', 'Rent', 'expense'], ['5300', 'Utilities', 'expense'],
    ['5400', 'Marketing', 'expense'], ['5500', 'Travel', 'expense'],
    ['5600', 'Office Supplies', 'expense']
  ];
  for (const [code, name, type] of coa) {
    store.insert('accounts', { orgId, code, name, type });
  }
}

function validateRegistration(body) {
  const { name, email, password, company, phone, stateCode } = body || {};
  const emailValue = normEmail(email);
  if (!name || !email || !password || !company) {
    return { error: 'Name, email, password and company are required' };
  }
  if (!validEmail(emailValue)) return { error: 'A valid work email is required' };
  if (String(password).length < 8) return { error: 'Password must be at least 8 characters' };
  if (String(name).trim().length > 120 || String(company).trim().length > 180) return { error: 'Name or company is too long' };
  return { registration: {
    name: String(name).trim(), email: emailValue, company: String(company).trim(),
    phone: String(phone || '').trim().slice(0, 30), stateCode: String(stateCode || process.env.DEFAULT_STATE_CODE || '27').slice(0, 2),
    passwordHash: bcrypt.hashSync(String(password), 10)
  } };
}

function createOrganization(registration) {
  const { name, email, company, phone, stateCode, passwordHash } = registration;
  const org = store.insert('organizations', {
    name: company,
    legalName: company,
    gstin: '',
    pan: '',
    email,
    phone: phone || '',
    address: { line1: '', city: '', state: '', pincode: '' },
    stateCode,
    currency: 'INR',
    financialYearStart: new Date().getMonth() >= 3
      ? `${new Date().getFullYear()}-04-01`
      : `${new Date().getFullYear() - 1}-04-01`,
    timezone: 'Asia/Kolkata',
    taxMode: 'exclusive'
  });
  const user = store.insert('users', {
    orgId: org.id,
    name,
    email,
    passwordHash,
    role: 'admin',
    phone: phone || '',
    active: true,
    tokenVersion: 0,
    mustChangePassword: false,
    moduleAccess: {},
    dashboardWidgets: {}
  });
  // default numbering sequences
  for (const t of ['quotation', 'salesOrder', 'invoice', 'receipt', 'creditNote', 'requisition', 'rfq', 'purchaseOrder', 'grn', 'jobOrder', 'ticket', 'amc', 'journal', 'expense']) {
    store.insert('sequences', { orgId: org.id, type: t, nextNumber: 1 });
  }
  seedChartOfAccounts(org.id);
  store.insert('warehouses', { orgId: org.id, name: 'Main Warehouse', location: '' });
  audit(org.id, user.id, 'register', 'organization', org.id, { company });
  return { org, user };
}

router.post('/register/request-otp', loginLimiter, async (req, res) => {
  expireOldChallenges();
  const checked = validateRegistration(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const registration = checked.registration;
  if (store.findOne('users', user => user.email === registration.email)) return res.status(409).json({ error: 'An account with this email already exists' });
  if (!otpRequestAllowed(req, registration.email, 'signup')) return res.status(429).json({ error: 'Too many OTP requests. Wait 10 minutes and try again.' });
  const { challenge, otp } = createChallenge({ purpose: 'signup', email: registration.email, registration });
  try {
    await deliverOtp({ challenge, otp, name: registration.name, heading: 'Verify your new workspace' });
    return res.status(202).json(challengeResponse(challenge, otp, 'Verification code sent to your email.'));
  } catch (error) {
    store.update('authChallenges', challenge.id, { consumedAt: new Date().toISOString(), outcome: 'delivery_failed' });
    const status = error instanceof ProviderError ? error.status : 503;
    return res.status(status).json({ error: error.message || 'Email OTP could not be sent', code: error.code || 'EMAIL_DELIVERY_FAILED' });
  }
});

router.post('/register/verify-otp', loginLimiter, (req, res) => {
  const result = validateChallenge(req.body && req.body.challengeId, req.body && req.body.otp, 'signup');
  if (result.error) return res.status(400).json({ error: result.error });
  const registration = result.challenge.registration;
  if (!registration || store.findOne('users', user => user.email === registration.email)) return res.status(409).json({ error: 'This email is already registered' });
  const { org, user } = createOrganization(registration);
  const token = signToken(user);
  res.cookie('td_token', token, sessionCookieOptions());
  // Mobile clients store this bearer token in Expo SecureStore; browser sessions still use the cookie.
  res.json({ user: publicUser(user), org, token });
});

router.post('/register', (_req, res) => res.status(409).json({
  error: 'Email verification is required. Use the OTP registration flow.', code: 'EMAIL_OTP_REQUIRED'
}));

router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = store.findOne('users', u => u.email === String(email).trim().toLowerCase());
  if (!user || typeof user.passwordHash !== 'string' || !bcrypt.compareSync(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'Account deactivated. Contact your administrator.' });
  store.update('users', user.id, { lastLoginAt: new Date().toISOString() });
  audit(user.orgId, user.id, 'login', 'user', user.id);
  const token = signToken(user);
  res.cookie('td_token', token, sessionCookieOptions());
  res.json({ user: publicUser(user), token });
});

router.post('/login/request-otp', loginLimiter, async (req, res) => {
  expireOldChallenges();
  const email = normEmail(req.body && req.body.email);
  if (!validEmail(email)) return res.status(400).json({ error: 'A valid work email is required' });
  if (!otpRequestAllowed(req, email, 'login')) return res.status(429).json({ error: 'Too many OTP requests. Wait 10 minutes and try again.' });
  const user = store.findOne('users', item => item.email === email && item.active);
  const { challenge, otp } = createChallenge({ purpose: 'login', email, userId: user && user.id });
  try {
    if (user) await deliverOtp({ challenge, otp, name: user.name, heading: 'Sign in to Tech Defenders OS' });
    return res.status(202).json(challengeResponse(challenge, otp, 'If this active account exists, a verification code has been sent.'));
  } catch (error) {
    store.update('authChallenges', challenge.id, { consumedAt: new Date().toISOString(), outcome: 'delivery_failed' });
    const status = error instanceof ProviderError ? error.status : 503;
    return res.status(status).json({ error: error.message || 'Email OTP could not be sent', code: error.code || 'EMAIL_DELIVERY_FAILED' });
  }
});

router.post('/login/verify-otp', loginLimiter, (req, res) => {
  const result = validateChallenge(req.body && req.body.challengeId, req.body && req.body.otp, 'login');
  if (result.error) return res.status(400).json({ error: result.error });
  const user = result.challenge.userId && store.byId('users', result.challenge.userId);
  if (!user || !user.active) return res.status(401).json({ error: 'Verification code is invalid' });
  store.update('users', user.id, { lastLoginAt: new Date().toISOString() });
  audit(user.orgId, user.id, 'login_otp', 'user', user.id);
  const token = signToken(user);
  res.cookie('td_token', token, sessionCookieOptions());
  res.json({ user: publicUser(user), token });
});

router.post('/forgot', loginLimiter, (req, res) => {
  const { email } = req.body || {};
  const user = store.findOne('users', u => u.email === String(email || '').trim().toLowerCase());
  // Always respond the same way so accounts cannot be enumerated.
  if (!user) return res.json({ message: 'If that email exists, a reset link has been generated.' });
  const token = crypto.randomBytes(24).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  store.update('users', user.id, { resetToken: null, resetTokenHash, resetTokenAt: Date.now() });
  audit(user.orgId, null, 'password_reset_requested', 'user', user.id);
  const response = { message: 'If that email exists, password reset instructions have been generated.' };
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_RESET_TOKEN === 'true') {
    response.resetToken = token;
    response.message = 'Development reset token generated.';
  }
  res.json(response);
});

router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const user = store.findOne('users', u => u.resetTokenHash === tokenHash || u.resetToken === token);
  if (!user || !user.resetTokenAt || Date.now() - user.resetTokenAt > 30 * 60 * 1000) {
    return res.status(400).json({ error: 'Reset token is invalid or expired' });
  }
  store.update('users', user.id, {
    passwordHash: bcrypt.hashSync(String(password), 10),
    resetToken: null, resetTokenHash: null, resetTokenAt: null,
    tokenVersion: (user.tokenVersion || 0) + 1
  });
  audit(user.orgId, user.id, 'password_reset_completed', 'user', user.id);
  res.json({ message: 'Password updated. You can now sign in.' });
});

router.get('/me', requireAuth, (req, res) => {
  const { permsForRole } = require('../util');
  res.json({
    user: req.user,
    org: req.org,
    permissions: permsForRole(req.user.role),
    moduleAccess: effectiveAccess(req.user),
    isSuperAdmin: req.user.role === 'super_admin'
  });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const stored = store.byId('users', req.user.id);
  if (!stored || !bcrypt.compareSync(String(currentPassword), stored.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const updated = store.update('users', stored.id, {
    passwordHash: bcrypt.hashSync(String(newPassword), 10),
    mustChangePassword: false,
    tempPassword: undefined,
    resetToken: null,
    resetTokenHash: null,
    resetTokenAt: null,
    tokenVersion: (stored.tokenVersion || 0) + 1
  });
  delete updated.tempPassword;
  audit(stored.orgId, stored.id, 'password_changed', 'user', stored.id);
  res.cookie('td_token', signToken(updated, req.org.id), sessionCookieOptions());
  res.json({ message: 'Password changed successfully', user: publicUser(updated) });
});

router.post('/logout', (req, res) => {
  if (req.user) {
    const stored = store.byId('users', req.user.id);
    if (stored) store.update('users', stored.id, { tokenVersion: (stored.tokenVersion || 0) + 1 });
  }
  res.clearCookie('td_token', clearSessionCookieOptions());
  res.json({ message: 'Signed out' });
});

module.exports = router;

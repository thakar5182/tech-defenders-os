/**
 * Admin routes: user management (invite/create, activate/deactivate,
 * role assignment, temp-password reset), document numbering sequences,
 * company settings, HR (employees + leave) and the audit log.
 */
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('../../db/store');
const {
  requireAuth, requirePerm, requireSuperAdmin, safeUser,
  signToken, sessionCookieOptions
} = require('../middleware');
const {
  audit, notify, MODULES, DASHBOARD_WIDGETS, effectiveAccess,
  effectiveDashboardWidgets, stockBalance, r2
} = require('../util');

const router = express.Router();
router.use(requireAuth);

const STANDARD_ROLES = ['sales_manager', 'sales_exec', 'purchase_manager', 'store_manager',
  'production_manager', 'accountant', 'service_manager', 'engineer', 'employee', 'viewer'];
const SUPER_ADMIN_ASSIGNABLE_ROLES = ['admin', ...STANDARD_ROLES];

function assignableRoles(actor) {
  return actor.role === 'super_admin' ? SUPER_ADMIN_ASSIGNABLE_ROLES : STANDARD_ROLES;
}

function managementError(actor, target) {
  if (target.role === 'super_admin') return 'Super Admin accounts are platform-protected';
  if (target.role === 'admin' && actor.role !== 'super_admin') return 'Only a Super Admin can control an administrator';
  return null;
}

function activeAdmins(orgId, excludingId) {
  return store.find('users', user => user.orgId === orgId && user.id !== excludingId &&
    user.role === 'admin' && user.active && !user.deletedAt && (user.moduleAccess || {}).admin !== false);
}

function globalUserView(user) {
  const org = store.byId('organizations', user.orgId);
  return {
    ...safeUser(user),
    organization: org ? { id: org.id, name: org.name, legalName: org.legalName || '', email: org.email || '' } : null,
    effectiveAccess: effectiveAccess(user),
    effectiveDashboardWidgets: effectiveDashboardWidgets(user)
  };
}

function findGlobalTarget(id) {
  return store.findOne('users', user => user.id === id && !user.deletedAt);
}

function deleteUserRecord(target, actorUserId) {
  const previousEmail = target.email;
  store.update('users', target.id, {
    active: false,
    deletedAt: new Date().toISOString(),
    email: 'deleted+' + target.id + '@invalid.local',
    name: 'Deleted user',
    phone: '',
    passwordHash: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10),
    tokenVersion: (target.tokenVersion || 0) + 1
  });
  audit(target.orgId, actorUserId, 'delete', 'user', target.id, { previousEmail });
}

function dashboardPreview(target) {
  const orgId = target.orgId;
  const enabled = effectiveDashboardWidgets(target);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const leads = store.find('leads', item => item.orgId === orgId);
  const deals = store.find('deals', item => item.orgId === orgId);
  const tasks = store.find('tasks', item => item.orgId === orgId && item.status === 'open');
  const invoices = store.find('invoices', item => item.orgId === orgId && !['cancelled', 'credited'].includes(item.status));
  const receipts = store.find('receipts', item => item.orgId === orgId);
  const products = store.find('products', item => item.orgId === orgId && item.type !== 'service');
  const tickets = store.find('tickets', item => item.orgId === orgId);
  const purchaseOrders = store.find('purchaseOrders', item => item.orgId === orgId);
  const lowStock = products.filter(product => stockBalance(orgId, product.id) <= (Number(product.minStock) || 0));
  const outstanding = r2(invoices.reduce((sum, invoice) =>
    sum + Math.max(0, (Number(invoice.totals && invoice.totals.grandTotal) || 0) - (Number(invoice.paidAmount) || 0)), 0));
  const summaries = {
    crmOverview: { primary: leads.filter(lead => !['converted', 'lost'].includes(lead.status)).length, secondary: deals.length + ' total deals' },
    receivables: { primary: outstanding, secondary: 'outstanding receivable', format: 'money' },
    followUps: { primary: tasks.filter(task => task.dueDate && task.dueDate <= today).length, secondary: 'due or overdue tasks' },
    salesMonthly: {
      primary: invoices.filter(invoice => String(invoice.date || invoice.createdAt).slice(0, 7) === month).length,
      secondary: receipts.filter(receipt => String(receipt.date || receipt.createdAt).slice(0, 7) === month).length + ' receipts this month'
    },
    inventoryAlerts: { primary: lowStock.length, secondary: 'low-stock items' },
    serviceLoad: { primary: tickets.filter(ticket => !['resolved', 'closed'].includes(ticket.status)).length, secondary: 'open service tickets' },
    purchaseStatus: { primary: purchaseOrders.filter(order => ['draft', 'sent', 'partial'].includes(order.status)).length, secondary: 'pending purchase orders' },
    salesTrend: { primary: invoices.length, secondary: 'invoices feed the 6-month chart' },
    leadFunnel: { primary: leads.length, secondary: 'leads feed the funnel chart' },
    recentActivity: { primary: store.find('activities', item => item.orgId === orgId).length, secondary: 'CRM activity records' }
  };
  return DASHBOARD_WIDGETS.map(widget => ({
    ...widget,
    enabled: enabled[widget.key] === true,
    ...(summaries[widget.key] || { primary: 0, secondary: '' })
  }));
}

/* ================= PLATFORM CONTROL (SUPER ADMIN ONLY) ================= */
router.get('/organizations', requireSuperAdmin, (req, res) => {
  const count = (collection, orgId) => store.find(collection, item => item.orgId === orgId).length;
  const organizations = store.find('organizations')
    .map(org => ({
      ...org,
      counts: {
        users: count('users', org.id),
        customers: count('customers', org.id),
        invoices: count('invoices', org.id),
        products: count('products', org.id),
        tickets: count('tickets', org.id)
      }
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ organizations, activeOrgId: req.org.id });
});

router.post('/switch-organization', requireSuperAdmin, (req, res) => {
  const org = store.byId('organizations', req.body && req.body.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const storedUser = store.byId('users', req.user.id);
  if (!storedUser || storedUser.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin access required' });
  res.cookie('td_token', signToken(storedUser, org.id), sessionCookieOptions());
  audit(org.id, req.user.id, 'workspace_switch', 'organization', org.id, { organization: org.name });
  res.json({ message: 'Active organization changed', org });
});

/* Global account index: always reads every organization, independent of active workspace. */
router.get('/global/users', requireSuperAdmin, (req, res) => {
  const users = store.find('users', user => !user.deletedAt)
    .map(globalUserView)
    .sort((a, b) => {
      const orgCompare = String(a.organization && a.organization.name).localeCompare(String(b.organization && b.organization.name));
      return orgCompare || a.name.localeCompare(b.name);
    });
  const organizations = store.find('organizations')
    .map(org => ({ id: org.id, name: org.name, legalName: org.legalName || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    users,
    roles: SUPER_ADMIN_ASSIGNABLE_ROLES,
    modules: MODULES,
    dashboardWidgets: DASHBOARD_WIDGETS,
    organizations
  });
});

router.post('/global/users', requireSuperAdmin, (req, res) => {
  const body = req.body || {};
  const org = store.byId('organizations', body.orgId);
  if (!org) return res.status(400).json({ error: 'Valid organization is required' });
  if (!body.name || !body.email || !body.role) return res.status(400).json({ error: 'Name, email and role are required' });
  if (!SUPER_ADMIN_ASSIGNABLE_ROLES.includes(body.role)) return res.status(400).json({ error: 'Invalid role' });
  const email = String(body.email).trim().toLowerCase();
  if (store.findOne('users', user => user.email === email)) return res.status(409).json({ error: 'Email already in use' });
  const tempPassword = 'Td@' + crypto.randomBytes(4).toString('hex');
  const user = store.insert('users', {
    orgId: org.id,
    name: body.name,
    email,
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: body.role,
    phone: body.phone || '',
    active: true,
    tokenVersion: 0,
    moduleAccess: {},
    dashboardWidgets: {},
    mustChangePassword: true
  });
  audit(org.id, req.user.id, 'global_create', 'user', user.id, { email, role: body.role });
  res.json({ user: globalUserView(user), tempPassword });
});

router.patch('/global/users/:id', requireSuperAdmin, (req, res) => {
  const target = findGlobalTarget(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id || target.role === 'super_admin') return res.status(403).json({ error: 'Super Admin accounts are platform-protected' });
  const patch = {};
  if (req.body.name) patch.name = req.body.name;
  if (req.body.phone !== undefined) patch.phone = req.body.phone;
  if (typeof req.body.active === 'boolean') patch.active = req.body.active;
  if (req.body.role) {
    if (!SUPER_ADMIN_ASSIGNABLE_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
    patch.role = req.body.role;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No supported changes supplied' });
  patch.tokenVersion = (target.tokenVersion || 0) + 1;
  const updated = store.update('users', target.id, patch);
  audit(target.orgId, req.user.id, 'global_update', 'user', target.id, { role: patch.role, active: patch.active });
  res.json({ user: globalUserView(updated) });
});

router.patch('/global/users/:id/password', requireSuperAdmin, (req, res) => {
  const target = findGlobalTarget(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id || target.role === 'super_admin') return res.status(403).json({ error: 'Super Admin accounts are platform-protected' });
  const newPassword = String((req.body && req.body.newPassword) || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const updated = store.update('users', target.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    mustChangePassword: req.body.mustChangePassword !== false,
    resetToken: null,
    resetTokenHash: null,
    resetTokenAt: null,
    tokenVersion: (target.tokenVersion || 0) + 1
  });
  audit(target.orgId, req.user.id, 'global_password_change', 'user', target.id, { targetRole: target.role });
  res.json({ message: 'Password changed and existing sessions revoked', user: globalUserView(updated) });
});

router.patch('/global/users/:id/access', requireSuperAdmin, (req, res) => {
  const target = findGlobalTarget(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id || target.role === 'super_admin') return res.status(403).json({ error: 'Super Admin accounts are platform-protected' });
  const nextModules = { ...(target.moduleAccess || {}) };
  const nextWidgets = { ...(target.dashboardWidgets || {}) };
  const incomingModules = req.body && req.body.moduleAccess;
  const incomingWidgets = req.body && req.body.dashboardWidgets;
  if ((!incomingModules || typeof incomingModules !== 'object' || Array.isArray(incomingModules)) &&
      (!incomingWidgets || typeof incomingWidgets !== 'object' || Array.isArray(incomingWidgets))) {
    return res.status(400).json({ error: 'moduleAccess or dashboardWidgets object is required' });
  }
  if (incomingModules && typeof incomingModules === 'object' && !Array.isArray(incomingModules)) {
    for (const module of MODULES) if (typeof incomingModules[module.key] === 'boolean') nextModules[module.key] = incomingModules[module.key];
  }
  if (incomingWidgets && typeof incomingWidgets === 'object' && !Array.isArray(incomingWidgets)) {
    for (const widget of DASHBOARD_WIDGETS) if (typeof incomingWidgets[widget.key] === 'boolean') nextWidgets[widget.key] = incomingWidgets[widget.key];
  }
  const updated = store.update('users', target.id, {
    moduleAccess: nextModules,
    dashboardWidgets: nextWidgets,
    tokenVersion: (target.tokenVersion || 0) + 1
  });
  audit(target.orgId, req.user.id, 'global_dashboard_access_update', 'user', target.id, {
    moduleAccess: nextModules,
    dashboardWidgets: nextWidgets
  });
  res.json({
    user: globalUserView(updated),
    effectiveAccess: effectiveAccess(updated),
    effectiveDashboardWidgets: effectiveDashboardWidgets(updated)
  });
});

router.get('/global/users/:id/dashboard-preview', requireSuperAdmin, (req, res) => {
  const target = findGlobalTarget(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const org = store.byId('organizations', target.orgId);
  res.json({
    user: globalUserView(target),
    organization: org ? { id: org.id, name: org.name } : null,
    widgets: dashboardPreview(target)
  });
});

router.delete('/global/users/:id', requireSuperAdmin, (req, res) => {
  const target = findGlobalTarget(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id || target.role === 'super_admin') return res.status(403).json({ error: 'Super Admin accounts are platform-protected' });
  deleteUserRecord(target, req.user.id);
  res.json({ message: 'Account deleted, anonymized and all sessions revoked' });
});

/* ================= USERS ================= */
router.get('/users', requirePerm('admin', 'view'), (req, res) => {
  const users = store.find('users', u => u.orgId === req.org.id && !u.deletedAt)
    .map(safeUser);
  res.json({ users, roles: assignableRoles(req.user), canControlAdmins: req.user.role === 'super_admin' });
});

router.post('/users', requirePerm('admin', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.role) return res.status(400).json({ error: 'Name, email and role are required' });
  if (!assignableRoles(req.user).includes(b.role)) return res.status(403).json({ error: 'You cannot assign this role' });
  const email = String(b.email).trim().toLowerCase();
  if (store.findOne('users', u => u.email === email)) return res.status(409).json({ error: 'Email already in use' });
  /* generate a one-time temporary password; admin must share it securely */
  const tempPassword = 'Td@' + crypto.randomBytes(4).toString('hex');
  const user = store.insert('users', {
    orgId: req.org.id, name: b.name, email,
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: b.role, phone: b.phone || '',
    active: true, tokenVersion: 0,
    moduleAccess: {},
    dashboardWidgets: {},
    mustChangePassword: true
  });
  audit(req.org.id, req.user.id, 'create', 'user', user.id, { email, role: b.role });
  notify(req.org.id, { title: 'New team member added', body: `${b.name} joined as ${b.role}`, type: 'info' });
  res.json({ user: safeUser(user), tempPassword });
});

router.patch('/users/:id', requirePerm('admin', 'edit'), (req, res) => {
  const target = store.findOne('users', u => u.id === req.params.id && u.orgId === req.org.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use My Account to update your own profile or password' });
  const targetError = managementError(req.user, target);
  if (targetError) return res.status(403).json({ error: targetError });

  /* protect the last active owner/admin from demotion or deactivation */
  const wouldLoseLastAdmin =
    target.role === 'admin' &&
    ((req.body.role && req.body.role !== 'admin') || req.body.active === false) &&
    req.user.role !== 'super_admin' &&
    activeAdmins(req.org.id, target.id).length === 0;
  if (wouldLoseLastAdmin) return res.status(400).json({ error: 'Cannot remove or deactivate the last administrator' });

  const patch = {};
  if (req.body.name) patch.name = req.body.name;
  if (req.body.phone !== undefined) patch.phone = req.body.phone;
  if (req.body.role) {
    if (!assignableRoles(req.user).includes(req.body.role)) return res.status(403).json({ error: 'You cannot assign this role' });
    patch.role = req.body.role;
  }
  if (typeof req.body.active === 'boolean') patch.active = req.body.active;
  if (req.body.resetPassword) {
    const tempPassword = 'Td@' + crypto.randomBytes(4).toString('hex');
    patch.passwordHash = bcrypt.hashSync(tempPassword, 10);
    patch.mustChangePassword = true;
    patch.resetToken = null;
    patch.resetTokenHash = null;
    patch.resetTokenAt = null;
    patch.tokenVersion = (target.tokenVersion || 0) + 1; // revoke sessions
    patch._generatedTempPassword = tempPassword;
  }
  const generatedTempPassword = patch._generatedTempPassword || null;
  delete patch._generatedTempPassword;
  const updated = store.update('users', target.id, patch);
  audit(req.org.id, req.user.id, 'update', 'user', target.id, {
    role: patch.role, active: patch.active, passwordReset: !!req.body.resetPassword
  });
  res.json({ user: safeUser(updated), tempPassword: generatedTempPassword });
});

router.delete('/users/:id', requirePerm('admin', 'delete'), (req, res) => {
  const target = store.findOne('users', u => u.id === req.params.id && u.orgId === req.org.id && !u.deletedAt);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const targetError = managementError(req.user, target);
  if (targetError) return res.status(403).json({ error: targetError });
  if (target.role === 'admin' && req.user.role !== 'super_admin' && activeAdmins(req.org.id, target.id).length === 0) {
    return res.status(400).json({ error: 'Cannot delete the last administrator' });
  }
  const previousEmail = target.email;
  store.update('users', target.id, {
    active: false,
    deletedAt: new Date().toISOString(),
    email: `deleted+${target.id}@invalid.local`,
    name: 'Deleted user',
    phone: '',
    passwordHash: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10),
    tokenVersion: (target.tokenVersion || 0) + 1
  });
  audit(req.org.id, req.user.id, 'delete', 'user', target.id, { previousEmail });
  res.json({ message: 'User deleted and existing sessions revoked' });
});

router.patch('/users/:id/password', requirePerm('admin', 'edit'), (req, res) => {
  const target = store.findOne('users', user => user.id === req.params.id && user.orgId === req.org.id && !user.deletedAt);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use My Account to change your own password' });
  const targetError = managementError(req.user, target);
  if (targetError) return res.status(403).json({ error: targetError });
  const newPassword = String((req.body && req.body.newPassword) || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const updated = store.update('users', target.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    mustChangePassword: req.body.mustChangePassword !== false,
    resetToken: null,
    resetTokenHash: null,
    resetTokenAt: null,
    tokenVersion: (target.tokenVersion || 0) + 1
  });
  audit(req.org.id, req.user.id, 'password_changed_by_admin', 'user', target.id, { targetRole: target.role });
  res.json({ message: 'Password changed and existing sessions revoked', user: safeUser(updated) });
});

/* ================= ACCOUNT ACCESS CONTROL ================= */
router.get('/access-control', requirePerm('admin', 'view'), (req, res) => {
  const users = store.find('users', u => u.orgId === req.org.id && !u.deletedAt)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(u => ({
      ...safeUser(u),
      effectiveAccess: effectiveAccess(u)
    }));
  res.json({ users, modules: MODULES });
});

router.patch('/users/:id/access', requirePerm('admin', 'edit'), (req, res) => {
  const target = store.findOne('users', u => u.id === req.params.id && u.orgId === req.org.id && !u.deletedAt);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const targetError = managementError(req.user, target);
  if (targetError) return res.status(403).json({ error: targetError });
  const incoming = req.body && req.body.moduleAccess;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'moduleAccess object is required' });
  }
  const next = { ...(target.moduleAccess || {}) };
  for (const { key } of MODULES) {
    if (typeof incoming[key] === 'boolean') next[key] = incoming[key];
  }
  if (target.id === req.user.id && next.admin === false) {
    return res.status(400).json({ error: 'You cannot disable your own Administration access' });
  }
  if (target.role === 'admin' && next.admin === false && req.user.role !== 'super_admin') {
    if (!activeAdmins(req.org.id, target.id).length) return res.status(400).json({ error: 'At least one active administrator must retain Administration access' });
  }
  const updated = store.update('users', target.id, {
    moduleAccess: next,
    tokenVersion: target.id === req.user.id ? (target.tokenVersion || 0) : (target.tokenVersion || 0) + 1
  });
  audit(req.org.id, req.user.id, 'access_control_update', 'user', target.id, { moduleAccess: next });
  res.json({ user: safeUser(updated), effectiveAccess: effectiveAccess(updated) });
});

/* ================= SEQUENCES ================= */
router.get('/sequences', requirePerm('admin', 'view'), (req, res) => {
  res.json({ sequences: store.find('sequences', s => s.orgId === req.org.id).sort((a, b) => a.type.localeCompare(b.type)) });
});
router.patch('/sequences/:id', requirePerm('admin', 'edit'), (req, res) => {
  const seq = store.findOne('sequences', s => s.id === req.params.id && s.orgId === req.org.id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  const nextNumber = Number(req.body.nextNumber);
  if (!nextNumber || nextNumber < 1) return res.status(400).json({ error: 'Next number must be a positive integer' });
  const updated = store.update('sequences', seq.id, { nextNumber });
  audit(req.org.id, req.user.id, 'update', 'sequence', seq.id, { type: seq.type, nextNumber });
  res.json({ sequence: updated });
});

/* ================= COMPANY SETTINGS ================= */
router.patch('/settings', requirePerm('admin', 'edit'), (req, res) => {
  const allowed = ['name', 'legalName', 'gstin', 'pan', 'email', 'phone', 'stateCode', 'financialYearStart', 'timezone', 'taxMode', 'allowNegativeStock'];
  const org = store.byId('organizations', req.org.id);
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if ('address' in req.body && typeof req.body.address === 'object') patch.address = Object.assign({}, org.address, req.body.address);
  const updated = store.update('organizations', org.id, patch);
  audit(req.org.id, req.user.id, 'update', 'settings', org.id, patch);
  res.json({ org: updated });
});

/* ================= EMPLOYEES (HR) ================= */
router.get('/employees', requirePerm('hr', 'view'), (req, res) => {
  res.json({ employees: store.find('employees', e => e.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});
router.post('/employees', requirePerm('hr', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Employee name is required' });
  const emp = store.insert('employees', {
    orgId: req.org.id,
    empCode: b.empCode || ('EMP-' + String(store.find('employees', e => e.orgId === req.org.id).length + 1).padStart(3, '0')),
    name: b.name, department: b.department || '', designation: b.designation || '',
    email: b.email || '', phone: b.phone || '',
    joinDate: b.joinDate || new Date().toISOString().slice(0, 10),
    status: 'active'
  });
  audit(req.org.id, req.user.id, 'create', 'employee', emp.id, { name: emp.name });
  res.json({ employee: emp });
});

router.get('/leaves', requirePerm('hr', 'view'), (req, res) => {
  const list = store.find('leaveRequests', l => l.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(l => ({ ...l, employeeName: (store.byId('employees', l.employeeId) || {}).name || '?' }));
  res.json({ leaves: list });
});
router.post('/leaves', requireAuth, (req, res) => {
  const b = req.body || {};
  const emp = store.findOne('employees', e => e.id === b.employeeId && e.orgId === req.org.id);
  if (!emp) return res.status(400).json({ error: 'Valid employee is required' });
  if (!b.fromDate || !b.toDate) return res.status(400).json({ error: 'From and to dates are required' });
  const days = Math.max(1, Math.round((new Date(b.toDate) - new Date(b.fromDate)) / 86400000) + 1);
  const leave = store.insert('leaveRequests', {
    orgId: req.org.id, employeeId: emp.id, type: b.type || 'casual',
    fromDate: b.fromDate, toDate: b.toDate, days,
    reason: b.reason || '', status: 'pending'
  });
  audit(req.org.id, req.user.id, 'create', 'leave_request', leave.id);
  res.json({ leave });
});
router.post('/leaves/:id/approve', requirePerm('hr', 'approve'), (req, res) => {
  const leave = store.findOne('leaveRequests', l => l.id === req.params.id && l.orgId === req.org.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found' });
  if (leave.status !== 'pending') return res.status(400).json({ error: 'Leave already processed' });
  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const updated = store.update('leaveRequests', leave.id, { status: decision, decidedBy: req.user.id });
  audit(req.org.id, req.user.id, decision, 'leave_request', leave.id);
  res.json({ leave: updated });
});

/* ================= AUDIT LOG ================= */
router.get('/audit', requirePerm('admin', 'view'), (req, res) => {
  const list = store.find('auditEvents', a => a.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 300)
    .map(a => ({ ...a, actorName: (store.byId('users', a.actorUserId) || {}).name || 'System' }));
  res.json({ events: list });
});

module.exports = router;

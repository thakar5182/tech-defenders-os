/**
 * Service routes - Ticket-to-Renewal:
 *   AMC contracts (manual or auto-created from invoices) with expiry
 *   tracking and renewal, plus a service desk with SLA timers,
 *   assignment, work logs and parts consumption against stock.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm, safeUser } = require('../middleware');
const { r2, nextNumber, audit, notify, postStock } = require('../util');

const router = express.Router();
router.use(requireAuth);

/* ================= AMC CONTRACTS ================= */
function amcStatus(a) {
  if (a.status === 'renewed' || a.status === 'cancelled') return a.status;
  const today = new Date().toISOString().slice(0, 10);
  if (a.endDate < today) return 'expired';
  const daysLeft = Math.ceil((new Date(a.endDate) - new Date(today)) / 86400000);
  const warnDays = Math.max(...(a.reminderDays || [30]));
  return daysLeft <= warnDays ? 'expiring_soon' : 'active';
}

router.get('/amc', requirePerm('service', 'view'), (req, res) => {
  const list = store.find('amcContracts', a => a.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(a => ({
      ...a,
      status: amcStatus(a),
      customerName: (store.byId('customers', a.customerId) || {}).name || '-',
      daysLeft: Math.ceil((new Date(a.endDate) - new Date()) / 86400000)
    }));
  res.json({ contracts: list });
});

router.post('/amc', requirePerm('service', 'create'), (req, res) => {
  const b = req.body || {};
  const customer = store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  if (!b.startDate || !b.endDate) return res.status(400).json({ error: 'Start and end dates are required' });
  if (b.endDate <= b.startDate) return res.status(400).json({ error: 'End date must be after start date' });
  const contract = store.insert('amcContracts', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'amc'),
    customerId: customer.id, assetDesc: b.assetDesc || '',
    startDate: b.startDate, endDate: b.endDate,
    value: Number(b.value) || 0,
    visitsAllowed: Number(b.visitsAllowed) || 4, visitsUsed: 0,
    status: 'active', reminderDays: [90, 60, 30, 7], invoiceId: null
  });
  audit(req.org.id, req.user.id, 'create', 'amc_contract', contract.id, { number: contract.number });
  res.json({ contract });
});

/* renew an expiring/expired contract */
router.post('/amc/:id/renew', requirePerm('service', 'edit'), (req, res) => {
  const old = store.findOne('amcContracts', a => a.id === req.params.id && a.orgId === req.org.id);
  if (!old) return res.status(404).json({ error: 'Contract not found' });
  const months = Number(req.body.months) || 12;
  const start = old.endDate > new Date().toISOString().slice(0, 10) ? old.endDate : new Date().toISOString().slice(0, 10);
  const end = new Date(start); end.setMonth(end.getMonth() + months);
  const renewed = store.insert('amcContracts', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'amc'),
    customerId: old.customerId, assetDesc: old.assetDesc,
    startDate: start, endDate: end.toISOString().slice(0, 10),
    value: Number(req.body.value) || old.value,
    visitsAllowed: old.visitsAllowed, visitsUsed: 0,
    status: 'active', reminderDays: old.reminderDays,
    invoiceId: null, renewsContractId: old.id
  });
  store.update('amcContracts', old.id, { status: 'renewed', renewedToId: renewed.id });
  audit(req.org.id, req.user.id, 'renew', 'amc_contract', old.id, { newNumber: renewed.number });
  notify(req.org.id, { title: 'AMC renewed', body: `${old.number} renewed as ${renewed.number}`, type: 'success', link: '#/service/amc' });
  res.json({ contract: renewed });
});

/* ================= SERVICE TICKETS ================= */
const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'waiting_customer', 'waiting_parts', 'resolved', 'closed'];
const DEFAULT_SLA = { low: { responseHours: 24, resolutionHours: 72 }, medium: { responseHours: 8, resolutionHours: 48 }, high: { responseHours: 4, resolutionHours: 24 }, urgent: { responseHours: 1, resolutionHours: 8 } };
function policyFor(orgId, priority) { return store.findOne('serviceSlaPolicies', row => row.orgId === orgId && row.priority === priority && row.active !== false) || { priority, ...DEFAULT_SLA[priority] }; }
function ticketTiming(ticket) {
  const createdAt = new Date(ticket.createdAt); const responseHours = Number(ticket.responseSlaHours) || Number(ticket.slaHours) || 24; const resolutionHours = Number(ticket.resolutionSlaHours) || Number(ticket.slaHours) || 24;
  const responseDueAt = new Date(createdAt.getTime() + responseHours * 3600000); const resolutionDueAt = new Date(createdAt.getTime() + resolutionHours * 3600000); const complete = ['resolved', 'closed'].includes(ticket.status);
  return { responseDueAt: responseDueAt.toISOString(), resolutionDueAt: resolutionDueAt.toISOString(), responseBreached: !ticket.assignedAt && !complete && responseDueAt < new Date(), resolutionBreached: !complete && resolutionDueAt < new Date(), slaBreached: !complete && resolutionDueAt < new Date() };
}

router.get('/assignees', requirePerm('service', 'view'), (req, res) => {
  const users = store.find('users', user => user.orgId === req.org.id && user.active && !user.deletedAt && ['engineer', 'service_manager', 'admin'].includes(user.role))
    .map(safeUser);
  res.json({ users });
});

router.get('/tickets', requirePerm('service', 'view'), (req, res) => {
  const list = store.find('tickets', t => t.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(t => {
      return {
        ...t,
        customerName: (store.byId('customers', t.customerId) || {}).name || '-',
        assignedName: (store.byId('users', t.assignedTo) || {}).name || 'Unassigned',
        ...ticketTiming(t)
      };
    });
  res.json({ tickets: list });
});

router.post('/tickets', requirePerm('service', 'create'), (req, res) => {
  const b = req.body || {};
  const customer = store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  if (!b.subject) return res.status(400).json({ error: 'Subject is required' });
  /* link to an active AMC covering this customer when provided/available */
  let amcId = b.amcId || null;
  if (amcId) {
    const amc = store.findOne('amcContracts', a => a.id === amcId && a.orgId === req.org.id && a.customerId === customer.id && !['expired', 'cancelled', 'renewed'].includes(amcStatus(a)));
    if (!amc) amcId = null;
  }
  const priority = ['low', 'medium', 'high', 'urgent'].includes(b.priority) ? b.priority : 'medium';
  const policy = policyFor(req.org.id, priority);
  const ticket = store.insert('tickets', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'ticket'),
    customerId: customer.id, subject: b.subject,
    category: b.category || 'general',
    priority,
    status: 'open', assignedTo: null,
    slaHours: Number(policy.resolutionHours) || 24, responseSlaHours: Number(policy.responseHours) || 8, resolutionSlaHours: Number(policy.resolutionHours) || 24,
    assetDesc: b.assetDesc || '', amcId,
    workLog: [], partsUsed: [], channel: b.channel || 'internal'
  });
  audit(req.org.id, req.user.id, 'create', 'ticket', ticket.id, { number: ticket.number });
  res.json({ ticket });
});

router.post('/tickets/:id/assign', requirePerm('service', 'edit'), (req, res) => {
  const t = store.findOne('tickets', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const engineer = store.findOne('users', u => u.id === req.body.userId && u.orgId === req.org.id && u.active && !u.deletedAt);
  if (!engineer) return res.status(400).json({ error: 'Invalid assignee' });
  const updated = store.update('tickets', t.id, { assignedTo: engineer.id, status: 'assigned', assignedAt: t.assignedAt || new Date().toISOString() });
  t.workLog.push({ at: new Date().toISOString(), by: req.user.name, text: `Assigned to ${engineer.name}` });
  store.update('tickets', t.id, { workLog: t.workLog });
  audit(req.org.id, req.user.id, 'assign', 'ticket', t.id, { to: engineer.name });
  res.json({ ticket: updated });
});

router.get('/sla/policies', requirePerm('service', 'view'), (req, res) => res.json({ policies: ['low', 'medium', 'high', 'urgent'].map(priority => ({ ...DEFAULT_SLA[priority], ...policyFor(req.org.id, priority), priority })) }));
router.put('/sla/policies/:priority', requirePerm('service', 'edit'), (req, res) => {
  const priority = req.params.priority; if (!DEFAULT_SLA[priority]) return res.status(400).json({ error: 'Invalid priority' });
  const responseHours = Number(req.body?.responseHours), resolutionHours = Number(req.body?.resolutionHours);
  if (!Number.isFinite(responseHours) || responseHours <= 0 || responseHours > 720 || !Number.isFinite(resolutionHours) || resolutionHours <= 0 || resolutionHours > 2160 || resolutionHours < responseHours) return res.status(400).json({ error: 'Use positive response and resolution hours; resolution cannot be shorter than response.' });
  const existing = store.findOne('serviceSlaPolicies', row => row.orgId === req.org.id && row.priority === priority); const value = { orgId: req.org.id, priority, responseHours, resolutionHours, active: true, updatedBy: req.user.id };
  const policy = existing ? store.update('serviceSlaPolicies', existing.id, value) : store.insert('serviceSlaPolicies', value); audit(req.org.id, req.user.id, 'update_sla_policy', 'service_sla_policy', policy.id, { priority, responseHours, resolutionHours }); res.json({ policy });
});
router.get('/sla/workload', requirePerm('service', 'view'), (req, res) => {
  const rows = store.find('tickets', ticket => ticket.orgId === req.org.id && !['resolved', 'closed'].includes(ticket.status));
  const workload = store.find('users', user => user.orgId === req.org.id && user.active && !user.deletedAt && ['engineer', 'service_manager', 'admin'].includes(user.role)).map(user => { const assigned = rows.filter(ticket => ticket.assignedTo === user.id); return { userId: user.id, name: user.name, role: user.role, activeTickets: assigned.length, breachedTickets: assigned.filter(ticket => ticketTiming(ticket).resolutionBreached).length, urgentTickets: assigned.filter(ticket => ticket.priority === 'urgent').length }; }).sort((a, b) => b.breachedTickets - a.breachedTickets || b.activeTickets - a.activeTickets);
  res.json({ workload, unassigned: rows.filter(ticket => !ticket.assignedTo).length, breached: rows.filter(ticket => ticketTiming(ticket).resolutionBreached).length });
});

router.patch('/tickets/:id/status', requirePerm('service', 'edit'), (req, res) => {
  const t = store.findOne('tickets', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const st = req.body.status;
  if (!TICKET_STATUSES.includes(st)) return res.status(400).json({ error: 'Invalid status' });
  const patch = { status: st };
  if (st === 'resolved') patch.resolvedAt = new Date().toISOString();
  if (st === 'closed') patch.closedAt = new Date().toISOString();
  if (req.body.resolutionCode) patch.resolutionCode = req.body.resolutionCode;
  t.workLog.push({ at: new Date().toISOString(), by: req.user.name, text: `Status -> ${st}${req.body.note ? ': ' + req.body.note : ''}` });
  patch.workLog = t.workLog;
  const updated = store.update('tickets', t.id, patch);
  audit(req.org.id, req.user.id, 'status_change', 'ticket', t.id, { to: st });
  res.json({ ticket: updated });
});

/* add work log entry */
router.post('/tickets/:id/worklog', requirePerm('service', 'edit'), (req, res) => {
  const t = store.findOne('tickets', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  if (!req.body.text) return res.status(400).json({ error: 'Work log text is required' });
  t.workLog.push({ at: new Date().toISOString(), by: req.user.name, text: String(req.body.text).slice(0, 1000) });
  const updated = store.update('tickets', t.id, { workLog: t.workLog });
  res.json({ ticket: updated });
});

/* consume spare parts from stock against the ticket */
router.post('/tickets/:id/parts', requirePerm('inventory', 'edit'), (req, res) => {
  const t = store.findOne('tickets', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const product = store.findOne('products', p => p.id === req.body.productId && p.orgId === req.org.id);
  if (!product) return res.status(400).json({ error: 'Invalid part' });
  const qty = Number(req.body.qty);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be positive' });

  const wh = req.body.warehouseId
    ? store.findOne('warehouses', w => w.id === req.body.warehouseId && w.orgId === req.org.id)
    : (product.warehouseId && store.findOne('warehouses', w => w.id === product.warehouseId && w.orgId === req.org.id)) ||
      store.findOne('warehouses', w => w.orgId === req.org.id);
  if (!wh) return res.status(400).json({ error: 'No valid warehouse is available' });
  const current = r2(store.find('stockLedger', e => e.orgId === req.org.id && e.productId === product.id && e.warehouseId === wh.id)
    .reduce((s, e) => s + (Number(e.qty) || 0), 0));
  if (current < qty && !req.org.allowNegativeStock) {
    return res.status(400).json({ error: `Insufficient stock of ${product.name}. Available: ${current}` });
  }
  postStock({
    orgId: req.org.id, productId: product.id, warehouseId: wh.id,
    type: 'adjustment', qty: -qty, rate: product.purchasePrice,
    refType: 'ticket', refNumber: t.number, note: 'Service part consumed'
  });
  t.partsUsed.push({ productId: product.id, name: product.name, qty, at: new Date().toISOString(), by: req.user.name });
  t.workLog.push({ at: new Date().toISOString(), by: req.user.name, text: `Part used: ${product.name} x${qty}` });
  const updated = store.update('tickets', t.id, { partsUsed: t.partsUsed, workLog: t.workLog });
  audit(req.org.id, req.user.id, 'consume_part', 'ticket', t.id, { part: product.name, qty });
  res.json({ ticket: updated });
});

module.exports = router;

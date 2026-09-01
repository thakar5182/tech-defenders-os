/**
 * CRM routes: Leads, Customers (360 view), Deals pipeline, Tasks/Follow-ups,
 * Activity timeline. Every mutation is tenant-scoped and permission-checked.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, notify, r2 } = require('../util');

const router = express.Router();
router.use(requireAuth);
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

/* ================= LEADS ================= */
router.get('/leads', requirePerm('crm', 'view'), (req, res) => {
  const leads = store.find('leads', l => l.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ leads });
});

router.post('/leads', requirePerm('crm', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Lead name is required' });
  const lead = store.insert('leads', {
    orgId: req.org.id,
    name: b.name, company: b.company || '', email: b.email || '', phone: b.phone || '',
    source: b.source || 'manual', productInterest: b.productInterest || '',
    value: Number(b.value) || 0, priority: b.priority || 'medium',
    status: 'new', owner: req.user.id,
    nextFollowUp: b.nextFollowUp || null,
    notes: []
  });
  audit(req.org.id, req.user.id, 'create', 'lead', lead.id, { name: lead.name });
  res.json({ lead });
});

router.patch('/leads/:id', requirePerm('crm', 'edit'), (req, res) => {
  const lead = store.findOne('leads', l => l.id === req.params.id && l.orgId === req.org.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const allowed = ['name', 'company', 'email', 'phone', 'source', 'productInterest', 'value', 'priority', 'status', 'nextFollowUp'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.status && !LEAD_STATUSES.includes(patch.status)) return res.status(400).json({ error: 'Invalid lead status' });
  const updated = store.update('leads', lead.id, patch);
  if (patch.status && patch.status !== lead.status) {
    store.insert('activities', { orgId: req.org.id, entityType: 'lead', entityId: lead.id, type: 'status', text: `Status changed to "${patch.status}"`, userId: req.user.id });
  }
  audit(req.org.id, req.user.id, 'update', 'lead', lead.id, patch);
  res.json({ lead: updated });
});

router.delete('/leads/:id', requirePerm('crm', 'delete'), (req, res) => {
  const lead = store.findOne('leads', l => l.id === req.params.id && l.orgId === req.org.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status === 'converted') return res.status(400).json({ error: 'Converted leads cannot be deleted' });
  store.remove('leads', lead.id);
  audit(req.org.id, req.user.id, 'delete', 'lead', lead.id, { name: lead.name });
  res.json({ message: 'Lead deleted' });
});

/* convert lead -> customer + deal */
router.post('/leads/:id/convert', requirePerm('crm', 'edit'), (req, res) => {
  const lead = store.findOne('leads', l => l.id === req.params.id && l.orgId === req.org.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status === 'converted') return res.status(400).json({ error: 'Lead already converted' });

  const customer = store.insert('customers', {
    orgId: req.org.id,
    name: lead.company || lead.name,
    contactPerson: lead.name,
    email: lead.email || '', phone: lead.phone || '',
    gstin: '', stateCode: String(req.org.stateCode || '27'),
    billingAddress: { line1: '', city: '', state: '', pincode: '' },
    shippingAddress: { line1: '', city: '', state: '', pincode: '' },
    creditLimit: 0, paymentTermsDays: 30
  });
  const deal = store.insert('deals', {
    orgId: req.org.id,
    title: `${lead.productInterest || 'New business'} - ${customer.name}`,
    customerId: customer.id, leadId: lead.id,
    value: Number(lead.value) || 0,
    stage: 'qualified', probability: 40,
    expectedClose: null, owner: req.user.id
  });
  store.update('leads', lead.id, { status: 'converted' });
  store.insert('activities', { orgId: req.org.id, entityType: 'lead', entityId: lead.id, type: 'conversion', text: `Converted to customer ${customer.name} and deal created`, userId: req.user.id });
  audit(req.org.id, req.user.id, 'convert', 'lead', lead.id, { customerId: customer.id, dealId: deal.id });
  res.json({ customer, deal });
});

/* ================= CUSTOMERS ================= */
router.get('/customers', requirePerm('crm', 'view'), (req, res) => {
  res.json({ customers: store.find('customers', c => c.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post('/customers', requirePerm('crm', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Customer name is required' });
  const customer = store.insert('customers', {
    orgId: req.org.id,
    name: b.name, contactPerson: b.contactPerson || '',
    email: b.email || '', phone: b.phone || '',
    gstin: b.gstin || '', stateCode: String(b.stateCode || req.org.stateCode || '27'),
    billingAddress: b.billingAddress || { line1: '', city: '', state: '', pincode: '' },
    shippingAddress: b.shippingAddress || { line1: '', city: '', state: '', pincode: '' },
    creditLimit: Number(b.creditLimit) || 0,
    paymentTermsDays: Number(b.paymentTermsDays) || 30
  });
  audit(req.org.id, req.user.id, 'create', 'customer', customer.id, { name: customer.name });
  res.json({ customer });
});

router.get('/customers/:id', requirePerm('crm', 'view'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const orgId = req.org.id;
  const invoices = store.find('invoices', i => i.orgId === orgId && i.customerId === c.id);
  let billed = 0, paid = 0;
  for (const inv of invoices) {
    if (!['cancelled', 'credited'].includes(inv.status)) billed += Number(inv.totals?.grandTotal) || 0;
    paid += Number(inv.paidAmount) || 0;
  }
  res.json({
    customer: c,
    deals: store.find('deals', d => d.orgId === orgId && d.customerId === c.id),
    invoices,
    receipts: store.find('receipts', r => r.orgId === orgId && r.customerId === c.id),
    tickets: store.find('tickets', t => t.orgId === orgId && t.customerId === c.id),
    amcContracts: store.find('amcContracts', a => a.orgId === orgId && a.customerId === c.id),
    summary: { billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid) }
  });
});

router.patch('/customers/:id', requirePerm('crm', 'edit'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const allowed = ['name', 'contactPerson', 'email', 'phone', 'gstin', 'stateCode', 'billingAddress', 'shippingAddress', 'creditLimit', 'paymentTermsDays'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  const updated = store.update('customers', c.id, patch);
  audit(req.org.id, req.user.id, 'update', 'customer', c.id, patch);
  res.json({ customer: updated });
});

/* ================= DEALS ================= */
const DEAL_STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

router.get('/deals', requirePerm('crm', 'view'), (req, res) => {
  const deals = store.find('deals', d => d.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(d => ({ ...d, customerName: (store.byId('customers', d.customerId) || {}).name || '-' }));
  res.json({ deals, stages: DEAL_STAGES });
});

router.post('/deals', requirePerm('crm', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Deal title is required' });
  if (b.customerId && !store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id)) {
    return res.status(400).json({ error: 'Invalid customerId' });
  }
  if (b.leadId && !store.findOne('leads', l => l.id === b.leadId && l.orgId === req.org.id)) {
    return res.status(400).json({ error: 'Invalid leadId' });
  }
  const deal = store.insert('deals', {
    orgId: req.org.id,
    title: b.title, customerId: b.customerId || null, leadId: b.leadId || null,
    value: Number(b.value) || 0,
    stage: DEAL_STAGES.includes(b.stage) ? b.stage : 'new',
    probability: Number(b.probability) || 10,
    expectedClose: b.expectedClose || null, owner: req.user.id
  });
  audit(req.org.id, req.user.id, 'create', 'deal', deal.id, { title: deal.title });
  res.json({ deal });
});

router.patch('/deals/:id', requirePerm('crm', 'edit'), (req, res) => {
  const deal = store.findOne('deals', d => d.id === req.params.id && d.orgId === req.org.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const allowed = ['title', 'value', 'stage', 'probability', 'expectedClose'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.stage && !DEAL_STAGES.includes(patch.stage)) return res.status(400).json({ error: 'Invalid stage' });
  /* auto-probability when stage changes via kanban unless explicitly provided */
  if (patch.stage && patch.stage !== deal.stage && !('probability' in req.body)) {
    patch.probability = { new: 10, qualified: 40, proposal: 60, negotiation: 75, won: 100, lost: 0 }[patch.stage];
  }
  const updated = store.update('deals', deal.id, patch);
  if (patch.stage && patch.stage !== deal.stage) {
    store.insert('activities', { orgId: req.org.id, entityType: 'deal', entityId: deal.id, type: 'stage', text: `Stage moved to "${patch.stage}"`, userId: req.user.id });
    if (patch.stage === 'won') {
      notify(req.org.id, { title: 'Deal won', body: `"${deal.title}" was marked won by ${req.user.name}`, type: 'success', link: '#/crm/deals' });
    }
  }
  audit(req.org.id, req.user.id, 'update', 'deal', deal.id, patch);
  res.json({ deal: updated });
});

/* ================= TASKS / FOLLOW-UPS ================= */
router.get('/tasks', requirePerm('crm', 'view'), (req, res) => {
  const tasks = store.find('tasks', t => t.orgId === req.org.id)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .map(t => ({ ...t, assigneeName: (store.byId('users', t.assignee) || {}).name || 'Unassigned' }));
  res.json({ tasks });
});

router.post('/tasks', requirePerm('crm', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Task title is required' });
  const assignee = b.assignee || req.user.id;
  if (!store.findOne('users', user => user.id === assignee && user.orgId === req.org.id && user.active && !user.deletedAt)) {
    return res.status(400).json({ error: 'Invalid assignee' });
  }
  const task = store.insert('tasks', {
    orgId: req.org.id,
    title: b.title, type: b.type || 'followup',
    relatedType: b.relatedType || null, relatedId: b.relatedId || null,
    assignee,
    dueDate: b.dueDate || null, priority: b.priority || 'medium',
    status: 'open', notes: b.notes || ''
  });
  audit(req.org.id, req.user.id, 'create', 'task', task.id, { title: task.title });
  res.json({ task });
});

router.patch('/tasks/:id', requirePerm('crm', 'edit'), (req, res) => {
  const t = store.findOne('tasks', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const allowed = ['title', 'status', 'dueDate', 'priority', 'assignee', 'notes'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.assignee && !store.findOne('users', user => user.id === patch.assignee && user.orgId === req.org.id && user.active && !user.deletedAt)) {
    return res.status(400).json({ error: 'Invalid assignee' });
  }
  const updated = store.update('tasks', t.id, patch);
  audit(req.org.id, req.user.id, 'update', 'task', t.id, patch);
  res.json({ task: updated });
});

/* ================= ACTIVITY TIMELINE ================= */
router.post('/activities', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.entityType || !b.entityId || !b.text) return res.status(400).json({ error: 'entityType, entityId and text are required' });
  const act = store.insert('activities', {
    orgId: req.org.id, entityType: b.entityType, entityId: b.entityId,
    type: b.type || 'note', text: b.text, userId: req.user.id
  });
  res.json({ activity: act });
});
router.get('/activities', requireAuth, (req, res) => {
  const { entityType, entityId } = req.query;
  const list = store.find('activities', a =>
    a.orgId === req.org.id &&
    (!entityType || a.entityType === entityType) &&
    (!entityId || a.entityId === entityId)
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
   .map(a => ({ ...a, userName: (store.byId('users', a.userId) || {}).name || 'System' }));
  res.json({ activities: list.slice(0, 50) });
});

module.exports = router;

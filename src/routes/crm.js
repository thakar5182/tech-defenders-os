/**
 * CRM routes: Leads, Customers (360 view), Deals pipeline, Tasks/Follow-ups,
 * Activity timeline. Every mutation is tenant-scoped and permission-checked.
 */
'use strict';
const express = require('express');
const crypto = require('crypto');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, notify, r2, can } = require('../util');
const { sendSystemEmail } = require('../services/integrations');

const router = express.Router();
router.use(requireAuth);
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
function nextSerial(orgId, collection, prefix) {
  const max = store.find(collection, item => item.orgId === orgId).reduce((value, item) => Math.max(value, Number(String(item.serialNo || '').replace(/\D/g, '')) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
}

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
    serialNo: nextSerial(req.org.id, 'leads', 'LEAD'),
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
    serialNo: nextSerial(req.org.id, 'customers', 'CUS'),
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
    serialNo: nextSerial(req.org.id, 'customers', 'CUS'),
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
  const today = new Date().toISOString().slice(0, 10);
  const overdueInvoices = invoices.filter(inv => !['cancelled', 'credited', 'paid'].includes(inv.status) && inv.dueDate && inv.dueDate < today);
  const openTickets = store.find('tickets', t => t.orgId === orgId && t.customerId === c.id && !['closed', 'resolved'].includes(t.status));
  const activeAmcs = store.find('amcContracts', a => a.orgId === orgId && a.customerId === c.id && !['cancelled', 'expired'].includes(a.status));
  const documents = store.find('customerDocuments', doc => doc.orgId === orgId && doc.customerId === c.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ contentData, ...doc }) => doc);
  const daysToExpiry = activeAmcs.map(a => a.endDate ? Math.ceil((new Date(a.endDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null).filter(Number.isFinite);
  const health = overdueInvoices.length || openTickets.length > 2 || daysToExpiry.some(days => days <= 14)
    ? (overdueInvoices.length || daysToExpiry.some(days => days < 0) ? 'attention' : 'watch')
    : 'healthy';
  res.json({
    customer: c,
    deals: store.find('deals', d => d.orgId === orgId && d.customerId === c.id),
    invoices,
    receipts: store.find('receipts', r => r.orgId === orgId && r.customerId === c.id),
    tickets: store.find('tickets', t => t.orgId === orgId && t.customerId === c.id),
    amcContracts: store.find('amcContracts', a => a.orgId === orgId && a.customerId === c.id),
    documents,
    summary: { billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid), overdueAmount: r2(overdueInvoices.reduce((sum, inv) => sum + ((Number(inv.totals?.grandTotal) || 0) - (Number(inv.paidAmount) || 0)), 0)), overdueInvoices: overdueInvoices.length, openTickets: openTickets.length, health, amcDaysRemaining: daysToExpiry.length ? Math.min(...daysToExpiry) : null }
  });
});

/* Customer documents: compact, tenant-scoped attachments for quotations, POs and agreements. */
router.post('/customers/:id/documents', requirePerm('crm', 'edit'), (req, res) => {
  const customer = store.findOne('customers', c => c.id === req.params.id && c.orgId === req.org.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  const contentData = String(b.contentData || '');
  const match = /^data:(application\/pdf|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(contentData);
  if (!title) return res.status(400).json({ error: 'Document title is required' });
  if (!match) return res.status(400).json({ error: 'Only PDF, PNG, JPG or WEBP files are allowed' });
  if (Buffer.byteLength(contentData, 'utf8') > 2 * 1024 * 1024) return res.status(400).json({ error: 'File must be smaller than 1.5 MB' });
  const document = store.insert('customerDocuments', { orgId: req.org.id, customerId: customer.id, title, mimeType: match[1], contentData, uploadedBy: req.user.id });
  audit(req.org.id, req.user.id, 'upload', 'customer_document', document.id, { customerId: customer.id, title });
  const { contentData: _contentData, ...safeDocument } = document;
  res.json({ document: safeDocument });
});

router.get('/customers/:id/documents/:documentId/download', requirePerm('crm', 'view'), (req, res) => {
  const document = store.findOne('customerDocuments', doc => doc.id === req.params.documentId && doc.customerId === req.params.id && doc.orgId === req.org.id);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[document.mimeType] || 'file';
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${String(document.title).replace(/[^a-z0-9._ -]/gi, '_')}.${extension}"`);
  res.send(Buffer.from(String(document.contentData).split(',')[1] || '', 'base64'));
});

router.delete('/customers/:id/documents/:documentId', requirePerm('crm', 'edit'), (req, res) => {
  const document = store.findOne('customerDocuments', doc => doc.id === req.params.documentId && doc.customerId === req.params.id && doc.orgId === req.org.id);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  store.remove('customerDocuments', document.id);
  audit(req.org.id, req.user.id, 'delete', 'customer_document', document.id, { customerId: req.params.id, title: document.title });
  res.json({ message: 'Document deleted' });
});

/* Customer portal invitation: only a token hash is stored. */
router.post('/customers/:id/portal-invite', requirePerm('crm', 'edit'), async (req, res) => {
  const customer = store.findOne('customers', c => c.id === req.params.id && c.orgId === req.org.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.email) return res.status(400).json({ error: 'Add the customer email before creating a portal invite' });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  store.find('portalAccess', row => row.orgId === req.org.id && row.customerId === customer.id && !row.revokedAt)
    .forEach(row => store.update('portalAccess', row.id, { revokedAt: new Date().toISOString() }));
  const access = store.insert('portalAccess', { orgId: req.org.id, partyType: 'customer', customerId: customer.id, email: customer.email, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt, createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'portal_invite', customer.id, { email: customer.email });
  const base = String(process.env.PORTAL_WEB_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const inviteUrl = base ? base + '/portal?access=' + encodeURIComponent(token) : '/portal?access=' + encodeURIComponent(token);
  let emailStatus = 'not_configured';
  if (/^https:\/\//.test(inviteUrl)) {
    try {
      await sendSystemEmail({
        to: customer.email, name: customer.contactPerson || customer.name,
        subject: 'Your secure Tech Defenders customer portal',
        text: `Open your secure customer portal: ${inviteUrl}\nThis invitation expires in 7 days.`,
        html: `<p>Hello ${String(customer.contactPerson || customer.name).replace(/[<>&]/g, '')},</p><p>Your secure Tech Defenders customer portal is ready.</p><p><a href="${inviteUrl}">Open secure portal</a></p><p>This private invitation expires in 7 days. Do not forward it.</p>`
      });
      emailStatus = 'sent';
      store.insert('portalActivities', { orgId: req.org.id, partyType: 'customer', partyId: customer.id, action: 'invite_sent', entityType: 'portal_access', entityId: access.id, detail: customer.email });
    } catch (_) { emailStatus = 'failed'; }
  }
  res.json({ token, expiresAt, inviteUrl, emailStatus });
});

router.get('/customers/:id/portal-access', requirePerm('crm', 'view'), (req, res) => {
  const customer = store.findOne('customers', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const invites = store.find('portalAccess', row => row.orgId === req.org.id && row.customerId === customer.id)
    .map(({ tokenHash, ...row }) => ({ ...row, active: !row.revokedAt && new Date(row.expiresAt) > new Date() }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ invites });
});

router.post('/customers/:id/portal-revoke', requirePerm('crm', 'edit'), (req, res) => {
  const customer = store.findOne('customers', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const revokedAt = new Date().toISOString();
  store.find('portalAccess', row => row.orgId === req.org.id && row.customerId === customer.id && !row.revokedAt)
    .forEach(row => store.update('portalAccess', row.id, { revokedAt, revokedBy: req.user.id }));
  store.insert('portalActivities', { orgId: req.org.id, partyType: 'customer', partyId: customer.id, action: 'access_revoked', entityType: 'customer', entityId: customer.id, detail: req.user.name });
  audit(req.org.id, req.user.id, 'revoke', 'portal_access', customer.id, {});
  res.json({ message: 'Customer portal access revoked' });
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

router.delete('/customers/:id', requirePerm('crm', 'delete'), (req, res) => {
  const customer = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const linked = [
    ['invoice', store.find('invoices', x => x.orgId === req.org.id && x.customerId === customer.id)],
    ['deal', store.find('deals', x => x.orgId === req.org.id && x.customerId === customer.id)],
    ['receipt', store.find('receipts', x => x.orgId === req.org.id && x.customerId === customer.id)],
    ['ticket', store.find('tickets', x => x.orgId === req.org.id && x.customerId === customer.id)],
    ['AMC contract', store.find('amcContracts', x => x.orgId === req.org.id && x.customerId === customer.id)]
  ].filter(([, rows]) => rows.length);
  if (linked.length) return res.status(409).json({ error: `Customer cannot be deleted because ${linked.map(([name, rows]) => `${rows.length} ${name}${rows.length > 1 ? 's' : ''}`).join(', ')} is linked. Keep the customer for record history.` });
  store.remove('customers', customer.id);
  audit(req.org.id, req.user.id, 'delete', 'customer', customer.id, { name: customer.name });
  res.json({ message: 'Customer deleted' });
});

/* ================= CONTACTS + MEETINGS =================
 * Kept in dedicated collections so existing customer fields and invoices are
 * not changed. Every record remains organization-scoped.
 */
router.get('/contacts', requirePerm('crm', 'view'), (req, res) => {
  const contacts = store.find('customerContacts', row => row.orgId === req.org.id)
    .map(row => ({ ...row, customerName: (store.byId('customers', row.customerId) || {}).name || '-' }))
    .sort((a, b) => String(a.customerName).localeCompare(String(b.customerName)));
  res.json({ contacts });
});

router.post('/contacts', requirePerm('crm', 'edit'), (req, res) => {
  const b = req.body || {};
  const customer = store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Valid customer is required' });
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  const contact = store.insert('customerContacts', { orgId: req.org.id, customerId: customer.id, name,
    designation: String(b.designation || '').trim().slice(0, 100), phone: String(b.phone || '').trim().slice(0, 30),
    email: String(b.email || '').trim().slice(0, 150), primary: Boolean(b.primary) });
  audit(req.org.id, req.user.id, 'create', 'customer_contact', contact.id, { customerId: customer.id, name });
  res.status(201).json({ contact });
});

router.get('/meetings', requirePerm('crm', 'view'), (req, res) => {
  const meetings = store.find('meetings', row => row.orgId === req.org.id)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
    .map(row => ({ ...row, customerName: (store.byId('customers', row.customerId) || {}).name || '-', ownerName: (store.byId('users', row.ownerId) || {}).name || '-' }));
  res.json({ meetings });
});

router.post('/meetings', requirePerm('crm', 'edit'), (req, res) => {
  const b = req.body || {};
  const customer = store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Valid customer is required' });
  const title = String(b.title || '').trim().slice(0, 160);
  if (!title || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(b.scheduledAt || ''))) return res.status(400).json({ error: 'Meeting title and scheduled time are required' });
  const meeting = store.insert('meetings', { orgId: req.org.id, customerId: customer.id, title, scheduledAt: b.scheduledAt,
    durationMinutes: Math.max(15, Math.min(480, Number(b.durationMinutes) || 30)), mode: ['office', 'online', 'visit'].includes(b.mode) ? b.mode : 'office',
    notes: String(b.notes || '').trim().slice(0, 1000), status: 'scheduled', ownerId: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'meeting', meeting.id, { customerId: customer.id, title });
  res.status(201).json({ meeting });
});

/* Daily work is intentionally read-only: it gives the team one trustworthy
 * command centre without changing the existing CRM, invoicing or task data. */
router.get('/daily-work', requirePerm('crm', 'view'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const tasks = store.find('tasks', row => row.orgId === req.org.id && row.status === 'open')
    .filter(row => row.dueDate && row.dueDate <= today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map(row => ({ ...row, assigneeName: (store.byId('users', row.assignee) || {}).name || 'Unassigned' }));
  const meetings = store.find('meetings', row => row.orgId === req.org.id && row.status === 'scheduled')
    .filter(row => String(row.scheduledAt || '').slice(0, 10) === today)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
    .map(row => ({ ...row, customerName: (store.byId('customers', row.customerId) || {}).name || '-' }));
  const latePayments = store.find('invoices', row => row.orgId === req.org.id && !['paid', 'cancelled', 'credited'].includes(row.status))
    .filter(row => row.dueDate && row.dueDate < today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map(row => ({ ...row, customerName: (store.byId('customers', row.customerId) || {}).name || '-', outstanding: Math.max(0, (Number(row.totals?.grandTotal) || 0) - (Number(row.paidAmount) || 0)) }));
  res.json({ today, tasks, meetings, latePayments, totals: { followUps: tasks.length, meetings: meetings.length, latePayments: latePayments.length, overdueAmount: r2(latePayments.reduce((sum, row) => sum + row.outstanding, 0)) } });
});

router.get('/late-payments', requirePerm('crm', 'view'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const invoices = store.find('invoices', row => row.orgId === req.org.id && !['paid', 'cancelled', 'credited'].includes(row.status))
    .filter(row => row.dueDate && row.dueDate < today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map(row => ({ ...row, customerName: (store.byId('customers', row.customerId) || {}).name || '-', outstanding: Math.max(0, (Number(row.totals?.grandTotal) || 0) - (Number(row.paidAmount) || 0)), overdueDays: Math.max(0, Math.floor((Date.now() - new Date(row.dueDate + 'T00:00:00').getTime()) / 86400000)) }));
  res.json({ invoices, totalOutstanding: r2(invoices.reduce((sum, row) => sum + row.outstanding, 0)) });
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
  const personalWorkOnly = ['employee', 'engineer'].includes(req.user.role);
  const tasks = store.find('tasks', t => t.orgId === req.org.id && (!personalWorkOnly || t.assignee === req.user.id))
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

router.patch('/tasks/:id', (req, res) => {
  const t = store.findOne('tasks', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const personalWorker = ['employee', 'engineer'].includes(req.user.role);
  if (!can(req.user, 'crm', 'edit') && !(personalWorker && t.assignee === req.user.id)) {
    return res.status(403).json({ error: 'You can update only tasks assigned to you' });
  }
  const allowed = ['title', 'status', 'dueDate', 'priority', 'assignee', 'notes'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (personalWorker) {
    delete patch.assignee;
    for (const key of Object.keys(patch)) if (!['status', 'notes'].includes(key)) delete patch[key];
  }
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

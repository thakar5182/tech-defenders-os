'use strict';

const express = require('express');
const crypto = require('crypto');
const store = require('../../db/store');
const { audit, nextNumber, r2 } = require('../util');
const { rateLimit } = require('../middleware');

const router = express.Router();
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);

router.use((req, res, next) => {
  const portalOrigin = String(process.env.PORTAL_WEB_URL || '').replace(/\/$/, '');
  if (portalOrigin && req.get('origin') === portalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', portalOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function portalAuth(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`portal:${ip}`, 180, 60_000)) return res.status(429).json({ error: 'Too many portal requests. Please retry shortly.' });
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length > 256) return res.status(401).json({ error: 'Portal session is invalid or expired' });
  const access = store.findOne('portalAccess', item => item.tokenHash === hash(token) && !item.revokedAt && new Date(item.expiresAt) > new Date());
  if (!access) return res.status(401).json({ error: 'Portal session is invalid or expired' });
  const partyType = access.partyType || (access.supplierId ? 'supplier' : 'customer');
  const partyId = partyType === 'supplier' ? access.supplierId : access.customerId;
  const collection = partyType === 'supplier' ? 'suppliers' : 'customers';
  const party = store.findOne(collection, item => item.id === partyId && item.orgId === access.orgId);
  if (!party) return res.status(401).json({ error: 'Portal session is invalid or expired' });
  req.portal = { access, partyType, partyId, party };
  next();
}

function safeDocument(document) {
  const { contentData, ...safe } = document;
  return safe;
}

function customerSession(access, customer) {
  const match = (collection, key = 'customerId') => store.find(collection, item => item.orgId === access.orgId && item[key] === customer.id);
  const invoices = match('invoices');
  const tickets = match('tickets');
  const billed = invoices.filter(item => !['cancelled', 'credited'].includes(item.status)).reduce((sum, item) => sum + (Number(item.totals?.grandTotal) || 0), 0);
  const paid = invoices.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
  const customerSummary = { id: customer.id, name: customer.name, contactPerson: customer.contactPerson, email: customer.email };
  return {
    portal: { partyType: 'customer', expiresAt: access.expiresAt },
    party: customerSummary,
    customer: customerSummary,
    summary: { billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid), openTickets: tickets.filter(item => !['closed', 'resolved'].includes(item.status)).length },
    quotations: match('quotations'), orders: match('salesOrders'), invoices, receipts: match('receipts'),
    projects: match('projects'), tickets, documents: match('customerDocuments').map(safeDocument)
  };
}

function supplierSession(access, supplier) {
  const match = collection => store.find(collection, item => item.orgId === access.orgId && item.supplierId === supplier.id);
  const invoices = match('purchaseInvoices');
  const paid = match('supplierPayments').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const billed = invoices.reduce((sum, item) => sum + (Number(item.total || item.totals?.grandTotal) || 0), 0);
  return {
    portal: { partyType: 'supplier', expiresAt: access.expiresAt },
    party: { id: supplier.id, name: supplier.name, contactPerson: supplier.contactPerson, email: supplier.email },
    summary: { billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid), openTickets: 0 },
    rfqs: store.find('rfqs', item => item.orgId === access.orgId && Array.isArray(item.vendorIds) && item.vendorIds.includes(supplier.id)),
    orders: match('purchaseOrders'), grns: match('grns'), invoices, payments: match('supplierPayments'), documents: []
  };
}

router.get('/session', portalAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(req.portal.partyType === 'supplier'
    ? supplierSession(req.portal.access, req.portal.party)
    : customerSession(req.portal.access, req.portal.party));
});

router.post('/quotations/:id/decision', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const quotation = store.findOne('quotations', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.customerId === req.portal.partyId);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'sent'].includes(quotation.status)) return res.status(409).json({ error: 'This quotation can no longer be changed' });
  const decision = req.body?.decision;
  if (!['accepted', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Choose accepted or rejected' });
  const updated = store.update('quotations', quotation.id, { status: decision, portalDecisionAt: new Date().toISOString(), portalDecisionNote: clean(req.body?.note, 500) });
  audit(quotation.orgId, null, 'portal_decision', 'quotation', quotation.id, { from: quotation.status, to: decision, customerId: req.portal.partyId });
  res.json({ quotation: updated });
});

router.post('/tickets', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const subject = clean(req.body?.subject, 160);
  const message = clean(req.body?.message, 2000);
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
  const priority = ['low', 'medium', 'high'].includes(req.body?.priority) ? req.body.priority : 'medium';
  const ticket = store.insert('tickets', {
    orgId: req.portal.access.orgId, number: nextNumber(req.portal.access.orgId, 'ticket'), customerId: req.portal.partyId,
    subject, category: clean(req.body?.category, 60) || 'portal', priority, status: 'open', assignedTo: null,
    slaHours: priority === 'high' ? 24 : 48, responseSlaHours: priority === 'high' ? 4 : 8, resolutionSlaHours: priority === 'high' ? 24 : 48,
    assetDesc: '', amcId: null, workLog: [{ at: new Date().toISOString(), by: req.portal.party.name, text: message, portal: true }],
    partsUsed: [], channel: 'customer_portal'
  });
  audit(ticket.orgId, null, 'portal_create', 'ticket', ticket.id, { customerId: req.portal.partyId, number: ticket.number });
  res.status(201).json({ ticket });
});

router.post('/tickets/:id/replies', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const ticket = store.findOne('tickets', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.customerId === req.portal.partyId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.status === 'closed') return res.status(409).json({ error: 'Closed tickets cannot receive replies' });
  const message = clean(req.body?.message, 2000);
  if (!message) return res.status(400).json({ error: 'Reply message is required' });
  const workLog = [...(ticket.workLog || []), { at: new Date().toISOString(), by: req.portal.party.name, text: message, portal: true }];
  const updated = store.update('tickets', ticket.id, { workLog, status: ticket.status === 'waiting_customer' ? 'in_progress' : ticket.status });
  audit(ticket.orgId, null, 'portal_reply', 'ticket', ticket.id, { customerId: req.portal.partyId });
  res.json({ ticket: updated });
});

router.get('/documents/:id/download', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const document = store.findOne('customerDocuments', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.customerId === req.portal.partyId);
  if (!document?.contentData) return res.status(404).json({ error: 'Document not found' });
  const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[document.mimeType] || 'file';
  res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${clean(document.title, 100).replace(/[^a-z0-9._ -]/gi, '_')}.${extension}"`);
  res.send(Buffer.from(String(document.contentData).split(',')[1] || '', 'base64'));
});

module.exports = router;

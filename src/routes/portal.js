'use strict';

const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const store = require('../../db/store');
const { audit, nextNumber, r2 } = require('../util');
const { rateLimit } = require('../middleware');

const router = express.Router();
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const activity = (portal, action, entityType, entityId, detail = '') => store.insert('portalActivities', {
  orgId: portal.access.orgId, partyType: portal.partyType, partyId: portal.partyId,
  action, entityType, entityId, detail: clean(detail, 500)
});

function streamPdf(res, title, party, record) {
  const document = new PDFDocument({ size: 'A4', margin: 48 });
  const file = clean(record.number || title, 80).replace(/[^a-z0-9._-]/gi, '_') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  document.pipe(res);
  document.fontSize(20).fillColor('#111111').text('TECH DEFENDERS', { align: 'center' });
  document.fontSize(10).fillColor('#8b6b00').text(title.toUpperCase(), { align: 'center' }).moveDown(2);
  document.fillColor('#111111').fontSize(12).text(`Number: ${record.number || '-'}`).text(`Date: ${record.date || '-'}`).text(`Party: ${party.name || '-'}`);
  if (record.validUntil) document.text(`Valid until: ${record.validUntil}`);
  if (record.dueDate) document.text(`Due date: ${record.dueDate}`);
  document.moveDown().fontSize(11).text('Items', { underline: true }).moveDown(.5);
  (record.lines || []).forEach((line, index) => {
    const qty = Number(line.qty) || 0, rate = Number(line.rate) || 0;
    document.text(`${index + 1}. ${clean(line.name || line.description, 180)}  |  Qty ${qty}  |  Rate ${rate.toFixed(2)}  |  ${(Number(line.lineTotal) || qty * rate).toFixed(2)}`);
  });
  document.moveDown().fontSize(13).text(`Total: INR ${(Number(record.totals?.grandTotal || record.total) || 0).toFixed(2)}`, { align: 'right' });
  document.moveDown(2).fontSize(9).fillColor('#666666').text('Generated securely from Tech Defenders OS. Verify payment instructions with your authorized contact.');
  document.end();
}

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
  const projects = match('projects').map(project => ({
    ...project,
    milestones: store.find('projectMilestones', row => row.orgId === access.orgId && row.projectId === project.id),
    tasks: store.find('workOrders', row => row.orgId === access.orgId && row.projectId === project.id)
  }));
  return {
    portal: { partyType: 'customer', expiresAt: access.expiresAt },
    party: customerSummary,
    customer: customerSummary,
    summary: { billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid), openTickets: tickets.filter(item => !['closed', 'resolved'].includes(item.status)).length },
    quotations: match('quotations'), orders: match('salesOrders'), invoices, receipts: match('receipts'),
    projects, tickets, documents: match('customerDocuments').map(safeDocument),
    activity: store.find('portalActivities', row => row.orgId === access.orgId && row.partyType === 'customer' && row.partyId === customer.id).slice(-50).reverse()
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
    orders: match('purchaseOrders'), grns: match('grns'), invoices, payments: match('supplierPayments'),
    documents: store.find('supplierDocuments', row => row.orgId === access.orgId && row.supplierId === supplier.id).map(safeDocument),
    activity: store.find('portalActivities', row => row.orgId === access.orgId && row.partyType === 'supplier' && row.partyId === supplier.id).slice(-50).reverse()
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
  activity(req.portal, 'decision', 'quotation', quotation.id, `${quotation.number}: ${decision}`);
  res.json({ quotation: updated });
});

router.get('/quotations/:id/pdf', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const quotation = store.findOne('quotations', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.customerId === req.portal.partyId);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  activity(req.portal, 'download', 'quotation', quotation.id, quotation.number);
  streamPdf(res, 'Quotation', req.portal.party, quotation);
});

router.get('/invoices/:id/pdf', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'customer') return res.status(403).json({ error: 'Customer portal access required' });
  const invoice = store.findOne('invoices', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.customerId === req.portal.partyId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  activity(req.portal, 'download', 'invoice', invoice.id, invoice.number);
  streamPdf(res, 'Tax Invoice', req.portal.party, invoice);
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
  activity(req.portal, 'create', 'ticket', ticket.id, ticket.number);
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
  activity(req.portal, 'reply', 'ticket', ticket.id, ticket.number);
  res.json({ ticket: updated });
});

router.post('/rfqs/:id/quote', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'supplier') return res.status(403).json({ error: 'Supplier portal access required' });
  const rfq = store.findOne('rfqs', row => row.id === req.params.id && row.orgId === req.portal.access.orgId && row.status === 'open' && (row.vendorIds || []).includes(req.portal.partyId));
  if (!rfq) return res.status(404).json({ error: 'Open RFQ not found' });
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (lines.length !== (rfq.lines || []).length) return res.status(400).json({ error: 'Provide a rate for every RFQ line' });
  if (lines.some(line => !Number.isFinite(Number(line.rate)) || Number(line.rate) < 0)) return res.status(400).json({ error: 'Every rate must be a valid non-negative number' });
  const quotes = (rfq.quotes || []).filter(row => row.vendorId !== req.portal.partyId);
  quotes.push({
    vendorId: req.portal.partyId,
    lines: lines.map(line => ({ rate: r2(Number(line.rate)), taxPct: r2(Number(line.taxPct) || 0) })),
    freight: r2(Number(req.body?.freight) || 0), leadTimeDays: Math.max(0, Number(req.body?.leadTimeDays) || 0),
    paymentTerms: clean(req.body?.paymentTerms, 300), submittedAt: new Date().toISOString(), source: 'supplier_portal'
  });
  const updated = store.update('rfqs', rfq.id, { quotes });
  activity(req.portal, 'submit', 'rfq_quote', rfq.id, rfq.number);
  audit(rfq.orgId, null, 'portal_quote', 'rfq', rfq.id, { supplierId: req.portal.partyId });
  res.json({ rfq: updated });
});

router.post('/purchase-orders/:id/decision', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'supplier') return res.status(403).json({ error: 'Supplier portal access required' });
  const order = store.findOne('purchaseOrders', row => row.id === req.params.id && row.orgId === req.portal.access.orgId && row.supplierId === req.portal.partyId);
  if (!order) return res.status(404).json({ error: 'Purchase order not found' });
  if (!['sent', 'supplier_accepted', 'supplier_rejected'].includes(order.status)) return res.status(409).json({ error: 'This purchase order cannot be changed from its current status' });
  const decision = req.body?.decision;
  if (!['accepted', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Choose accepted or rejected' });
  const updated = store.update('purchaseOrders', order.id, {
    status: `supplier_${decision}`, supplierDecisionAt: new Date().toISOString(), supplierDecisionNote: clean(req.body?.note, 500)
  });
  activity(req.portal, 'decision', 'purchase_order', order.id, `${order.number}: ${decision}`);
  audit(order.orgId, null, 'supplier_portal_decision', 'purchase_order', order.id, { supplierId: req.portal.partyId, decision });
  res.json({ purchaseOrder: updated });
});

router.post('/supplier-documents', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'supplier') return res.status(403).json({ error: 'Supplier portal access required' });
  const title = clean(req.body?.title, 120), contentData = String(req.body?.contentData || '');
  const type = ['invoice', 'quotation', 'certificate', 'other'].includes(req.body?.type) ? req.body.type : 'other';
  const match = /^data:(application\/pdf|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(contentData);
  if (!title || !match) return res.status(400).json({ error: 'Title and a PDF, PNG, JPG or WEBP file are required' });
  if (Buffer.byteLength(contentData, 'utf8') > 2 * 1024 * 1024) return res.status(400).json({ error: 'File must be smaller than 1.5 MB' });
  const document = store.insert('supplierDocuments', {
    orgId: req.portal.access.orgId, supplierId: req.portal.partyId, title, type, mimeType: match[1],
    contentData, status: 'submitted', reference: clean(req.body?.reference, 100)
  });
  activity(req.portal, 'upload', 'supplier_document', document.id, title);
  audit(document.orgId, null, 'supplier_portal_upload', 'supplier_document', document.id, { supplierId: req.portal.partyId, type });
  res.status(201).json({ document: safeDocument(document) });
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

router.get('/supplier-documents/:id/download', portalAuth, (req, res) => {
  if (req.portal.partyType !== 'supplier') return res.status(403).json({ error: 'Supplier portal access required' });
  const document = store.findOne('supplierDocuments', item => item.id === req.params.id && item.orgId === req.portal.access.orgId && item.supplierId === req.portal.partyId);
  if (!document?.contentData) return res.status(404).json({ error: 'Document not found' });
  const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[document.mimeType] || 'file';
  res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${clean(document.title, 100).replace(/[^a-z0-9._ -]/gi, '_')}.${extension}"`);
  res.send(Buffer.from(String(document.contentData).split(',')[1] || '', 'base64'));
});

module.exports = router;

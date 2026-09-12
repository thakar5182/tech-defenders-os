'use strict';

/* Public, customer-scoped read-only portal API. A customer only sees data
   belonging to the customerId stored in their short-lived invite token. */
const express = require('express');
const crypto = require('crypto');
const store = require('../../db/store');
const { r2 } = require('../util');

const router = express.Router();
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

router.use((req, res, next) => {
  const portalOrigin = String(process.env.PORTAL_WEB_URL || '').replace(/\/$/, '');
  if (portalOrigin && req.get('origin') === portalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', portalOrigin);
    res.setHeader('Vary', 'Origin');
  }
  next();
});

router.get('/session', (req, res) => {
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const access = store.findOne('portalAccess', item =>
    item.tokenHash === hash(token) && !item.revokedAt && new Date(item.expiresAt) > new Date()
  );
  if (!access) return res.status(401).json({ error: 'Portal session is invalid or expired' });

  const customer = store.findOne('customers', item => item.id === access.customerId && item.orgId === access.orgId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const invoices = store.find('invoices', item => item.orgId === access.orgId && item.customerId === customer.id);
  const tickets = store.find('tickets', item => item.orgId === access.orgId && item.customerId === customer.id);
  const documents = store.find('customerDocuments', item => item.orgId === access.orgId && item.customerId === customer.id)
    .map(({ contentData, ...safeDocument }) => safeDocument);
  const billed = invoices.filter(item => !['cancelled', 'credited'].includes(item.status))
    .reduce((sum, item) => sum + (Number(item.totals?.grandTotal) || 0), 0);
  const paid = invoices.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);

  res.json({
    customer: { id: customer.id, name: customer.name, contactPerson: customer.contactPerson },
    summary: {
      billed: r2(billed), paid: r2(paid), outstanding: r2(billed - paid),
      openTickets: tickets.filter(item => !['closed', 'resolved'].includes(item.status)).length
    },
    invoices, tickets, documents
  });
});

module.exports = router;

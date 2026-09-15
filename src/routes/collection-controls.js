'use strict';
/* Collection controls deliberately create a WhatsApp deep link only. Sending
 * remains a human action unless the official provider integration is used. */
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, r2 } = require('../util');
const communications = require('../services/communications');

const router = express.Router();
router.use(requireAuth);
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v, max = 1000) => String(v == null ? '' : v).trim().slice(0, max);
const originFor = req => clean(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`, 300).replace(/\/$/, '');

function customer(req, customerId) { return store.findOne('customers', row => row.id === customerId && row.orgId === req.org.id); }
function summary(req, row) {
  const invoices = store.find('invoices', inv => inv.orgId === req.org.id && inv.customerId === row.id && !['cancelled', 'credited'].includes(inv.status));
  const open = invoices.filter(inv => inv.status !== 'paid');
  const outstanding = r2(open.reduce((sum, inv) => sum + Math.max(0, (Number(inv.totals?.grandTotal) || 0) - (Number(inv.paidAmount) || 0)), 0));
  const overdue = open.filter(inv => inv.dueDate && inv.dueDate < today());
  const overdueAmount = r2(overdue.reduce((sum, inv) => sum + Math.max(0, (Number(inv.totals?.grandTotal) || 0) - (Number(inv.paidAmount) || 0)), 0));
  const creditLimit = Number(row.creditLimit) || 0;
  return { customer: row, invoices: open, outstanding, overdueCount: overdue.length, overdueAmount, creditLimit, creditExceeded: creditLimit > 0 && outstanding > creditLimit };
}

router.get('/customers', requirePerm('sales', 'view'), (req, res) => {
  const rows = store.find('customers', row => row.orgId === req.org.id).map(row => {
    const s = summary(req, row);
    return { id: row.id, name: row.name, phone: row.phone || '', email: row.email || '', outstanding: s.outstanding, overdueCount: s.overdueCount, overdueAmount: s.overdueAmount, creditLimit: s.creditLimit, creditExceeded: s.creditExceeded };
  }).filter(row => row.outstanding > 0 || row.creditExceeded).sort((a, b) => b.overdueAmount - a.overdueAmount || b.outstanding - a.outstanding);
  res.json({ customers: rows });
});

router.get('/customers/:id', requirePerm('sales', 'view'), (req, res) => {
  const row = customer(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  const s = summary(req, row);
  const history = store.find('communicationLogs', log => log.orgId === req.org.id && log.customerId === row.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100);
  res.json({ ...s, history });
});

router.post('/reminders', requirePerm('sales', 'edit'), (req, res) => {
  const invoice = store.findOne('invoices', inv => inv.id === req.body?.invoiceId && inv.orgId === req.org.id && !['cancelled', 'credited', 'paid'].includes(inv.status));
  if (!invoice) return res.status(404).json({ error: 'An open invoice is required' });
  const row = customer(req, invoice.customerId);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  let mobile = clean(req.body?.to || row.phone, 30).replace(/\D/g, '');
  if (mobile.length === 10) mobile = '91' + mobile;
  if (mobile.length < 11 || mobile.length > 15) return res.status(400).json({ error: 'Customer mobile number with country code is required' });
  const due = Math.max(0, (Number(invoice.totals?.grandTotal) || 0) - (Number(invoice.paidAmount) || 0));
  const token = communications.invoiceToken(req.org.id, invoice.id, Number(req.body?.linkDays) || 7);
  const invoiceUrl = `${originFor(req)}/api/ops/public/invoices/${token}.pdf`;
  const defaultMessage = `Hello ${row.name},\nA payment of ₹${due.toFixed(2)} for invoice ${invoice.number} is pending${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}.\nSecure invoice: ${invoiceUrl}\nPlease share the payment update.\nThank you,\n${req.org.name}`;
  const message = clean(req.body?.message || defaultMessage, 4000);
  const log = store.insert('communicationLogs', { orgId: req.org.id, customerId: row.id, channel: 'whatsapp', messageType: 'payment_reminder', relatedInvoiceId: invoice.id, status: 'initiated', initiatedBy: req.user.id, mode: 'deep_link', subject: `Payment reminder ${invoice.number}`, message });
  audit(req.org.id, req.user.id, 'initiate_payment_reminder', 'communication', log.id, { invoiceId: invoice.id, customerId: row.id });
  res.json({ communication: log, url: `https://wa.me/${mobile}?text=${encodeURIComponent(message)}`, message, invoiceUrl, requiresUserSend: true });
});

module.exports = router;

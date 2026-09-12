'use strict';
const express = require('express');
const crypto = require('crypto');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, r2 } = require('../util');
const router = express.Router();
router.use(requireAuth);

function customer(req) {
  return store.findOne(function (c) { return c.id === req.params.id && c.orgId === req.org.id; });
}

router.get('/customers/:id/address-book', requirePerm('crm', 'view'), function (req, res) {
  const c = customer(req); if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json({ addresses: c.addressBook || [] });
});
router.post('/customers/:id/address-book', requirePerm('crm', 'edit'), function (req, res) {
  const c = customer(req); if (!c) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {}; const label = String(b.label || '').trim().slice(0, 80);
  if (!label) return res.status(400).json({ error: 'Address label is required' });
  const address = { id: crypto.randomUUID(), label: label, type: String(b.type || 'branch').slice(0, 30), contactName: String(b.contactName || '').trim().slice(0, 120), phone: String(b.phone || '').trim().slice(0, 30), email: String(b.email || '').trim().slice(0, 160), line1: String(b.line1 || '').trim().slice(0, 240), city: String(b.city || '').trim().slice(0, 80), state: String(b.state || '').trim().slice(0, 80), pincode: String(b.pincode || '').trim().slice(0, 20), gstin: String(b.gstin || '').trim().slice(0, 30) };
  const addresses = (c.addressBook || []).concat(address);
  store.update('customers', c.id, { addressBook: addresses });
  audit(req.org.id, req.user.id, 'create', 'customer_address', address.id, { customerId: c.id, label: label });
  res.json({ address: address, addresses: addresses });
});
router.delete('/customers/:id/address-book/:addressId', requirePerm('crm', 'edit'), function (req, res) {
  const c = customer(req); if (!c) return res.status(404).json({ error: 'Customer not found' });
  const addresses = (c.addressBook || []).filter(function (x) { return x.id !== req.params.addressId; });
  if (addresses.length === (c.addressBook || []).length) return res.status(404).json({ error: 'Address not found' });
  store.update('customers', c.id, { addressBook: addresses });
  audit(req.org.id, req.user.id, 'delete', 'customer_address', req.params.addressId, { customerId: c.id });
  res.json({ addresses: addresses });
});
router.get('/customers/:id/sales-intelligence', requirePerm('crm', 'view'), function (req, res) {
  const c = customer(req); if (!c) return res.status(404).json({ error: 'Customer not found' });
  const invoices = store.find('invoices', function (i) { return i.orgId === req.org.id && i.customerId === c.id && !['cancelled','credited'].includes(i.status); });
  const receipts = store.find('receipts', function (r) { return r.orgId === req.org.id && r.customerId === c.id; });
  const totalSales = invoices.reduce(function (sum, i) { return sum + (Number(i.totals && i.totals.grandTotal) || 0); }, 0);
  const latest = invoices.slice().sort(function (a,b) { return String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)); })[0] || null;
  const delays = [];
  receipts.forEach(function (r) { (r.allocations || []).forEach(function (a) { const inv = invoices.find(function (i) { return i.id === a.invoiceId; }); if (inv && r.date && inv.dueDate) delays.push(Math.max(0, Math.round((new Date(r.date) - new Date(inv.dueDate)) / 86400000))); }); });
  const productValues = {};
  invoices.forEach(function (i) { (i.lines || []).forEach(function (line) { const name = line.name || 'Unspecified'; productValues[name] = (productValues[name] || 0) + (Number(line.taxableValue) || Number(line.qty) * Number(line.rate) || 0); }); });
  const topProducts = Object.keys(productValues).map(function (name) { return { name: name, value: r2(productValues[name]) }; }).sort(function (a,b) { return b.value - a.value; }).slice(0,5);
  res.json({ totalSales: r2(totalSales), invoiceCount: invoices.length, lastPurchase: latest ? { number: latest.number, date: latest.date, amount: r2(latest.totals && latest.totals.grandTotal) } : null, averagePaymentDelay: delays.length ? r2(delays.reduce(function (a,b) { return a+b; },0) / delays.length) : 0, topProducts: topProducts });
});
module.exports = router;

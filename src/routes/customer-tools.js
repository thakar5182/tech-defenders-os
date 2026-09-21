'use strict';
/*
 * Customer 360 support APIs.
 * Kept separate from CRM and Sales routes so these additions remain isolated
 * and do not change existing invoice, authentication or OTP behaviour.
 */
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, r2 } = require('../util');

const router = express.Router();
router.use(requireAuth);

function customerFor(req) {
  return store.findOne('customers', c => c.id === req.params.id && c.orgId === req.org.id);
}
function cleanAddress(body) {
  const b = body || {};
  return {
    label: String(b.label || '').trim().slice(0, 60),
    type: ['branch', 'godown', 'billing', 'delivery', 'other'].includes(b.type) ? b.type : 'other',
    contactName: String(b.contactName || '').trim().slice(0, 100),
    phone: String(b.phone || '').trim().slice(0, 30),
    email: String(b.email || '').trim().slice(0, 150),
    line1: String(b.line1 || '').trim().slice(0, 250),
    city: String(b.city || '').trim().slice(0, 80),
    state: String(b.state || '').trim().slice(0, 80),
    pincode: String(b.pincode || '').trim().slice(0, 20),
    isDefault: Boolean(b.isDefault)
  };
}

router.get('/customers/:id/addresses', requirePerm('crm', 'view'), (req, res) => {
  if (!customerFor(req)) return res.status(404).json({ error: 'Customer not found' });
  const addresses = store.find('customerAddresses', row => row.orgId === req.org.id && row.customerId === req.params.id)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || String(a.label).localeCompare(String(b.label)));
  res.json({ addresses });
});

router.post('/customers/:id/addresses', requirePerm('crm', 'edit'), (req, res) => {
  const customer = customerFor(req);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const address = cleanAddress(req.body);
  if (!address.label || !address.line1) return res.status(400).json({ error: 'Address name and address line are required' });
  if (address.isDefault) {
    store.find('customerAddresses', row => row.orgId === req.org.id && row.customerId === customer.id && row.isDefault)
      .forEach(row => store.update('customerAddresses', row.id, { isDefault: false }));
  }
  const saved = store.insert('customerAddresses', { orgId: req.org.id, customerId: customer.id, ...address });
  audit(req.org.id, req.user.id, 'create', 'customer_address', saved.id, { customerId: customer.id, label: saved.label });
  res.status(201).json({ address: saved });
});

router.patch('/customers/:id/addresses/:addressId', requirePerm('crm', 'edit'), (req, res) => {
  const customer = customerFor(req);
  const existing = store.findOne('customerAddresses', row => row.id === req.params.addressId && row.orgId === req.org.id && row.customerId === req.params.id);
  if (!customer || !existing) return res.status(404).json({ error: 'Address not found' });
  const address = cleanAddress({ ...existing, ...(req.body || {}) });
  if (!address.label || !address.line1) return res.status(400).json({ error: 'Address name and address line are required' });
  if (address.isDefault) {
    store.find('customerAddresses', row => row.orgId === req.org.id && row.customerId === customer.id && row.id !== existing.id && row.isDefault)
      .forEach(row => store.update('customerAddresses', row.id, { isDefault: false }));
  }
  const saved = store.update('customerAddresses', existing.id, address);
  audit(req.org.id, req.user.id, 'update', 'customer_address', saved.id, { customerId: customer.id, label: saved.label });
  res.json({ address: saved });
});

router.delete('/customers/:id/addresses/:addressId', requirePerm('crm', 'edit'), (req, res) => {
  const existing = store.findOne('customerAddresses', row => row.id === req.params.addressId && row.orgId === req.org.id && row.customerId === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Address not found' });
  store.remove('customerAddresses', existing.id);
  audit(req.org.id, req.user.id, 'delete', 'customer_address', existing.id, { customerId: req.params.id, label: existing.label });
  res.json({ message: 'Address removed' });
});

router.get('/customers/:id/intelligence', requirePerm('crm', 'view'), (req, res) => {
  const customer = customerFor(req);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const invoices = store.find('invoices', inv => inv.orgId === req.org.id && inv.customerId === customer.id && !['cancelled', 'credited'].includes(inv.status));
  const receipts = store.find('receipts', receipt => receipt.orgId === req.org.id && receipt.customerId === customer.id);
  const totalSales = r2(invoices.reduce((sum, inv) => sum + (Number(inv.totals?.grandTotal) || 0), 0));
  const paid = r2(invoices.reduce((sum, inv) => sum + (Number(inv.paidAmount) || 0), 0));
  const outstanding = r2(Math.max(0, totalSales - paid));
  const today = new Date().toISOString().slice(0, 10);
  const overdue = invoices.filter(inv => !['paid'].includes(inv.status) && inv.dueDate && inv.dueDate < today);
  const delayDays = [];
  receipts.forEach(receipt => (receipt.allocations || []).forEach(allocation => {
    const inv = invoices.find(row => row.id === allocation.invoiceId);
    if (!inv || !receipt.date) return;
    const dueDate = inv.dueDate || (inv.date
      ? new Date(Date.parse(inv.date + 'T00:00:00Z') + (Number(customer.paymentTermsDays) || 0) * 86400000).toISOString().slice(0, 10)
      : null);
    if (!dueDate) return;
    const delay = Math.max(0, Math.round((Date.parse(receipt.date + 'T00:00:00Z') - Date.parse(dueDate + 'T00:00:00Z')) / 86400000));
    if (Number.isFinite(delay)) delayDays.push(delay);
  }));
  const products = new Map();
  let estimatedCost = 0;
  let costedSales = 0;
  let hasUnknownCost = false;
  invoices.forEach(inv => (inv.lines || []).forEach(line => {
    const name = String(line.productName || line.name || line.description || 'Manual item');
    const row = products.get(name) || { name, quantity: 0, sales: 0 };
    row.quantity += Number(line.qty) || 0;
    row.sales += Number(line.amount || line.taxableValue || ((Number(line.qty) || 0) * (Number(line.rate) || 0))) || 0;
    products.set(name, row);
    const product = line.productId ? store.findOne('products', item => item.id === line.productId && item.orgId === req.org.id) : null;
    const quantity = Number(line.qty) || 0;
    const unitCost = Number(line.unitCost ?? line.costPrice ?? product?.purchasePrice);
    const lineSales = Number(line.amount || line.taxableValue || (quantity * (Number(line.rate) || 0))) || 0;
    if (Number.isFinite(unitCost) && unitCost >= 0 && (line.productId || line.unitCost != null || line.costPrice != null)) {
      estimatedCost += unitCost * quantity;
      costedSales += lineSales;
    } else if (lineSales > 0) hasUnknownCost = true;
  }));
  const lastInvoice = invoices.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
  const limit = Number(customer.creditLimit) || 0;
  res.json({
    intelligence: {
      totalSales, totalReceived: paid, outstanding,
      lastPurchase: lastInvoice ? { number: lastInvoice.number, date: lastInvoice.date, amount: Number(lastInvoice.totals?.grandTotal) || 0 } : null,
      averagePaymentDelayDays: delayDays.length ? r2(delayDays.reduce((sum, days) => sum + days, 0) / delayDays.length) : null,
      overdueInvoices: overdue.length,
      overdueAmount: r2(overdue.reduce((sum, inv) => sum + Math.max(0, (Number(inv.totals?.grandTotal) || 0) - (Number(inv.paidAmount) || 0)), 0)),
      topProducts: [...products.values()].sort((a, b) => b.sales - a.sales).slice(0, 5).map(row => ({ ...row, sales: r2(row.sales) })),
      estimatedProfit: hasUnknownCost ? null : r2(totalSales - estimatedCost),
      profitContributionPercent: totalSales && !hasUnknownCost ? r2((totalSales - estimatedCost) / totalSales * 100) : null,
      costCoveragePercent: totalSales ? r2(costedSales / totalSales * 100) : null,
      profitEstimateComplete: !hasUnknownCost,
      credit: { limit, available: limit > 0 ? r2(limit - outstanding) : null, exceeded: limit > 0 && outstanding > limit }
    }
  });
});

router.get('/customers/:id/workspace', requirePerm('crm', 'view'), (req, res) => {
  const customer = customerFor(req);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const orgId = req.org.id;
  const contacts = store.find('customerContacts', row => row.orgId === orgId && row.customerId === customer.id)
    .sort((a, b) => Number(b.primary) - Number(a.primary) || String(a.name).localeCompare(String(b.name)));
  const projects = store.find('projects', row => row.orgId === orgId && row.customerId === customer.id);
  const rows = [
    ...store.find('quotations', row => row.orgId === orgId && row.customerId === customer.id).map(row => ({ type: 'Quotation', date: row.date || row.createdAt, title: row.number, status: row.status, amount: row.totals?.grandTotal || row.total || 0 })),
    ...store.find('salesOrders', row => row.orgId === orgId && row.customerId === customer.id).map(row => ({ type: 'Sales order', date: row.date || row.createdAt, title: row.number, status: row.status, amount: row.totals?.grandTotal || row.total || 0 })),
    ...store.find('invoices', row => row.orgId === orgId && row.customerId === customer.id).map(row => ({ type: 'Invoice', date: row.date || row.createdAt, title: row.number, status: row.status, amount: row.totals?.grandTotal || 0 })),
    ...store.find('receipts', row => row.orgId === orgId && row.customerId === customer.id).map(row => ({ type: 'Payment', date: row.date || row.createdAt, title: row.number || 'Receipt', status: row.status || 'received', amount: row.amount || 0 })),
    ...store.find('tickets', row => row.orgId === orgId && row.customerId === customer.id).map(row => ({ type: 'Ticket', date: row.createdAt, title: row.number + ' · ' + row.subject, status: row.status, amount: null })),
    ...projects.map(row => ({ type: 'Project', date: row.startDate || row.createdAt, title: row.name || row.title || 'Project', status: row.status, amount: row.value || null }))
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 100);
  res.json({ contacts, projects, timeline: rows });
});

router.post('/customers/:id/contacts', requirePerm('crm', 'edit'), (req, res) => {
  const customer = customerFor(req);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  if (b.primary) store.find('customerContacts', row => row.orgId === req.org.id && row.customerId === customer.id && row.primary).forEach(row => store.update('customerContacts', row.id, { primary: false }));
  const contact = store.insert('customerContacts', { orgId: req.org.id, customerId: customer.id, name, designation: String(b.designation || '').trim().slice(0, 100), phone: String(b.phone || '').trim().slice(0, 30), email: String(b.email || '').trim().slice(0, 150), whatsapp: String(b.whatsapp || b.phone || '').trim().slice(0, 30), primary: Boolean(b.primary) });
  audit(req.org.id, req.user.id, 'create', 'customer_contact', contact.id, { customerId: customer.id, name });
  res.status(201).json({ contact });
});

module.exports = router;

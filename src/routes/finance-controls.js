'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, audit } = require('../util');

const router = express.Router();
router.use(requireAuth);

router.get('/cost-centers', requirePerm('finance', 'view'), (req, res) => {
  res.json({ costCenters: store.find('costCenters', row => row.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});
router.post('/cost-centers', requirePerm('finance', 'edit'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 24);
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!code || !name) return res.status(400).json({ error: 'Cost centre code and name are required' });
  if (store.findOne('costCenters', row => row.orgId === req.org.id && row.code === code)) return res.status(409).json({ error: 'Cost centre code already exists' });
  const costCenter = store.insert('costCenters', { orgId: req.org.id, code, name, active: true });
  audit(req.org.id, req.user.id, 'create', 'cost_center', costCenter.id, { code, name });
  res.status(201).json({ costCenter });
});

router.get('/petty-cash', requirePerm('finance', 'view'), (req, res) => {
  const transactions = store.find('pettyCashTransactions', row => row.orgId === req.org.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map(row => ({ ...row, costCenterName: (store.byId('costCenters', row.costCenterId) || {}).name || '-' }));
  const balance = r2(transactions.reduce((sum, row) => sum + (row.type === 'in' ? Number(row.amount) : -Number(row.amount)), 0));
  res.json({ transactions, balance });
});
router.post('/petty-cash', requirePerm('finance', 'create'), (req, res) => {
  const amount = Number(req.body.amount);
  const type = req.body.type === 'in' ? 'in' : 'out';
  const description = String(req.body.description || '').trim().slice(0, 240);
  const costCenterId = req.body.costCenterId || null;
  if (!amount || amount <= 0 || !description) return res.status(400).json({ error: 'Positive amount and description are required' });
  if (costCenterId && !store.findOne('costCenters', row => row.id === costCenterId && row.orgId === req.org.id)) return res.status(400).json({ error: 'Invalid cost centre' });
  const transaction = store.insert('pettyCashTransactions', { orgId: req.org.id, date: req.body.date || new Date().toISOString().slice(0, 10), type, amount: r2(amount), description, costCenterId, reference: String(req.body.reference || '').trim().slice(0, 80), createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'petty_cash_transaction', transaction.id, { type, amount: transaction.amount });
  res.status(201).json({ transaction });
});

router.get('/cheques', requirePerm('finance', 'view'), (req, res) => {
  const cheques = store.find('chequeRegisters', row => row.orgId === req.org.id).sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
  res.json({ cheques });
});
router.post('/cheques', requirePerm('finance', 'edit'), (req, res) => {
  const number = String(req.body.number || '').trim().slice(0, 50);
  const party = String(req.body.party || '').trim().slice(0, 150);
  const amount = Number(req.body.amount);
  if (!number || !party || !amount || amount <= 0) return res.status(400).json({ error: 'Cheque number, party and amount are required' });
  const cheque = store.insert('chequeRegisters', { orgId: req.org.id, number, party, amount: r2(amount), dueDate: req.body.dueDate || null, direction: req.body.direction === 'issued' ? 'issued' : 'received', status: 'pending', bank: String(req.body.bank || '').trim().slice(0, 120) });
  audit(req.org.id, req.user.id, 'create', 'cheque', cheque.id, { number, amount: cheque.amount });
  res.status(201).json({ cheque });
});
router.patch('/cheques/:id', requirePerm('finance', 'edit'), (req, res) => {
  const cheque = store.findOne('chequeRegisters', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!cheque) return res.status(404).json({ error: 'Cheque not found' });
  const status = String(req.body.status || 'pending');
  if (!['pending', 'cleared', 'bounced', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid cheque status' });
  res.json({ cheque: store.update('chequeRegisters', cheque.id, { status }) });
});

router.get('/gst-dashboard', requirePerm('finance', 'view'), (req, res) => {
  const invoices = store.find('invoices', row => row.orgId === req.org.id && !['cancelled', 'credited'].includes(row.status));
  const totals = invoices.reduce((sum, row) => {
    const t = row.totals || {}; sum.taxable += Number(t.taxableTotal) || 0; sum.cgst += Number(t.cgst) || 0; sum.sgst += Number(t.sgst) || 0; sum.igst += Number(t.igst) || 0; return sum;
  }, { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  const submissions = store.find('gstSubmissions', row => row.orgId === req.org.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12);
  res.json({ totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, r2(value)])), invoices: invoices.length, submissions });
});
module.exports = router;

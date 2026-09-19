'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, audit } = require('../util');
const crypto = require('crypto');

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

/* ================= BANKING & RECONCILIATION ================= */
const clean = (value, max = 240) => String(value || '').trim().slice(0, max);
const dateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
const transactionFingerprint = (accountId, row) => crypto.createHash('sha256').update([accountId, row.date, row.reference, row.description, row.debit, row.credit, row.balance].join('|')).digest('hex');
const daysApart = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;

router.get('/bank-accounts', requirePerm('finance', 'view'), (req, res) => {
  const accounts = store.find('bankAccounts', row => row.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ accounts });
});
router.post('/bank-accounts', requirePerm('finance', 'edit'), (req, res) => {
  const name = clean(req.body?.name, 120), bankName = clean(req.body?.bankName, 120), accountNumber = clean(req.body?.accountNumber, 40);
  if (!name || !bankName || !accountNumber) return res.status(400).json({ error: 'Account name, bank and account number are required' });
  if (store.findOne('bankAccounts', row => row.orgId === req.org.id && row.accountNumber === accountNumber)) return res.status(409).json({ error: 'Bank account already exists' });
  const account = store.insert('bankAccounts', { orgId: req.org.id, name, bankName, accountNumber, ifsc: clean(req.body?.ifsc, 20).toUpperCase(), openingBalance: r2(Number(req.body?.openingBalance) || 0), active: true, createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'bank_account', account.id, { name, bankName }); res.status(201).json({ account });
});

router.post('/bank-statements/import', requirePerm('finance', 'create'), (req, res) => {
  const account = store.findOne('bankAccounts', row => row.id === req.body?.bankAccountId && row.orgId === req.org.id);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 5000) : [];
  if (!account || !rows.length) return res.status(400).json({ error: 'Bank account and statement rows are required' });
  const normalized = [], errors = [];
  rows.forEach((source, index) => { const date = dateOnly(source.date), debit = r2(Number(source.debit) || 0), credit = r2(Number(source.credit) || 0), balance = source.balance === '' || source.balance == null ? null : r2(Number(source.balance)); if (!date || (debit <= 0 && credit <= 0) || (debit > 0 && credit > 0)) { errors.push({ row: index + 2, error: 'Valid date and exactly one debit/credit amount are required' }); return; } normalized.push({ date, description: clean(source.description, 300), reference: clean(source.reference, 100), debit, credit, balance }); });
  if (!normalized.length) return res.status(400).json({ error: 'No valid statement rows found', errors: errors.slice(0, 25) });
  let imported = 0, duplicates = 0, autoMatched = 0;
  for (const row of normalized) {
    const fingerprint = transactionFingerprint(account.id, row);
    if (store.findOne('bankTransactions', item => item.orgId === req.org.id && item.fingerprint === fingerprint)) { duplicates++; continue; }
    let match = null;
    if (row.credit > 0) match = store.findOne('receipts', item => item.orgId === req.org.id && !item.bankTransactionId && r2(Number(item.amount)) === row.credit && (!item.date || daysApart(item.date, row.date) <= 3));
    if (row.debit > 0) match = store.findOne('supplierPayments', item => item.orgId === req.org.id && !item.bankTransactionId && r2(Number(item.amount)) === row.debit && (!item.date || daysApart(item.date, row.date) <= 3));
    const transaction = store.insert('bankTransactions', { orgId: req.org.id, bankAccountId: account.id, ...row, fingerprint, status: match ? 'matched' : 'unmatched', matchedType: match ? (row.credit > 0 ? 'receipt' : 'supplier_payment') : null, matchedId: match?.id || null, matchConfidence: match ? 100 : 0 });
    if (match) { const collection = row.credit > 0 ? 'receipts' : 'supplierPayments'; store.update(collection, match.id, { bankTransactionId: transaction.id, reconciliationStatus: 'matched' }); autoMatched++; }
    imported++;
  }
  const statementImport = store.insert('bankStatementImports', { orgId: req.org.id, bankAccountId: account.id, fileName: clean(req.body?.fileName, 160), imported, duplicates, autoMatched, errors: errors.slice(0, 100), importedBy: req.user.id });
  audit(req.org.id, req.user.id, 'import', 'bank_statement', statementImport.id, { imported, duplicates, autoMatched });
  res.status(201).json({ statementImport, summary: { imported, duplicates, autoMatched, invalid: errors.length } });
});

router.get('/bank-reconciliation', requirePerm('finance', 'view'), (req, res) => {
  const accounts = store.find('bankAccounts', row => row.orgId === req.org.id);
  const accountId = req.query.bankAccountId || accounts[0]?.id;
  const account = accounts.find(row => row.id === accountId) || null;
  const transactions = account ? store.find('bankTransactions', row => row.orgId === req.org.id && row.bankAccountId === account.id).sort((a, b) => String(b.date).localeCompare(String(a.date))) : [];
  const debit = r2(transactions.reduce((sum, row) => sum + Number(row.debit || 0), 0)), credit = r2(transactions.reduce((sum, row) => sum + Number(row.credit || 0), 0));
  const closingBalance = transactions.find(row => row.balance != null)?.balance ?? r2(Number(account?.openingBalance || 0) + credit - debit);
  res.json({ accounts, account, transactions, summary: { debit, credit, closingBalance, matched: transactions.filter(row => row.status === 'matched').length, unmatched: transactions.filter(row => row.status === 'unmatched').length } });
});

router.post('/bank-transactions/:id/match', requirePerm('finance', 'edit'), (req, res) => {
  const transaction = store.findOne('bankTransactions', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!transaction) return res.status(404).json({ error: 'Bank transaction not found' });
  const maps = { receipt: 'receipts', supplier_payment: 'supplierPayments', expense: 'expenses', journal: 'journals' }, collection = maps[req.body?.matchedType];
  if (!collection) return res.status(400).json({ error: 'Choose a valid record type' });
  const record = store.findOne(collection, row => row.id === req.body?.matchedId && row.orgId === req.org.id);
  if (!record) return res.status(404).json({ error: 'Matching record not found' });
  const updated = store.update('bankTransactions', transaction.id, { status: 'matched', matchedType: req.body.matchedType, matchedId: record.id, matchConfidence: 100, matchedBy: req.user.id, matchedAt: new Date().toISOString() });
  store.update(collection, record.id, { bankTransactionId: transaction.id, reconciliationStatus: 'matched' });
  audit(req.org.id, req.user.id, 'match', 'bank_transaction', transaction.id, { matchedType: req.body.matchedType, matchedId: record.id }); res.json({ transaction: updated });
});

router.post('/bank-transactions/:id/unmatch', requirePerm('finance', 'edit'), (req, res) => {
  const transaction = store.findOne('bankTransactions', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!transaction) return res.status(404).json({ error: 'Bank transaction not found' });
  const maps = { receipt: 'receipts', supplier_payment: 'supplierPayments', expense: 'expenses', journal: 'journals' }, collection = maps[transaction.matchedType];
  if (collection && transaction.matchedId) { const record = store.findOne(collection, row => row.id === transaction.matchedId && row.orgId === req.org.id); if (record) store.update(collection, record.id, { bankTransactionId: null, reconciliationStatus: 'unmatched' }); }
  const updated = store.update('bankTransactions', transaction.id, { status: 'unmatched', matchedType: null, matchedId: null, matchConfidence: 0, matchedBy: null, matchedAt: null });
  audit(req.org.id, req.user.id, 'unmatch', 'bank_transaction', transaction.id, {}); res.json({ transaction: updated });
});

router.post('/bank-reconciliation/close', requirePerm('finance', 'approve'), (req, res) => {
  const account = store.findOne('bankAccounts', row => row.id === req.body?.bankAccountId && row.orgId === req.org.id);
  if (!account) return res.status(404).json({ error: 'Bank account not found' });
  const periodEnd = dateOnly(req.body?.periodEnd); if (!periodEnd) return res.status(400).json({ error: 'Valid period end date is required' });
  const rows = store.find('bankTransactions', row => row.orgId === req.org.id && row.bankAccountId === account.id && row.date <= periodEnd);
  const unmatched = rows.filter(row => row.status !== 'matched').length;
  if (unmatched && !req.body?.allowUnmatched) return res.status(409).json({ error: `${unmatched} transaction(s) are still unmatched` });
  const reconciliation = store.insert('bankReconciliations', { orgId: req.org.id, bankAccountId: account.id, periodEnd, statementBalance: r2(Number(req.body?.statementBalance) || 0), matchedCount: rows.length - unmatched, unmatchedCount: unmatched, status: unmatched ? 'closed_with_exceptions' : 'reconciled', closedBy: req.user.id, closedAt: new Date().toISOString() });
  audit(req.org.id, req.user.id, 'close', 'bank_reconciliation', reconciliation.id, { periodEnd, unmatched }); res.status(201).json({ reconciliation });
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

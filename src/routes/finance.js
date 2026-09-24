/**
 * Finance routes: Chart of Accounts, Journal Entries (balanced check),
 * Expenses with approval, Trial Balance and a simple P&L derived from
 * posted journal lines.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, nextNumber, audit } = require('../util');
const { assertOpen } = require('../services/finance-periods');

const router = express.Router();
router.use(requireAuth);

/* ================= CHART OF ACCOUNTS ================= */
router.get('/accounts', requirePerm('finance', 'view'), (req, res) => {
  res.json({ accounts: store.find('accounts', a => a.orgId === req.org.id).sort((a, b) => a.code.localeCompare(b.code)) });
});
router.post('/accounts', requirePerm('finance', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'Code and name are required' });
  if (!['asset', 'liability', 'income', 'expense', 'equity'].includes(b.type)) {
    return res.status(400).json({ error: 'Invalid account type' });
  }
  if (store.findOne('accounts', a => a.orgId === req.org.id && a.code === b.code)) {
    return res.status(409).json({ error: 'Account code already exists' });
  }
  const acc = store.insert('accounts', { orgId: req.org.id, code: b.code, name: b.name, type: b.type });
  audit(req.org.id, req.user.id, 'create', 'account', acc.id, { code: acc.code });
  res.json({ account: acc });
});

/* ================= JOURNALS ================= */
router.get('/journals', requirePerm('finance', 'view'), (req, res) => {
  const list = store.find('journals', j => j.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(j => ({
      ...j,
      lines: j.lines.map(l => ({ ...l, accountName: (store.byId('accounts', l.accountId) || {}).name || '?' }))
    }));
  res.json({ journals: list });
});

router.post('/journals', requirePerm('finance', 'create'), (req, res) => {
  const b = req.body || {};
  assertOpen(req.org.id, b.date || new Date().toISOString().slice(0, 10));
  if (!b.narration) return res.status(400).json({ error: 'Narration is required' });
  const lines = (b.lines || []).filter(l => l.accountId && (Number(l.debit) || Number(l.credit)))
    .map(l => ({ accountId: l.accountId, debit: r2(Number(l.debit) || 0), credit: r2(Number(l.credit) || 0) }));
  if (lines.length < 2) return res.status(400).json({ error: 'A journal needs at least two lines' });
  for (const l of lines) {
    if (!store.findOne('accounts', a => a.id === l.accountId && a.orgId === req.org.id)) {
      return res.status(400).json({ error: 'Invalid account in journal lines' });
    }
    if (l.debit > 0 && l.credit > 0) return res.status(400).json({ error: 'A line cannot have both debit and credit' });
    if (l.debit < 0 || l.credit < 0) return res.status(400).json({ error: 'Debit and credit amounts cannot be negative' });
  }
  const debits = r2(lines.reduce((s, l) => s + l.debit, 0));
  const credits = r2(lines.reduce((s, l) => s + l.credit, 0));
  if (debits !== credits) return res.status(400).json({ error: `Journal is not balanced (Dr ${debits} vs Cr ${credits})` });

  const jr = store.insert('journals', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'journal'),
    date: b.date || new Date().toISOString().slice(0, 10),
    narration: b.narration, posted: true,
    refType: 'manual', refId: null, lines
  });
  audit(req.org.id, req.user.id, 'create', 'journal', jr.id, { number: jr.number, debits });
  res.json({ journal: jr });
});

/* ================= EXPENSES ================= */
router.get('/expenses', requirePerm('finance', 'view'), (req, res) => {
  const list = store.find('expenses', e => e.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(e => ({
      ...e,
      accountName: (store.byId('accounts', e.accountHeadId) || {}).name || '-',
      requestedByName: (store.byId('users', e.requestedBy) || {}).name || '-'
    }));
  res.json({ expenses: list });
});

router.post('/expenses', requirePerm('finance', 'create'), (req, res) => {
  const b = req.body || {};
  assertOpen(req.org.id, b.date || new Date().toISOString().slice(0, 10));
  const acc = store.findOne('accounts', a => a.id === b.accountHeadId && a.orgId === req.org.id && a.type === 'expense');
  if (!acc) return res.status(400).json({ error: 'Select a valid expense account head' });
  const amount = Number(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  if (Number(b.taxAmount) < 0) return res.status(400).json({ error: 'Tax amount cannot be negative' });
  const exp = store.insert('expenses', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'expense'),
    date: b.date || new Date().toISOString().slice(0, 10),
    category: b.category || acc.name, accountHeadId: acc.id,
    amount: r2(amount), taxAmount: r2(Number(b.taxAmount) || 0),
    paidTo: b.paidTo || '', paymentMode: b.paymentMode || 'cash',
    status: 'pending', requestedBy: req.user.id,
    note: b.note || ''
  });
  audit(req.org.id, req.user.id, 'create', 'expense', exp.id, { number: exp.number, amount: exp.amount });
  res.json({ expense: exp });
});

router.post('/expenses/:id/approve', requirePerm('finance', 'approve'), (req, res) => {
  const exp = store.findOne('expenses', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!exp) return res.status(404).json({ error: 'Expense not found' });
  if (exp.status !== 'pending') return res.status(400).json({ error: 'Expense already processed' });
  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const patch = { status: decision, approvedBy: req.user.id };
  if (decision === 'approved') {
    /* post journal: Expense Dr / Cash-Bank Cr */
    const expenseAcc = store.byId('accounts', exp.accountHeadId);
    const gstInputAcc = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '1300');
    const payAcc = store.findOne('accounts', a => a.orgId === req.org.id &&
      (exp.paymentMode === 'cash' ? a.code === '1000' : a.code === '1010'));
    if (expenseAcc && payAcc) {
      const lines = [{ accountId: expenseAcc.id, debit: exp.amount, credit: 0 }];
      if (exp.taxAmount > 0 && gstInputAcc) lines.push({ accountId: gstInputAcc.id, debit: exp.taxAmount, credit: 0 });
      lines.push({ accountId: payAcc.id, debit: 0, credit: r2(exp.amount + (gstInputAcc ? exp.taxAmount : 0)) });
      store.insert('journals', {
        orgId: req.org.id, number: nextNumber(req.org.id, 'journal'),
        date: exp.date, narration: `Expense ${exp.number} - ${exp.category}`,
        posted: true, refType: 'expense', refId: exp.id,
        lines
      });
    }
  }
  const updated = store.update('expenses', exp.id, patch);
  audit(req.org.id, req.user.id, decision, 'expense', exp.id, { note: req.body.note });
  res.json({ expense: updated });
});

/* ================= REPORTS (finance) ================= */
/* trial balance across all posted journals */
router.get('/trial-balance', requirePerm('finance', 'view'), (req, res) => {
  const rows = {};
  for (const j of store.find('journals', x => x.orgId === req.org.id && x.posted)) {
    for (const l of j.lines) {
      const acc = store.byId('accounts', l.accountId);
      if (!acc) continue;
      rows[acc.id] = rows[acc.id] || { code: acc.code, name: acc.name, type: acc.type, debit: 0, credit: 0 };
      rows[acc.id].debit = r2(rows[acc.id].debit + (Number(l.debit) || 0));
      rows[acc.id].credit = r2(rows[acc.id].credit + (Number(l.credit) || 0));
    }
  }
  const list = Object.values(rows).sort((a, b) => a.code.localeCompare(b.code));
  res.json({
    rows: list,
    totals: {
      debit: r2(list.reduce((s, r) => s + r.debit, 0)),
      credit: r2(list.reduce((s, r) => s + r.credit, 0))
    }
  });
});

/* simple P&L from income/expense accounts */
router.get('/pnl', requirePerm('finance', 'view'), (req, res) => {
  let income = {}, expense = {};
  for (const j of store.find('journals', x => x.orgId === req.org.id && x.posted)) {
    for (const l of j.lines) {
      const acc = store.byId('accounts', l.accountId);
      if (!acc) continue;
      if (acc.type === 'income') income[acc.name] = r2((income[acc.name] || 0) + (Number(l.credit) || 0) - (Number(l.debit) || 0));
      if (acc.type === 'expense') expense[acc.name] = r2((expense[acc.name] || 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
    }
  }
  const totalIncome = r2(Object.values(income).reduce((s, v) => s + v, 0));
  const totalExpense = r2(Object.values(expense).reduce((s, v) => s + v, 0));
  res.json({
    income: Object.entries(income).map(([name, amount]) => ({ name, amount })),
    expense: Object.entries(expense).map(([name, amount]) => ({ name, amount })),
    totals: { income: totalIncome, expense: totalExpense, profit: r2(totalIncome - totalExpense) }
  });
});

module.exports = router;


/* ================= CUSTOMER ACCOUNTS ================= */
router.get('/customer-accounts', requirePerm('finance', 'view'), (req, res) => {
  const customers = store.find('customers', c => c.orgId === req.org.id);
  const invoices = store.find('invoices', i => i.orgId === req.org.id && i.status !== 'cancelled');
  const receipts = store.find('receipts', r => r.orgId === req.org.id);
  
  const accs = customers.map(c => {
    const custInvs = invoices.filter(i => i.customerId === c.id);
    const totalBilled = custInvs.reduce((sum, i) => sum + (i.totals?.grandTotal || 0), 0);
    const totalPaid = receipts.filter(r => r.customerId === c.id).reduce((sum, r) => sum + (r.amount || 0), 0);
    return {
      id: c.id, name: c.name, stateCode: c.stateCode,
      totalBilled: r2(totalBilled),
      totalPaid: r2(totalPaid),
      outstanding: Math.max(0, r2(totalBilled - totalPaid))
    };
  });
  
  const recurring = store.find('customerRecurring', r => r.orgId === req.org.id && r.status === 'active');
  const totals = {
    receivables: accs.reduce((sum, a) => sum + a.outstanding, 0),
    received: accs.reduce((sum, a) => sum + a.totalPaid, 0),
    recurringCount: recurring.length
  };
  
  res.json({ customers: accs, totals });
});

router.get('/customer-accounts/:id', requirePerm('finance', 'view'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  
  const custInvs = store.find('invoices', i => i.orgId === req.org.id && i.customerId === c.id && i.status !== 'cancelled');
  const payments = store.find('receipts', r => r.orgId === req.org.id && r.customerId === c.id);
  const totalBilled = custInvs.reduce((sum, i) => sum + (i.totals?.grandTotal || 0), 0);
  const totalPaid = payments.reduce((sum, r) => sum + (r.amount || 0), 0);
  
  const summary = {
    billed: r2(totalBilled),
    paid: r2(totalPaid),
    outstanding: Math.max(0, r2(totalBilled - totalPaid))
  };
  
  // Collect all sales documents related to this customer (Quotations, SOs, Invoices, Receipts)
  const qIds = store.find('quotations', q => q.orgId === req.org.id && q.customerId === c.id).map(q => q.id);
  const soIds = store.find('salesOrders', s => s.orgId === req.org.id && s.customerId === c.id).map(s => s.id);
  const invIds = custInvs.map(i => i.id);
  const recIds = payments.map(r => r.id);
  
  let documents = store.find('salesDocuments', d => d.orgId === req.org.id);
  documents = documents.filter(d => 
    (d.entityType === 'customer' && d.entityId === c.id) ||
    (d.entityType === 'quotation' && qIds.includes(d.entityId)) ||
    (d.entityType === 'salesOrder' && soIds.includes(d.entityId)) ||
    (d.entityType === 'invoice' && invIds.includes(d.entityId)) ||
    (d.entityType === 'receipt' && recIds.includes(d.entityId))
  ).map(d => {
    // Add entityRef for display
    let ref = '';
    if (d.entityType === 'quotation') ref = store.byId('quotations', d.entityId)?.number;
    if (d.entityType === 'salesOrder') ref = store.byId('salesOrders', d.entityId)?.number;
    if (d.entityType === 'invoice') ref = store.byId('invoices', d.entityId)?.number;
    if (d.entityType === 'receipt') ref = store.byId('receipts', d.entityId)?.number;
    return { ...d, entityRef: ref };
  });
  
  const recurring = store.find('customerRecurring', r => r.orgId === req.org.id && r.customerId === c.id);
  
  res.json({ customer: c, summary, payments, documents, recurring });
});

router.post('/customer-accounts/:id/recurring', requirePerm('finance', 'edit'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body;
  const rec = store.insert('customerRecurring', {
    orgId: req.org.id, customerId: c.id,
    description: b.description, frequency: b.frequency,
    amount: Number(b.amount), startDate: b.startDate,
    nextDueDate: b.startDate, status: 'active'
  });
  res.json({ recurring: rec });
});

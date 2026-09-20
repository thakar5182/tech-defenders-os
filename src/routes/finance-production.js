'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, nextNumber, r2 } = require('../util');
const { assertOpen, cleanDate } = require('../services/finance-periods');
const router = express.Router();
router.use(requireAuth);

const clean = (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max);
const rowsFor = orgId => store.find('financialPeriods', row => row.orgId === orgId).sort((a, b) => b.startDate.localeCompare(a.startDate));
const journalsUntil = (orgId, endDate) => store.find('journals', row => row.orgId === orgId && row.posted && (!endDate || row.date <= endDate));

function statement(orgId, endDate) {
  const map = new Map(store.find('accounts', row => row.orgId === orgId).map(row => [row.id, { ...row, debit: 0, credit: 0, balance: 0 }]));
  journalsUntil(orgId, endDate).forEach(journal => (journal.lines || []).forEach(line => {
    const row = map.get(line.accountId); if (!row) return;
    row.debit = r2(row.debit + (Number(line.debit) || 0)); row.credit = r2(row.credit + (Number(line.credit) || 0)); row.balance = r2(row.debit - row.credit);
  }));
  const rows = [...map.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const assets = r2(rows.filter(row => row.type === 'asset').reduce((sum, row) => sum + row.balance, 0));
  const liabilities = r2(rows.filter(row => row.type === 'liability').reduce((sum, row) => sum - row.balance, 0));
  const equity = r2(rows.filter(row => row.type === 'equity').reduce((sum, row) => sum - row.balance, 0));
  const income = r2(rows.filter(row => row.type === 'income').reduce((sum, row) => sum + row.credit - row.debit, 0));
  const expense = r2(rows.filter(row => row.type === 'expense').reduce((sum, row) => sum + row.debit - row.credit, 0));
  const profit = r2(income - expense), difference = r2(assets - liabilities - equity - profit);
  return { rows, totals: { debit: r2(rows.reduce((s, r) => s + r.debit, 0)), credit: r2(rows.reduce((s, r) => s + r.credit, 0)), assets, liabilities, equity, income, expense, profit, difference }, verified: Math.abs(difference) < 0.01 };
}

router.get('/dashboard', requirePerm('finance', 'view'), (req, res) => {
  const periods = rowsFor(req.org.id), latestVerification = store.find('financialVerifications', row => row.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  res.json({ periods, openingBalances: store.find('openingBalances', row => row.orgId === req.org.id).slice(-100), adjustments: store.find('accountingAdjustments', row => row.orgId === req.org.id).slice(-100).reverse(), tdsRecords: store.find('tdsRecords', row => row.orgId === req.org.id).slice(-100).reverse(), latestVerification, statement: statement(req.org.id) });
});

router.post('/periods', requirePerm('finance', 'approve'), (req, res) => {
  const startDate = cleanDate(req.body?.startDate), endDate = cleanDate(req.body?.endDate), name = clean(req.body?.name, 80);
  if (!name || !startDate || !endDate || endDate < startDate) return res.status(400).json({ error: 'Name and a valid date range are required' });
  if (store.findOne('financialPeriods', row => row.orgId === req.org.id && row.status !== 'void' && row.startDate <= endDate && row.endDate >= startDate)) return res.status(409).json({ error: 'Financial period overlaps an existing period' });
  const period = store.insert('financialPeriods', { orgId: req.org.id, name, startDate, endDate, status: 'open', createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'financial_period', period.id, { name, startDate, endDate }); res.status(201).json({ period });
});

router.post('/periods/:id/status', requirePerm('finance', 'approve'), (req, res) => {
  const period = store.findOne('financialPeriods', row => row.id === req.params.id && row.orgId === req.org.id), status = clean(req.body?.status, 20);
  if (!period || !['open', 'locked', 'closed'].includes(status)) return res.status(400).json({ error: 'Valid period and status are required' });
  if (status === 'closed') { const result = statement(req.org.id, period.endDate); if (!result.verified) return res.status(409).json({ error: 'Balance Sheet verification failed; period cannot be closed', totals: result.totals }); }
  const updated = store.update('financialPeriods', period.id, { status, statusChangedAt: new Date().toISOString(), statusChangedBy: req.user.id });
  audit(req.org.id, req.user.id, status, 'financial_period', period.id, { previousStatus: period.status }); res.json({ period: updated });
});

router.post('/opening-balances', requirePerm('finance', 'approve'), (req, res) => {
  const date = cleanDate(req.body?.date), lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!date || lines.length < 2) return res.status(400).json({ error: 'Date and at least two opening balance lines are required' });
  assertOpen(req.org.id, date);
  const normalized = lines.filter(row => row.accountId).map(row => ({ accountId: row.accountId, debit: r2(Number(row.debit) || 0), credit: r2(Number(row.credit) || 0) }));
  if (normalized.some(row => !store.findOne('accounts', account => account.id === row.accountId && account.orgId === req.org.id))) return res.status(400).json({ error: 'Opening balance contains an invalid account' });
  const debit = r2(normalized.reduce((s, row) => s + row.debit, 0)), credit = r2(normalized.reduce((s, row) => s + row.credit, 0));
  if (debit !== credit) return res.status(400).json({ error: `Opening balances must balance (Dr ${debit} / Cr ${credit})` });
  const journal = store.insert('journals', { orgId: req.org.id, number: nextNumber(req.org.id, 'journal'), date, narration: clean(req.body?.narration, 300) || 'Opening balances', posted: true, refType: 'opening_balance', refId: null, lines: normalized });
  const openingBalance = store.insert('openingBalances', { orgId: req.org.id, date, journalId: journal.id, total: debit, createdBy: req.user.id });
  store.update('journals', journal.id, { refId: openingBalance.id }); audit(req.org.id, req.user.id, 'post', 'opening_balance', openingBalance.id, { journalId: journal.id, total: debit }); res.status(201).json({ openingBalance, journal });
});

router.post('/adjustments', requirePerm('finance', 'approve'), (req, res) => {
  const date = cleanDate(req.body?.date), amount = r2(Number(req.body?.amount) || 0), debitAccountId = clean(req.body?.debitAccountId, 80), creditAccountId = clean(req.body?.creditAccountId, 80);
  if (!date || amount <= 0 || debitAccountId === creditAccountId) return res.status(400).json({ error: 'Date, positive amount and different debit/credit accounts are required' });
  assertOpen(req.org.id, date);
  for (const id of [debitAccountId, creditAccountId]) if (!store.findOne('accounts', row => row.id === id && row.orgId === req.org.id)) return res.status(400).json({ error: 'Invalid adjustment account' });
  const adjustment = store.insert('accountingAdjustments', { orgId: req.org.id, number: nextNumber(req.org.id, 'adjustment'), date, kind: ['debit_note', 'credit_note', 'journal'].includes(req.body?.kind) ? req.body.kind : 'journal', amount, reason: clean(req.body?.reason, 500), status: 'posted', createdBy: req.user.id });
  const journal = store.insert('journals', { orgId: req.org.id, number: nextNumber(req.org.id, 'journal'), date, narration: `${adjustment.number} - ${adjustment.reason}`, posted: true, refType: 'accounting_adjustment', refId: adjustment.id, lines: [{ accountId: debitAccountId, debit: amount, credit: 0 }, { accountId: creditAccountId, debit: 0, credit: amount }] });
  const updated = store.update('accountingAdjustments', adjustment.id, { journalId: journal.id }); audit(req.org.id, req.user.id, 'post', 'accounting_adjustment', adjustment.id, { journalId: journal.id, amount }); res.status(201).json({ adjustment: updated, journal });
});

router.post('/tds', requirePerm('finance', 'create'), (req, res) => {
  const amount = r2(Number(req.body?.amount) || 0), rate = r2(Number(req.body?.rate) || 0), date = cleanDate(req.body?.date);
  if (!date || amount <= 0 || rate <= 0 || rate > 100 || !clean(req.body?.pan, 20)) return res.status(400).json({ error: 'Date, PAN, amount and valid TDS rate are required' });
  assertOpen(req.org.id, date);
  const record = store.insert('tdsRecords', { orgId: req.org.id, number: nextNumber(req.org.id, 'tds'), date, partyType: req.body?.partyType === 'customer' ? 'customer' : 'supplier', partyId: clean(req.body?.partyId, 80), partyName: clean(req.body?.partyName, 150), pan: clean(req.body?.pan, 20).toUpperCase(), section: clean(req.body?.section, 20), amount, rate, tdsAmount: r2(amount * rate / 100), status: 'pending', createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'tds_record', record.id, { number: record.number, tdsAmount: record.tdsAmount }); res.status(201).json({ record });
});

router.get('/gst/:period', requirePerm('finance', 'view'), (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.params.period) ? req.params.period : new Date().toISOString().slice(0, 7);
  const sales = store.find('invoices', row => row.orgId === req.org.id && String(row.date || '').startsWith(period) && row.status !== 'cancelled');
  const purchases = store.find('purchaseInvoices', row => row.orgId === req.org.id && String(row.date || '').startsWith(period) && row.status !== 'cancelled');
  const sum = (list, key) => r2(list.reduce((total, row) => total + (Number(row.totals?.[key]) || Number(row[key]) || 0), 0));
  const gstr1 = { invoices: sales.length, taxableValue: sum(sales, 'taxable'), cgst: sum(sales, 'cgst'), sgst: sum(sales, 'sgst'), igst: sum(sales, 'igst'), cess: sum(sales, 'cess'), total: sum(sales, 'grandTotal') };
  const input = { invoices: purchases.length, taxableValue: sum(purchases, 'taxable'), cgst: sum(purchases, 'cgst'), sgst: sum(purchases, 'sgst'), igst: sum(purchases, 'igst'), cess: sum(purchases, 'cess'), total: sum(purchases, 'grandTotal') };
  res.json({ period, gstr1, gstr3b: { outwardTaxable: gstr1.taxableValue, outputTax: r2(gstr1.cgst + gstr1.sgst + gstr1.igst + gstr1.cess), eligibleInputTax: r2(input.cgst + input.sgst + input.igst + input.cess), estimatedNetTax: r2(Math.max(0, gstr1.cgst + gstr1.sgst + gstr1.igst + gstr1.cess - input.cgst - input.sgst - input.igst - input.cess)) }, input });
});

router.post('/verify', requirePerm('finance', 'approve'), (req, res) => {
  const asOf = cleanDate(req.body?.asOf) || new Date().toISOString().slice(0, 10), result = statement(req.org.id, asOf);
  const verification = store.insert('financialVerifications', { orgId: req.org.id, asOf, verified: result.verified, totals: result.totals, createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'verify', 'financial_statements', verification.id, { asOf, verified: result.verified }); res.json({ verification, statement: result });
});

module.exports = router;

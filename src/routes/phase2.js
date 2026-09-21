'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, nextNumber } = require('../util');
const { assertOpen, cleanDate } = require('../services/finance-periods');
const engine = require('../services/phase2-finance');
const router = express.Router();
router.use(requireAuth);
const clean = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
router.get('/gst/:period', requirePerm('finance', 'view'), (req, res) => {
  try {
    const report = engine.gstReturn({ invoices: store.db.invoices, purchases: store.db.purchaseInvoices, orgId: req.org.id, period: req.params.period });
    const portal = store.findOne('gstPortalReturns', row => row.orgId === req.org.id && row.period === req.params.period);
    res.json({ report, reconciliation: portal ? engine.reconcileGst(report.outward, portal.outward || portal) : null });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
router.post('/gst/:period/portal', requirePerm('finance', 'approve'), (req, res) => {
  if (!/^\d{4}-\d{2}$/.test(req.params.period)) return res.status(400).json({ error: 'Period must use YYYY-MM format' });
  const outward = engine.summarizeRows([req.body?.outward || req.body || {}]);
  const existing = store.findOne('gstPortalReturns', row => row.orgId === req.org.id && row.period === req.params.period);
  const payload = { orgId: req.org.id, period: req.params.period, outward, source: clean(req.body?.source, 80) || 'GST portal', importedBy: req.user.id, importedAt: new Date().toISOString() };
  const portalReturn = existing ? store.update('gstPortalReturns', existing.id, payload) : store.insert('gstPortalReturns', payload);
  audit(req.org.id, req.user.id, 'reconcile', 'gst_return', portalReturn.id, { period: req.params.period }); res.json({ portalReturn });
});
router.post('/deductions', requirePerm('finance', 'create'), (req, res) => {
  try {
    const date = cleanDate(req.body?.date), kind = req.body?.kind;
    if (!date) return res.status(400).json({ error: 'Valid deduction date is required' });
    assertOpen(req.org.id, date);
    const pan = clean(req.body?.pan, 10).toUpperCase();
    if (!engine.validatePan(pan)) return res.status(400).json({ error: 'Valid PAN is required' });
    const calculation = engine.deduction({ kind, taxableAmount: req.body?.taxableAmount, rate: req.body?.rate, surcharge: req.body?.surcharge, cess: req.body?.cess });
    const record = store.insert('taxDeductions', { orgId: req.org.id, number: nextNumber(req.org.id, kind), date, partyId: clean(req.body?.partyId, 80), partyName: clean(req.body?.partyName, 150), pan, section: clean(req.body?.section, 20), status: 'pending', ...calculation, createdBy: req.user.id });
    audit(req.org.id, req.user.id, 'create', kind, record.id, { total: record.total }); res.status(201).json({ record });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
router.get('/deductions', requirePerm('finance', 'view'), (req, res) => {
  const records = store.find('taxDeductions', row => row.orgId === req.org.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json({ records, total: engine.money(records.reduce((sum, row) => sum + Number(row.total || 0), 0)) });
});
router.get('/reconciliation/:period', requirePerm('finance', 'view'), (req, res) => {
  try {
    const gst = engine.gstReturn({ invoices: store.db.invoices, purchases: store.db.purchaseInvoices, orgId: req.org.id, period: req.params.period });
    const portal = store.findOne('gstPortalReturns', row => row.orgId === req.org.id && row.period === req.params.period);
    const bank = store.find('bankTransactions', row => row.orgId === req.org.id && String(row.date || '').startsWith(req.params.period));
    res.json({ period: req.params.period, gst: portal ? engine.reconcileGst(gst.outward, portal.outward || portal) : { matched: false, reason: 'portal_return_missing' }, bank: { total: bank.length, matched: bank.filter(row => row.status === 'matched').length, unmatched: bank.filter(row => row.status !== 'matched') } });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
router.get('/inventory-valuation', requirePerm('inventory', 'view'), (req, res) => {
  const method = req.query.method || 'weighted_average', asOf = cleanDate(req.query.asOf), warehouseId = clean(req.query.warehouseId, 80) || null;
  try {
    const rows = store.find('products', row => row.orgId === req.org.id && row.type !== 'service').map(product => {
      const result = engine.valuation(store.find('stockLedger', row => row.orgId === req.org.id && row.productId === product.id), method, asOf, warehouseId);
      return { productId: product.id, sku: product.sku, name: product.name, ...result };
    });
    res.json({ method, asOf, warehouseId, rows, total: engine.money(rows.reduce((sum, row) => sum + row.value, 0)), negativeStock: rows.filter(row => row.negativeStock).map(row => row.productId) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/periods/:id/close', requirePerm('finance', 'approve'), (req, res) => {
  const period = store.findOne('financialPeriods', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!period || period.status === 'closed') return res.status(409).json({ error: 'Open or locked financial period not found' });
  const journals = store.find('journals', row => row.orgId === req.org.id && row.date >= period.startDate && row.date <= period.endDate);
  const journalIssues = engine.journalIssues(journals);
  const bankExceptions = store.find('bankTransactions', row => row.orgId === req.org.id && row.date >= period.startDate && row.date <= period.endDate && row.status !== 'matched').map(row => row.id);
  const negativeStock = store.find('products', row => row.orgId === req.org.id && row.type !== 'service').filter(product => engine.valuation(store.find('stockLedger', entry => entry.orgId === req.org.id && entry.productId === product.id), 'weighted_average', period.endDate).negativeStock).map(product => product.id);
  const blockers = { journalIssues, bankExceptions, negativeStock }, blockerCount = journalIssues.length + bankExceptions.length + negativeStock.length, overrideReason = clean(req.body?.overrideReason, 500);
  if (blockerCount && !overrideReason) return res.status(409).json({ error: 'Accounting close has unresolved exceptions', blockers });
  const snapshotBody = { orgId: req.org.id, periodId: period.id, startDate: period.startDate, endDate: period.endDate, blockerCount, blockers, journalCount: journals.length, closedAt: new Date().toISOString(), closedBy: req.user.id, overrideReason: overrideReason || null };
  const snapshot = store.insert('accountingCloseSnapshots', { ...snapshotBody, digest: engine.closingDigest(snapshotBody) });
  const closed = store.update('financialPeriods', period.id, { status: 'closed', closedAt: snapshot.closedAt, closedBy: req.user.id, closeSnapshotId: snapshot.id });
  audit(req.org.id, req.user.id, 'close', 'financial_period', period.id, { snapshotId: snapshot.id, blockerCount }); res.json({ period: closed, snapshot });
});
module.exports = router;

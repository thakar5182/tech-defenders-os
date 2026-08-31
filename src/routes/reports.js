/**
 * Reports routes - every figure is aggregated from live records:
 *   sales by month, receivable aging buckets, stock valuation,
 *   lead funnel conversion, top customers, ticket summary.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2 } = require('../util');

const router = express.Router();
router.use(requirePerm('reports', 'view'));

function monthKey(d) { return String(d).slice(0, 7); }

/* sales by month (last 12) */
router.get('/sales-by-month', (req, res) => {
  const orgId = req.org.id;
  const buckets = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    buckets[monthKey(d.toISOString())] = { invoiced: 0, collected: 0 };
  }
  for (const inv of store.find('invoices', i => i.orgId === orgId && !['cancelled', 'credited'].includes(i.status))) {
    const k = monthKey(inv.date || inv.createdAt);
    if (buckets[k]) buckets[k].invoiced = r2(buckets[k].invoiced + (inv.totals?.grandTotal || 0));
  }
  for (const rc of store.find('receipts', x => x.orgId === orgId)) {
    const k = monthKey(rc.date || rc.createdAt);
    if (buckets[k]) buckets[k].collected = r2(buckets[k].collected + (rc.amount || 0));
  }
  res.json({ rows: Object.entries(buckets).map(([month, v]) => ({ month, ...v })) });
});

/* receivable aging: current, 1-30, 31-60, 61-90, 90+ */
router.get('/receivable-aging', (req, res) => {
  const today = new Date();
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  const details = [];
  for (const inv of store.find('invoices', i => i.orgId === req.org.id && !['cancelled', 'credited', 'paid'].includes(i.status))) {
    const due = r2((inv.totals?.grandTotal || 0) - (inv.paidAmount || 0));
    if (due <= 0) continue;
    const daysLate = inv.dueDate ? Math.floor((today - new Date(inv.dueDate)) / 86400000) : 0;
    if (daysLate <= 0) buckets.current = r2(buckets.current + due);
    else if (daysLate <= 30) buckets.d30 = r2(buckets.d30 + due);
    else if (daysLate <= 60) buckets.d60 = r2(buckets.d60 + due);
    else if (daysLate <= 90) buckets.d90 = r2(buckets.d90 + due);
    else buckets.d90plus = r2(buckets.d90plus + due);
    if (daysLate > 0) {
      details.push({
        number: inv.number,
        customerName: (store.byId('customers', inv.customerId) || {}).name || '-',
        dueDate: inv.dueDate, daysLate, balance: due
      });
    }
  }
  res.json({ buckets, overdueDetails: details.sort((a, b) => b.daysLate - a.daysLate).slice(0, 50) });
});

/* stock valuation from ledger balances at purchase price */
router.get('/stock-valuation', (req, res) => {
  const rows = [];
  let totalValue = 0;
  for (const p of store.find('products', x => x.orgId === req.org.id && x.type !== 'service')) {
    const bal = r2(store.find('stockLedger', e => e.orgId === req.org.id && e.productId === p.id)
      .reduce((s, e) => s + (Number(e.qty) || 0), 0));
    if (bal > 0) {
      const value = r2(bal * (Number(p.purchasePrice) || 0));
      totalValue += value;
      rows.push({ sku: p.sku, name: p.name, uom: p.uom, qty: bal, unitCost: p.purchasePrice, value });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  res.json({ rows, totalValue: r2(totalValue) });
});

/* lead funnel with conversion rate */
router.get('/lead-funnel', (req, res) => {
  const leads = store.find('leads', l => l.orgId === req.org.id);
  const stages = ['new', 'contacted', 'qualified', 'converted', 'lost'];
  const counts = {};
  for (const s of stages) counts[s] = leads.filter(l => l.status === s).length;
  const bySource = {};
  for (const l of leads) bySource[l.source || 'manual'] = (bySource[l.source || 'manual'] || 0) + 1;
  const converted = counts.converted || 0;
  const closed = converted + (counts.lost || 0);
  res.json({
    counts, bySource,
    conversionRate: closed ? r2(converted / closed * 100) : 0
  });
});

/* top customers by billed value */
router.get('/top-customers', (req, res) => {
  const map = {};
  for (const inv of store.find('invoices', i => i.orgId === req.org.id && !['cancelled', 'credited'].includes(i.status))) {
    map[inv.customerId] = r2((map[inv.customerId] || 0) + (inv.totals?.grandTotal || 0));
  }
  const rows = Object.entries(map)
    .map(([customerId, billed]) => ({
      customerName: (store.byId('customers', customerId) || {}).name || '?',
      billed
    }))
    .sort((a, b) => b.billed - a.billed)
    .slice(0, 10);
  res.json({ rows });
});

/* service desk summary */
router.get('/ticket-summary', (req, res) => {
  const tickets = store.find('tickets', t => t.orgId === req.org.id);
  const byStatus = {};
  for (const t of tickets) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  let breached = 0, resolvedInSla = 0, resolved = 0;
  for (const t of tickets) {
    const slaDue = new Date(new Date(t.createdAt).getTime() + (Number(t.slaHours) || 24) * 3600000);
    if (t.resolvedAt) {
      resolved++;
      if (new Date(t.resolvedAt) <= slaDue) resolvedInSla++;
    } else if (slaDue < new Date()) breached++;
  }
  res.json({
    total: tickets.length, byStatus, breached,
    slaCompliance: resolved ? r2(resolvedInSla / resolved * 100) : null
  });
});

module.exports = router;

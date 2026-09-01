/**
 * Dashboard KPIs, global search and notification centre.
 * All numbers are computed from real records - nothing hard-coded.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requireModule } = require('../middleware');
const { r2, can, effectiveDashboardWidgets } = require('../util');

const router = express.Router();
router.use(requireAuth);

function monthKey(d) { return String(d).slice(0, 7); }

router.get('/summary', requireModule('dashboard'), (req, res) => {
  const orgId = req.org.id;
  const today = new Date().toISOString().slice(0, 10);
  const access = Object.fromEntries(['crm', 'sales', 'purchase', 'inventory', 'service', 'reports']
    .map(mod => [mod, can(req.user, mod, 'view')]));
  const widgets = effectiveDashboardWidgets(req.user);

  const leads = access.crm ? store.find('leads', l => l.orgId === orgId) : [];
  const deals = access.crm ? store.find('deals', d => d.orgId === orgId) : [];
  const tasks = access.crm ? store.find('tasks', t => t.orgId === orgId) : [];
  const invoices = access.sales ? store.find('invoices', i => i.orgId === orgId && !['cancelled', 'credited'].includes(i.status)) : [];
  const products = access.inventory ? store.find('products', p => p.orgId === orgId && p.type !== 'service') : [];
  const tickets = access.service ? store.find('tickets', t => t.orgId === orgId) : [];
  const receipts = access.sales ? store.find('receipts', r => r.orgId === orgId) : [];
  const pos = access.purchase ? store.find('purchaseOrders', p => p.orgId === orgId) : [];

  /* follow-ups due today or overdue */
  const dueTasks = tasks.filter(t => t.status === 'open' && t.dueDate && t.dueDate <= today);
  const overdueTasks = tasks.filter(t => t.status === 'open' && t.dueDate && t.dueDate < today);

  /* pipeline */
  const openDeals = deals.filter(d => !['won', 'lost'].includes(d.stage));
  const pipelineValue = r2(openDeals.reduce((s, d) => s + (Number(d.value) || 0), 0));
  const weightedForecast = r2(openDeals.reduce((s, d) => s + (Number(d.value) || 0) * ((Number(d.probability) || 0) / 100), 0));

  /* receivables */
  let outstanding = 0, overdueAmount = 0;
  for (const inv of invoices) {
    const due = r2((Number(inv.totals?.grandTotal) || 0) - (Number(inv.paidAmount) || 0));
    if (due > 0) {
      outstanding += due;
      if (inv.dueDate && inv.dueDate < today) overdueAmount += due;
    }
  }
  outstanding = r2(outstanding); overdueAmount = r2(overdueAmount);

  /* low stock: balance <= minStock */
  const lowStock = [];
  for (const p of products) {
    const bal = r2(store.find('stockLedger', e => e.orgId === orgId && e.productId === p.id)
      .reduce((s, e) => s + (Number(e.qty) || 0), 0));
    if (bal <= (Number(p.minStock) || 0)) lowStock.push({ id: p.id, sku: p.sku, name: p.name, balance: bal, minStock: p.minStock });
  }

  /* sales trend last 6 months from invoices */
  const trend = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    trend[monthKey(d.toISOString())] = 0;
  }
  for (const inv of invoices) {
    const k = monthKey(inv.date || inv.createdAt);
    if (k in trend) trend[k] += Number(inv.totals?.grandTotal) || 0;
  }

  /* lead funnel */
  const funnel = {};
  for (const s of ['new', 'contacted', 'qualified', 'converted', 'lost']) {
    funnel[s] = leads.filter(l => l.status === s).length;
  }

  res.json({
    access,
    widgets,
    kpis: {
      openLeads: widgets.crmOverview ? leads.filter(l => !['converted', 'lost'].includes(l.status)).length : null,
      pipelineValue: widgets.crmOverview ? pipelineValue : null,
      weightedForecast: widgets.crmOverview ? weightedForecast : null,
      dueToday: widgets.followUps ? dueTasks.length : null,
      overdueTasks: widgets.followUps ? overdueTasks.length : null,
      outstandingReceivable: widgets.receivables ? outstanding : null,
      overdueReceivable: widgets.receivables ? overdueAmount : null,
      lowStockCount: widgets.inventoryAlerts ? lowStock.length : null,
      openTickets: widgets.serviceLoad ? tickets.filter(t => !['resolved', 'closed'].includes(t.status)).length : null,
      pendingPOs: widgets.purchaseStatus ? pos.filter(p => ['draft', 'sent', 'partial'].includes(p.status)).length : null,
      collectedThisMonth: widgets.salesMonthly
        ? r2(receipts.filter(r => monthKey(r.date || r.createdAt) === monthKey(today))
          .reduce((s, r) => s + (Number(r.amount) || 0), 0))
        : null,
      invoicedThisMonth: widgets.salesMonthly ? r2(invoices.filter(i => monthKey(i.date || i.createdAt) === monthKey(today))
        .reduce((s, i) => s + (Number(i.totals?.grandTotal) || 0), 0)) : null
    },
    salesTrend: widgets.salesTrend ? Object.entries(trend).map(([month, total]) => ({ month, total: r2(total) })) : [],
    leadFunnel: widgets.leadFunnel ? funnel : {},
    lowStock: widgets.inventoryAlerts ? lowStock.slice(0, 8) : [],
    dueTasksList: widgets.followUps ? dueTasks.slice(0, 8).map(t => ({
      id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority,
      assignee: (store.byId('users', t.assignee) || {}).name || 'Unassigned'
    })) : [],
    recentActivity: widgets.recentActivity ? store.find('activities', a => a.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10)
      : []
  });
});

/* ---------------- global search ---------------- */
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const orgId = req.org.id;
  const like = s => String(s || '').toLowerCase().includes(q);
  const results = [];

  if (can(req.user, 'crm', 'view')) for (const c of store.find('customers', x => x.orgId === orgId)) {
    if (like(c.name) || like(c.email) || like(c.phone)) results.push({ type: 'Customer', label: c.name, sub: c.company ? '' : c.email, link: '#/crm/customers/' + c.id });
  }
  if (can(req.user, 'crm', 'view')) for (const l of store.find('leads', x => x.orgId === orgId)) {
    if (like(l.name) || like(l.company) || like(l.email)) results.push({ type: 'Lead', label: l.name, sub: l.company, link: '#/crm/leads' });
  }
  if (can(req.user, 'inventory', 'view')) for (const p of store.find('products', x => x.orgId === orgId)) {
    if (like(p.name) || like(p.sku)) results.push({ type: 'Product', label: `${p.name} (${p.sku})`, sub: p.category, link: '#/inventory/products' });
  }
  if (can(req.user, 'sales', 'view')) for (const d of store.find('quotations', x => x.orgId === orgId)) {
    if (like(d.number)) results.push({ type: 'Quotation', label: d.number, sub: d.status, link: '#/sales/quotations' });
  }
  if (can(req.user, 'sales', 'view')) for (const d of store.find('invoices', x => x.orgId === orgId)) {
    if (like(d.number)) results.push({ type: 'Invoice', label: d.number, sub: d.status, link: '#/print/invoice/' + d.id });
  }
  if (can(req.user, 'service', 'view')) for (const d of store.find('tickets', x => x.orgId === orgId)) {
    if (like(d.number) || like(d.subject)) results.push({ type: 'Ticket', label: `${d.number} - ${d.subject}`, sub: d.status, link: '#/service/tickets' });
  }
  res.json({ results: results.slice(0, 12) });
});

/* ---------------- notifications ---------------- */
router.get('/notifications', (req, res) => {
  const list = store.find('notifications', n =>
    n.orgId === req.org.id && (!n.userId || n.userId === req.user.id)
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  const withReadState = list.map(n => ({
    ...n,
    read: n.read === true || (n.readBy || []).includes(req.user.id)
  }));
  res.json({ notifications: withReadState, unread: withReadState.filter(n => !n.read).length });
});
router.post('/notifications/read', (req, res) => {
  for (const n of store.find('notifications', n =>
    n.orgId === req.org.id && (!n.userId || n.userId === req.user.id))) {
    const readBy = [...new Set([...(n.readBy || []), req.user.id])];
    store.update('notifications', n.id, { readBy });
  }
  res.json({ message: 'All marked as read' });
});

module.exports = router;

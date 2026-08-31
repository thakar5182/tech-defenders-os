/**
 * Manufacturing routes - Plan-to-Produce:
 *   BOM (multi-line, cost roll-up) -> Job Order -> material issue
 *   -> production output / rejection / wastage -> finished stock.
 * All stock effects go through the perpetual ledger.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, nextNumber, audit, notify, postStock } = require('../util');

const router = express.Router();
router.use(requireAuth);

function balance(orgId, productId, warehouseId) {
  return r2(store.find('stockLedger', e => e.orgId === orgId && e.productId === productId && (!warehouseId || e.warehouseId === warehouseId))
    .reduce((s, e) => s + (Number(e.qty) || 0), 0));
}

/* ================= BOM ================= */
router.get('/boms', requirePerm('manufacturing', 'view'), (req, res) => {
  const list = store.find('boms', b => b.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(b => ({
      ...b,
      outputName: (store.byId('products', b.outputProductId) || {}).name || '?',
      materialCost: r2((b.lines || []).reduce((s, l) => {
        const p = store.byId('products', l.productId);
        return s + (p ? p.purchasePrice * l.qty * (1 + (l.scrapPct || 0) / 100) : 0);
      }, 0))
    }));
  res.json({ boms: list });
});

router.post('/boms', requirePerm('manufacturing', 'create'), (req, res) => {
  const b = req.body || {};
  const output = store.findOne('products', p => p.id === b.outputProductId && p.orgId === req.org.id);
  if (!output) return res.status(400).json({ error: 'Valid output product is required' });
  const lines = (b.lines || []).filter(l => l.productId && Number(l.qty) > 0)
    .map(l => ({ productId: l.productId, qty: Number(l.qty), scrapPct: Number(l.scrapPct) || 0 }));
  if (!lines.length) return res.status(400).json({ error: 'At least one component line is required' });
  if (Number(b.outputQty) <= 0) return res.status(400).json({ error: 'Output quantity must be positive' });
  for (const line of lines) {
    const component = store.findOne('products', p => p.id === line.productId && p.orgId === req.org.id);
    if (!component) return res.status(400).json({ error: 'Every BOM component must belong to this organization' });
    if (component.id === output.id) return res.status(400).json({ error: 'Output product cannot also be its own component' });
    if (line.scrapPct < 0) return res.status(400).json({ error: 'Scrap percentage cannot be negative' });
  }
  const bom = store.insert('boms', {
    orgId: req.org.id, code: b.code || ('BOM-' + output.sku),
    outputProductId: output.id, outputQty: Number(b.outputQty) || 1,
    revision: String(b.revision || 'A'), status: 'active',
    lines,
    laborCostPerUnit: Number(b.laborCostPerUnit) || 0,
    overheadPerUnit: Number(b.overheadPerUnit) || 0
  });
  audit(req.org.id, req.user.id, 'create', 'bom', bom.id, { code: bom.code });
  res.json({ bom });
});

/* full cost roll-up for one unit of output */
router.get('/boms/:id/cost', requirePerm('manufacturing', 'view'), (req, res) => {
  const bom = store.findOne('boms', b => b.id === req.params.id && b.orgId === req.org.id);
  if (!bom) return res.status(404).json({ error: 'BOM not found' });
  let material = 0;
  const detail = bom.lines.map(l => {
    const p = store.byId('products', l.productId);
    const cost = r2((p ? p.purchasePrice : 0) * l.qty * (1 + (l.scrapPct || 0) / 100));
    material += cost;
    return { component: p ? p.name : '?', qty: l.qty, uom: p ? p.uom : '', unitCost: p ? p.purchasePrice : 0, scrapPct: l.scrapPct, cost };
  });
  const perOutput = Math.max(1, Number(bom.outputQty) || 1);
  const labor = r2(bom.laborCostPerUnit * perOutput);
  const overhead = r2(bom.overheadPerUnit * perOutput);
  res.json({
    detail,
    totals: {
      material: r2(material), labor, overhead,
      total: r2(material + labor + overhead),
      perUnit: r2((material + labor + overhead) / perOutput),
      outputQty: perOutput
    }
  });
});

/* ================= JOB ORDERS ================= */
router.get('/job-orders', requirePerm('manufacturing', 'view'), (req, res) => {
  const list = store.find('jobOrders', j => j.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(j => ({
      ...j,
      bomCode: (store.byId('boms', j.bomId) || {}).code || '-',
      outputName: (() => {
        const bom = store.byId('boms', j.bomId);
        return bom ? ((store.byId('products', bom.outputProductId) || {}).name || '?') : '-';
      })()
    }));
  res.json({ jobOrders: list });
});

router.post('/job-orders', requirePerm('manufacturing', 'create'), (req, res) => {
  const b = req.body || {};
  const bom = store.findOne('boms', x => x.id === b.bomId && x.orgId === req.org.id);
  if (!bom) return res.status(400).json({ error: 'Valid BOM is required' });
  const plannedQty = Number(b.plannedQty);
  if (!plannedQty || plannedQty <= 0) return res.status(400).json({ error: 'Planned quantity must be positive' });
  const job = store.insert('jobOrders', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'jobOrder'),
    bomId: bom.id, plannedQty,
    dueDate: b.dueDate || null, priority: b.priority || 'normal',
    status: 'planned',
    issues: [], outputs: [], salesOrderId: b.salesOrderId || null
  });
  audit(req.org.id, req.user.id, 'create', 'job_order', job.id, { number: job.number });
  res.json({ jobOrder: job });
});

router.post('/job-orders/:id/release', requirePerm('manufacturing', 'edit'), (req, res) => {
  const job = store.findOne('jobOrders', j => j.id === req.params.id && j.orgId === req.org.id);
  if (!job) return res.status(404).json({ error: 'Job order not found' });
  if (job.status !== 'planned') return res.status(400).json({ error: 'Only planned jobs can be released' });
  const updated = store.update('jobOrders', job.id, { status: 'released', releasedAt: new Date().toISOString() });
  audit(req.org.id, req.user.id, 'release', 'job_order', job.id);
  res.json({ jobOrder: updated });
});

/* issue raw materials to the shop floor (negative ledger events) */
router.post('/job-orders/:id/issue-material', requirePerm('inventory', 'edit'), (req, res) => {
  const job = store.findOne('jobOrders', j => j.id === req.params.id && j.orgId === req.org.id);
  if (!job) return res.status(404).json({ error: 'Job order not found' });
  if (!['released', 'in_progress'].includes(job.status)) return res.status(400).json({ error: 'Job must be released before issuing material' });

  const wh = req.body.warehouseId
    ? store.findOne('warehouses', w => w.id === req.body.warehouseId && w.orgId === req.org.id)
    : store.findOne('warehouses', w => w.orgId === req.org.id);
  if (!wh) return res.status(400).json({ error: 'No warehouse available' });

  const issuePlan = [];
  const bom = store.findOne('boms', b => b.id === job.bomId && b.orgId === req.org.id);
  if (!bom) return res.status(400).json({ error: 'Job BOM is no longer valid' });
  const allowedComponents = new Set((bom.lines || []).map(line => line.productId));
  for (const il of (req.body.lines || [])) {
    const comp = store.findOne('products', p => p.id === il.productId && p.orgId === req.org.id);
    if (!comp) return res.status(400).json({ error: 'Invalid component in material issue' });
    if (!allowedComponents.has(comp.id)) return res.status(400).json({ error: `${comp.name} is not a component of this BOM` });
    const qty = Number(il.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Issue quantities must be positive' });
    const planned = issuePlan.filter(x => x.comp.id === comp.id).reduce((sum, x) => sum + x.qty, 0);
    const current = balance(req.org.id, comp.id, wh.id);
    if (current < planned + qty && !req.org.allowNegativeStock) {
      return res.status(400).json({ error: `Insufficient stock of ${comp.name}. Available: ${current}` });
    }
    issuePlan.push({ comp, qty });
  }
  if (!issuePlan.length) return res.status(400).json({ error: 'No valid issue lines provided' });

  const issued = [];
  for (const { comp, qty } of issuePlan) {
    postStock({
      orgId: req.org.id, productId: comp.id, warehouseId: wh.id,
      type: 'production_issue', qty: -qty, rate: comp.purchasePrice,
      refType: 'job_order', refNumber: job.number, note: 'Material issue'
    });
    issued.push({ productId: comp.id, name: comp.name, qty, at: new Date().toISOString() });
  }
  job.issues.push(...issued);
  const updated = store.update('jobOrders', job.id, { issues: job.issues, status: 'in_progress' });
  audit(req.org.id, req.user.id, 'issue_material', 'job_order', job.id, { items: issued.length });
  res.json({ jobOrder: updated });
});

/* record production output: good qty into finished stock, rejected/wastage tracked */
router.post('/job-orders/:id/record-output', requirePerm('manufacturing', 'edit'), (req, res) => {
  const job = store.findOne('jobOrders', j => j.id === req.params.id && j.orgId === req.org.id);
  if (!job) return res.status(404).json({ error: 'Job order not found' });
  if (!['in_progress'].includes(job.status)) return res.status(400).json({ error: 'Job must be in progress to record output' });

  const goodQty = Number(req.body.goodQty) || 0;
  const rejectedQty = Number(req.body.rejectedQty) || 0;
  if (goodQty < 0 || rejectedQty < 0) return res.status(400).json({ error: 'Good and rejected quantities cannot be negative' });
  if (goodQty <= 0 && rejectedQty <= 0) return res.status(400).json({ error: 'Record some output or rejection first' });

  const totalProduced = job.outputs.reduce((s, o) => s + o.goodQty + o.rejectedQty, 0);
  if (totalProduced + goodQty + rejectedQty > job.plannedQty) {
    return res.status(400).json({ error: `Output exceeds planned quantity (${job.plannedQty})` });
  }

  const bom = store.findOne('boms', b => b.id === job.bomId && b.orgId === req.org.id);
  const product = bom ? store.findOne('products', p => p.id === bom.outputProductId && p.orgId === req.org.id) : null;
  const wh = req.body.warehouseId
    ? store.findOne('warehouses', w => w.id === req.body.warehouseId && w.orgId === req.org.id)
    : store.findOne('warehouses', w => w.orgId === req.org.id);
  if (goodQty > 0 && (!product || !wh)) return res.status(400).json({ error: 'A valid output product and warehouse are required' });

  if (goodQty > 0 && product && wh) {
    /* value output at BOM cost per unit when available */
    let unitCost = product.purchasePrice;
    if (bom) {
      let mat = 0;
      for (const l of bom.lines) {
        const p = store.byId('products', l.productId);
        mat += (p ? p.purchasePrice : 0) * l.qty * (1 + (l.scrapPct || 0) / 100);
      }
      const perOut = Math.max(1, bom.outputQty);
      unitCost = r2((mat + bom.laborCostPerUnit * perOut + bom.overheadPerUnit * perOut) / perOut);
    }
    postStock({
      orgId: req.org.id, productId: product.id, warehouseId: wh.id,
      type: 'production_in', qty: goodQty, rate: unitCost,
      refType: 'job_order', refNumber: job.number, note: 'Production receipt'
    });
  }
  /* Rejected output is tracked on the job only. It never entered finished stock,
     so posting a negative finished-goods movement would corrupt the balance. */

  job.outputs.push({
    goodQty, rejectedQty,
    date: new Date().toISOString().slice(0, 10),
    by: req.user.name
  });
  const producedAll = job.outputs.reduce((s, o) => s + o.goodQty + o.rejectedQty, 0) >= job.plannedQty;
  const updated = store.update('jobOrders', job.id, {
    outputs: job.outputs,
    status: producedAll ? 'completed' : 'in_progress'
  });
  audit(req.org.id, req.user.id, 'record_output', 'job_order', job.id, { goodQty, rejectedQty });
  notify(req.org.id, { title: 'Production output recorded', body: `${job.number}: ${goodQty} good, ${rejectedQty} rejected`, type: 'success', link: '#/manufacturing/jobs' });
  res.json({ jobOrder: updated });
});

router.post('/job-orders/:id/close', requirePerm('manufacturing', 'edit'), (req, res) => {
  const job = store.findOne('jobOrders', j => j.id === req.params.id && j.orgId === req.org.id);
  if (!job) return res.status(404).json({ error: 'Job order not found' });
  if (!['completed', 'in_progress'].includes(job.status)) return res.status(400).json({ error: 'Job cannot be closed from status ' + job.status });
  const updated = store.update('jobOrders', job.id, { status: 'closed', closedAt: new Date().toISOString() });
  audit(req.org.id, req.user.id, 'close', 'job_order', job.id);
  res.json({ jobOrder: updated });
});

module.exports = router;

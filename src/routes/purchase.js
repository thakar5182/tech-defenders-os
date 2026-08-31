/**
 * Purchase routes - Procure-to-Pay chain:
 *   Requisition -> approval -> RFQ (multi-vendor quotes) -> comparison
 *   -> Purchase Order(s) -> GRN (QC split accepted/rejected)
 *   -> stock posting for accepted qty -> payable journal.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, nextNumber, audit, notify, postStock } = require('../util');

const router = express.Router();
router.use(requireAuth);

/* ================= PURCHASE REQUISITIONS ================= */
router.get('/requisitions', requirePerm('purchase', 'view'), (req, res) => {
  const list = store.find('requisitions', r => r.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({ ...r, requestedByName: (store.byId('users', r.requestedBy) || {}).name || '-' }));
  res.json({ requisitions: list });
});

router.post('/requisitions', requirePerm('purchase', 'create'), (req, res) => {
  const b = req.body || {};
  const lines = (b.lines || []).filter(l => l.description && Number(l.qty) > 0);
  if (!lines.length) return res.status(400).json({ error: 'At least one line with description and quantity is required' });
  const pr = store.insert('requisitions', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'requisition'),
    requestedBy: req.user.id, department: b.department || '',
    requiredBy: b.requiredBy || null, priority: b.priority || 'normal',
    status: 'pending_approval',
    lines: lines.map(l => ({ description: l.description, qty: Number(l.qty), estRate: Number(l.estRate) || 0 })),
    approvals: [], reason: b.reason || ''
  });
  notify(req.org.id, { title: 'Purchase requisition awaiting approval', body: `${pr.number} submitted by ${req.user.name}`, type: 'info', link: '#/purchase/requisitions' });
  audit(req.org.id, req.user.id, 'create', 'requisition', pr.id, { number: pr.number });
  res.json({ requisition: pr });
});

router.post('/requisitions/:id/approve', requirePerm('purchase', 'approve'), (req, res) => {
  const pr = store.findOne('requisitions', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!pr) return res.status(404).json({ error: 'Requisition not found' });
  if (pr.status !== 'pending_approval') return res.status(400).json({ error: 'Requisition is not pending approval' });
  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  if (decision === 'rejected' && !req.body.comment) {
    return res.status(400).json({ error: 'A comment is required when rejecting' });
  }
  pr.approvals.push({
    userId: req.user.id, name: req.user.name,
    decision, comment: req.body.comment || '', at: new Date().toISOString()
  });
  const updated = store.update('requisitions', pr.id, {
    approvals: pr.approvals,
    status: decision === 'approved' ? 'approved' : 'rejected'
  });
  audit(req.org.id, req.user.id, decision, 'requisition', pr.id, { comment: req.body.comment });
  res.json({ requisition: updated });
});

/* approved requisition -> RFQ sent to multiple vendors */
router.post('/requisitions/:id/convert-rfq', requirePerm('purchase', 'edit'), (req, res) => {
  const pr = store.findOne('requisitions', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!pr) return res.status(404).json({ error: 'Requisition not found' });
  if (pr.status !== 'approved') return res.status(400).json({ error: 'Only approved requisitions can be converted' });
  if (pr.rfqId) return res.status(409).json({ error: 'Requisition already converted to RFQ' });
  const vendorIds = Array.isArray(req.body.vendorIds) ? req.body.vendorIds : [];
  const validVendors = vendorIds.filter(id => store.findOne('suppliers', s => s.id === id && s.orgId === req.org.id));
  if (!validVendors.length) return res.status(400).json({ error: 'Select at least one valid supplier' });

  const rfq = store.insert('rfqs', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'rfq'),
    requisitionId: pr.id, vendorIds: validVendors,
    lines: pr.lines.map(l => ({ ...l })), quotes: [],
    status: 'open', dueDate: req.body.dueDate || null
  });
  store.update('requisitions', pr.id, { rfqId: rfq.id, status: 'converted' });
  audit(req.org.id, req.user.id, 'convert', 'requisition', pr.id, { rfqId: rfq.id });
  res.json({ rfq });
});

/* ================= RFQs ================= */
router.get('/rfqs', requirePerm('purchase', 'view'), (req, res) => {
  const list = store.find('rfqs', r => r.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({
      ...r,
      vendors: (r.vendorIds || []).map(id => (store.byId('suppliers', id) || {}).name).filter(Boolean),
      quoteCount: (r.quotes || []).length
    }));
  res.json({ rfqs: list });
});

router.get('/rfqs/:id', requirePerm('purchase', 'view'), (req, res) => {
  const rfq = store.findOne('rfqs', r => r.id === req.params.id && r.orgId === req.org.id);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  /* normalized side-by-side comparison per line */
  const comparison = rfq.lines.map((line, idx) => ({
    description: line.description, qty: line.qty,
    quotes: (rfq.quotes || []).map(q => ({
      vendorName: (store.byId('suppliers', q.vendorId) || {}).name || '?',
      rate: q.lines[idx] ? q.lines[idx].rate : null,
      taxPct: q.lines[idx] ? q.lines[idx].taxPct : null,
      freight: q.freight || 0,
      leadTimeDays: q.leadTimeDays ?? null,
      lineTotal: q.lines[idx] ? r2(line.qty * q.lines[idx].rate * (1 + (q.lines[idx].taxPct || 0) / 100)) : null
    }))
  }));
  res.json({ rfq, comparison });
});

router.post('/rfqs/:id/quotes', requirePerm('purchase', 'edit'), (req, res) => {
  const rfq = store.findOne('rfqs', r => r.id === req.params.id && r.orgId === req.org.id);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  if (rfq.status !== 'open') return res.status(400).json({ error: 'RFQ is closed' });
  const b = req.body || {};
  if (!rfq.vendorIds.includes(b.vendorId)) return res.status(400).json({ error: 'Vendor is not on this RFQ' });
  if ((rfq.quotes || []).some(q => q.vendorId === b.vendorId)) {
    return res.status(409).json({ error: 'Quote from this vendor already recorded. Delete it first.' });
  }
  const lines = (b.lines || []);
  if (lines.length !== rfq.lines.length) return res.status(400).json({ error: `Provide rates for all ${rfq.lines.length} lines` });
  rfq.quotes.push({
    vendorId: b.vendorId,
    lines: lines.map(l => ({ rate: Number(l.rate) || 0, taxPct: Number(l.taxPct) || 0 })),
    freight: Number(b.freight) || 0,
    leadTimeDays: Number(b.leadTimeDays) || 7,
    paymentTerms: b.paymentTerms || '',
    submittedAt: new Date().toISOString()
  });
  const updated = store.update('rfqs', rfq.id, { quotes: rfq.quotes });
  audit(req.org.id, req.user.id, 'add_quote', 'rfq', rfq.id, { vendorId: b.vendorId });
  res.json({ rfq: updated });
});

/* award: choose winning vendors -> generate one PO per awarded vendor */
router.post('/rfqs/:id/award', requirePerm('purchase', 'approve'), (req, res) => {
  const rfq = store.findOne('rfqs', r => r.id === req.params.id && r.orgId === req.org.id);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  if (rfq.status !== 'open') return res.status(400).json({ error: 'RFQ already closed' });
  const awards = req.body.awards || []; // [{vendorId, lineIndexes:[...]}]
  if (!awards.length) return res.status(400).json({ error: 'No awards provided' });

  const poPlans = [];
  const coveredLines = new Set();
  for (const aw of awards) {
    const quote = (rfq.quotes || []).find(q => q.vendorId === aw.vendorId);
    if (!quote) return res.status(400).json({ error: 'An awarded vendor has not submitted a quote' });
    const idxs = (aw.lineIndexes || []).map(Number);
    if (!idxs.length || idxs.some(i => !Number.isInteger(i) || i < 0 || i >= rfq.lines.length)) {
      return res.status(400).json({ error: 'Award contains invalid line indexes' });
    }
    if (idxs.some(i => coveredLines.has(i))) return res.status(400).json({ error: 'An RFQ line cannot be awarded twice' });
    const poLines = idxs.map(i => {
      coveredLines.add(i);
      const ql = quote.lines[i];
      return {
        description: rfq.lines[i].description, qty: rfq.lines[i].qty,
        rate: ql.rate, taxPct: ql.taxPct, receivedQty: 0
      };
    });
    const freight = r2(Number(quote.freight) || 0);
    const total = r2(poLines.reduce((s, l) => s + l.qty * l.rate * (1 + l.taxPct / 100), 0) + freight);
    poPlans.push({ supplierId: aw.vendorId, lines: poLines, total, freight });
  }
  if (!poPlans.length) return res.status(400).json({ error: 'No valid awards could be created' });
  if (coveredLines.size !== rfq.lines.length) return res.status(400).json({ error: 'Every RFQ line must be awarded before closing the RFQ' });

  const posCreated = [];
  for (const plan of poPlans) {
    const po = store.insert('purchaseOrders', {
      orgId: req.org.id, number: nextNumber(req.org.id, 'purchaseOrder'),
      supplierId: plan.supplierId, rfqId: rfq.id,
      date: new Date().toISOString().slice(0, 10),
      expectedDate: null, status: 'sent',
      lines: plan.lines, freight: plan.freight, total: plan.total, notes: `Awarded from ${rfq.number}`
    });
    posCreated.push(po);
  }
  store.update('rfqs', rfq.id, { status: 'awarded' });
  audit(req.org.id, req.user.id, 'award', 'rfq', rfq.id, { purchaseOrders: posCreated.map(p => p.number) });
  res.json({ purchaseOrders: posCreated });
});

/* ================= PURCHASE ORDERS ================= */
router.get('/purchase-orders', requirePerm('purchase', 'view'), (req, res) => {
  const list = store.find('purchaseOrders', p => p.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(p => ({ ...p, supplierName: (store.byId('suppliers', p.supplierId) || {}).name || '-' }));
  res.json({ purchaseOrders: list });
});

router.post('/purchase-orders', requirePerm('purchase', 'create'), (req, res) => {
  const b = req.body || {};
  const supplier = b.supplierId ? store.findOne('suppliers', s => s.id === b.supplierId && s.orgId === req.org.id) : null;
  if (!supplier) return res.status(400).json({ error: 'Valid supplierId is required' });
  const lines = (b.lines || []).filter(l => l.description && Number(l.qty) > 0)
    .map(l => ({ description: l.description, qty: Number(l.qty), rate: Number(l.rate) || 0, taxPct: Number(l.taxPct) || 0, receivedQty: 0 }));
  if (!lines.length) return res.status(400).json({ error: 'At least one valid line is required' });
  const total = r2(lines.reduce((s, l) => s + l.qty * l.rate * (1 + l.taxPct / 100), 0));
  const po = store.insert('purchaseOrders', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'purchaseOrder'),
    supplierId: supplier.id, rfqId: null,
    date: new Date().toISOString().slice(0, 10),
    expectedDate: b.expectedDate || null, status: 'draft',
    lines, total, notes: b.notes || ''
  });
  audit(req.org.id, req.user.id, 'create', 'purchase_order', po.id, { number: po.number });
  res.json({ purchaseOrder: po });
});

router.patch('/purchase-orders/:id/status', requirePerm('purchase', 'edit'), (req, res) => {
  const po = store.findOne('purchaseOrders', p => p.id === req.params.id && p.orgId === req.org.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const st = req.body.status;
  if (!['draft', 'sent', 'cancelled'].includes(st)) return res.status(400).json({ error: 'Use GRN flow to receive; only draft/sent/cancelled allowed here' });
  const updated = store.update('purchaseOrders', po.id, { status: st });
  audit(req.org.id, req.user.id, 'status_change', 'purchase_order', po.id, { to: st });
  res.json({ purchaseOrder: updated });
});

/* ================= SUPPLIERS ================= */
router.get('/suppliers', requirePerm('purchase', 'view'), (req, res) => {
  res.json({ suppliers: store.find('suppliers', s => s.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});
router.post('/suppliers', requirePerm('purchase', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Supplier name is required' });
  const sup = store.insert('suppliers', {
    orgId: req.org.id, name: b.name, contactPerson: b.contactPerson || '',
    email: b.email || '', phone: b.phone || '', gstin: b.gstin || '',
    stateCode: String(b.stateCode || req.org.stateCode || '27'),
    address: b.address || ''
  });
  audit(req.org.id, req.user.id, 'create', 'supplier', sup.id, { name: sup.name });
  res.json({ supplier: sup });
});

/* ================= GRN (Goods Receipt Note) ================= */
router.get('/grns', requirePerm('purchase', 'view'), (req, res) => {
  const list = store.find('grns', g => g.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(g => ({
      ...g,
      supplierName: (store.byId('suppliers', g.supplierId) || {}).name || '-',
      poNumber: (store.byId('purchaseOrders', g.poId) || {}).number || '-'
    }));
  res.json({ grns: list });
});

/* create GRN against a PO: accepted qty posts stock + inventory/AP journal */
router.post('/grns', requirePerm('inventory', 'edit'), (req, res) => {
  const b = req.body || {};
  const po = store.findOne('purchaseOrders', p => p.id === b.poId && p.orgId === req.org.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['cancelled', 'received'].includes(po.status)) return res.status(400).json({ error: 'PO cannot be received in status ' + po.status });

  const warehouse = b.warehouseId
    ? store.findOne('warehouses', w => w.id === b.warehouseId && w.orgId === req.org.id)
    : store.findOne('warehouses', w => w.orgId === req.org.id);
  if (!warehouse) return res.status(400).json({ error: 'No warehouse available' });

  const grnLines = [];
  const proposedPoLines = po.lines.map(line => ({ ...line }));
  for (const [idx, rl] of (b.lines || []).entries()) {
    const poLine = po.lines[idx];
    if (!poLine) return res.status(400).json({ error: `Invalid PO line index ${idx}` });
    const pending = r2(poLine.qty - (poLine.receivedQty || 0));
    if (pending <= 0) continue;
    const received = Number(rl.receivedQty) || 0;
    const rejected = Number(rl.rejectedQty) || 0;
    if (received < 0 || rejected < 0) return res.status(400).json({ error: 'Received and rejected quantities cannot be negative' });
    if (received > pending) return res.status(400).json({ error: `Received quantity exceeds pending quantity on line ${idx + 1}` });
    if (rejected > received) return res.status(400).json({ error: `Rejected quantity cannot exceed received quantity on line ${idx + 1}` });
    const accepted = r2(received - rejected);
    if (received <= 0) continue;
    let product = null;
    if (rl.productId) {
      product = store.findOne('products', p => p.id === rl.productId && p.orgId === req.org.id);
      if (!product) return res.status(400).json({ error: `Invalid product on line ${idx + 1}` });
    }
    if (accepted > 0 && !product) return res.status(400).json({ error: `Select a valid product for accepted quantity on line ${idx + 1}` });
    grnLines.push({
      poLineIndex: idx, description: poLine.description, productId: product ? product.id : null,
      orderedQty: poLine.qty, receivedQty: received,
      acceptedQty: accepted, rejectedQty: rejected,
      batchNo: rl.batchNo || '', rate: poLine.rate, taxPct: Number(poLine.taxPct) || 0
    });
    proposedPoLines[idx].receivedQty = r2((proposedPoLines[idx].receivedQty || 0) + accepted);
  }
  if (!grnLines.length) return res.status(400).json({ error: 'Nothing to receive on this PO' });

  const grn = store.insert('grns', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'grn'),
    poId: po.id, supplierId: po.supplierId,
    date: new Date().toISOString().slice(0, 10),
    warehouseId: warehouse.id, lines: grnLines,
    qcStatus: b.qcStatus || 'pass',
    invoiceNo: b.invoiceNo || '', note: b.note || ''
  });

  for (const line of grnLines.filter(line => line.acceptedQty > 0)) {
    postStock({
      orgId: req.org.id, productId: line.productId, warehouseId: warehouse.id,
      date: grn.date, type: 'purchase', qty: line.acceptedQty, rate: line.rate,
      refType: 'grn', refId: grn.id, refNumber: grn.number, note: `Against ${po.number}`
    });
  }

  const fullyReceived = proposedPoLines.every(line => (Number(line.receivedQty) || 0) >= Number(line.qty));
  store.update('purchaseOrders', po.id, { lines: proposedPoLines, status: fullyReceived ? 'received' : 'partial' });

  /* Payable journal: accepted inventory and GST input credit against AP. */
  const invAcc = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '1200');
  const gstInputAcc = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '1300');
  const apAcc = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '2000');
  const taxableValue = r2(grnLines.reduce((s, l) => s + l.acceptedQty * l.rate, 0));
  const inputTax = r2(grnLines.reduce((s, l) => s + l.acceptedQty * l.rate * l.taxPct / 100, 0));
  if (invAcc && apAcc && taxableValue > 0) {
    const journalLines = [{ accountId: invAcc.id, debit: taxableValue, credit: 0 }];
    if (inputTax > 0 && gstInputAcc) journalLines.push({ accountId: gstInputAcc.id, debit: inputTax, credit: 0 });
    const payable = r2(taxableValue + (gstInputAcc ? inputTax : 0));
    journalLines.push({ accountId: apAcc.id, debit: 0, credit: payable });
      store.insert('journals', {
        orgId: req.org.id, number: nextNumber(req.org.id, 'journal'),
        date: grn.date, narration: `GRN ${grn.number} against ${po.number}`,
        posted: true, refType: 'grn', refId: grn.id,
        lines: journalLines
      });
  }
  audit(req.org.id, req.user.id, 'create', 'grn', grn.id, { number: grn.number, po: po.number });
  res.json({ grn });
});

module.exports = router;

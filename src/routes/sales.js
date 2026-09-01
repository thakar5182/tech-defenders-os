/**
 * Sales routes - Lead-to-Cash document chain:
 *   Quotation -> Sales Order -> GST Invoice -> Receipt
 * Features: server-side GST computation (CGST/SGST vs IGST), numbering,
 * conversion guards against duplicates, partial invoicing, payment
 * allocation, automatic journal postings and automatic AMC creation
 * from eligible invoice lines.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, nextNumber, computeDoc, audit, notify, postStock, stockBalance } = require('../util');

const router = express.Router();
router.use(requireAuth);

/* ---------- shared helpers ---------- */
function enrichLines(rawLines, orgId) {
  const source = Array.isArray(rawLines) ? rawLines : [];
  if (source.length > 100) return { error: 'A document can contain at most 100 line items', lines: [] };
  const foreignProduct = source.find(l => l.productId && !store.findOne('products', p => p.id === l.productId && p.orgId === orgId));
  if (foreignProduct) return { error: 'A line contains an invalid product for this organization', lines: [] };
  const lines = [];
  for (let index = 0; index < source.length; index++) {
    const l = source[index] || {};
    const p = l.productId ? store.findOne('products', x => x.id === l.productId && x.orgId === orgId) : null;
    const name = String(p ? p.name : (l.name || l.description || '')).trim().slice(0, 200);
    const qty = Number(l.qty);
    const rate = Number(l.rate !== undefined ? l.rate : (p ? p.salePrice : 0));
    const discountPct = Number(l.discountPct || 0);
    const gstRate = Number(p ? p.gstRate : (l.gstRate || 0));
    const lineNumber = index + 1;
    if (!name) return { error: `Description is required on line ${lineNumber}`, lines: [] };
    if (!Number.isFinite(qty) || qty <= 0) return { error: `Quantity must be greater than zero on line ${lineNumber}`, lines: [] };
    if (!Number.isFinite(rate) || rate < 0) return { error: `Rate cannot be negative on line ${lineNumber}`, lines: [] };
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) return { error: `Discount must be between 0 and 100 on line ${lineNumber}`, lines: [] };
    if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) return { error: `GST rate must be between 0 and 100 on line ${lineNumber}`, lines: [] };
    lines.push({
      productId: l.productId || null,
      name,
      hsn: String(p ? (p.hsn || '') : (l.hsn || '')).trim().slice(0, 20),
      uom: String(p ? (p.uom || 'Nos') : (l.uom || 'Nos')).trim().slice(0, 20) || 'Nos',
      gstRate,
      qty,
      rate,
      discountPct
    });
  }
  return { lines };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(String(value) + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === String(value);
}

function dueDateFrom(invoiceDate, termsDays) {
  const due = new Date(invoiceDate + 'T00:00:00Z');
  due.setUTCDate(due.getUTCDate() + (Number(termsDays) || 30));
  return due.toISOString().slice(0, 10);
}

function postInvoiceJournal(inv, user) {
  const ar = store.findOne('accounts', a => a.orgId === req_org(inv.orgId).id && a.code === '1100');
  const income = store.findOne('accounts', a => a.orgId === inv.orgId && a.code === '4000');
  const gstOut = store.findOne('accounts', a => a.orgId === inv.orgId && a.code === '2100');
  if (!ar || !income) return;
  const t = inv.totals;
  const lines = [
    { accountId: ar.id, debit: t.grandTotal, credit: 0 },
    { accountId: income.id, debit: 0, credit: t.taxable }
  ];
  if (gstOut && (t.cgst + t.sgst + t.igst) > 0) {
    lines.push({ accountId: gstOut.id, debit: 0, credit: r2(t.cgst + t.sgst + t.igst) });
  }
  store.insert('journals', {
    orgId: inv.orgId, number: nextNumber(inv.orgId, 'journal'), date: inv.date,
    narration: `Sales invoice ${inv.number}`, posted: true,
    refType: 'invoice', refId: inv.id, lines
  });
}
function req_org(orgId) { return { id: orgId }; }

function postReceiptJournal(rcp, user) {
  const bank = store.findOne('accounts', a => a.orgId === rcp.orgId && ['1010', '1000'].includes(a.code) && (rcp.mode === 'cash' ? a.code === '1000' : a.code === '1010'));
  const ar = store.findOne('accounts', a => a.orgId === rcp.orgId && a.code === '1100');
  if (!bank || !ar) return;
  store.insert('journals', {
    orgId: rcp.orgId, number: nextNumber(rcp.orgId, 'journal'), date: rcp.date,
    narration: `Receipt ${rcp.number} from customer`, posted: true,
    refType: 'receipt', refId: rcp.id,
    lines: [
      { accountId: bank.id, debit: rcp.amount, credit: 0 },
      { accountId: ar.id, debit: 0, credit: rcp.amount }
    ]
  });
}

/* auto-create AMC contracts for eligible products on an invoice */
function createAmcFromInvoice(inv, user) {
  let created = 0;
  for (const line of inv.lines) {
    if (!line.productId) continue;
    const p = store.findOne('products', x => x.id === line.productId && x.orgId === inv.orgId);
    if (!p || !p.amcEligible || !p.amcMonths) continue;
    const start = new Date(inv.date);
    const end = new Date(start); end.setMonth(end.getMonth() + Number(p.amcMonths));
    store.insert('amcContracts', {
      orgId: inv.orgId, number: nextNumber(inv.orgId, 'amc'),
      customerId: inv.customerId, assetDesc: `${p.name} (x${line.qty})`,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      value: line.lineTotal, visitsAllowed: Math.max(1, Math.round(p.amcMonths / 3)), visitsUsed: 0,
      status: 'active', reminderDays: [90, 60, 30, 7], invoiceId: inv.id
    });
    created++;
  }
  if (created) {
    notify(inv.orgId, { title: 'AMC contracts created', body: `${created} AMC contract(s) auto-created from invoice ${inv.number}`, type: 'success', link: '#/service/amc' });
  }
}

/* ================= QUOTATIONS ================= */
router.get('/quotations', requirePerm('sales', 'view'), (req, res) => {
  const list = store.find('quotations', q => q.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(q => ({ ...q, customerName: (store.byId('customers', q.customerId) || {}).name || '-' }));
  res.json({ quotations: list });
});

router.post('/quotations', requirePerm('sales', 'create'), (req, res) => {
  const b = req.body || {};
  const customer = b.customerId ? store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id) : null;
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const enriched = enrichLines(b.lines, req.org.id);
  if (enriched.error) return res.status(400).json({ error: enriched.error });
  const lines = enriched.lines;
  if (!lines.length) return res.status(400).json({ error: 'At least one line item is required' });
  const doc = computeDoc(lines, req.org.stateCode, customer.stateCode);
  const quotation = store.insert('quotations', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'quotation'),
    customerId: customer.id, date: b.date || new Date().toISOString().slice(0, 10),
    validUntil: b.validUntil || null, placeOfSupply: customer.stateCode,
    status: 'draft', lines: doc.lines, totals: doc.totals,
    notes: b.notes || '', convertedToId: null
  });
  audit(req.org.id, req.user.id, 'create', 'quotation', quotation.id, { number: quotation.number });
  res.json({ quotation });
});

router.patch('/quotations/:id/status', requirePerm('sales', 'edit'), (req, res) => {
  const q = store.findOne('quotations', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const st = req.body.status;
  if (!['draft', 'sent', 'accepted', 'rejected', 'expired'].includes(st)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updated = store.update('quotations', q.id, { status: st });
  audit(req.org.id, req.user.id, 'status_change', 'quotation', q.id, { from: q.status, to: st });
  res.json({ quotation: updated });
});

/* quotation -> sales order */
router.post('/quotations/:id/convert-sales-order', requirePerm('sales', 'edit'), (req, res) => {
  const q = store.findOne('quotations', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.convertedToId) return res.status(409).json({ error: 'Quotation already converted to ' + q.convertedToId });
  if (!['accepted'].includes(q.status)) {
    return res.status(400).json({ error: 'Only accepted quotations can be converted. Mark it accepted first.' });
  }
  const so = store.insert('salesOrders', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'salesOrder'),
    customerId: q.customerId, date: new Date().toISOString().slice(0, 10),
    expectedDate: null, placeOfSupply: q.placeOfSupply,
    status: 'confirmed',
    lines: q.lines.map(l => ({ ...l, fulfilledQty: 0, invoicedQty: 0 })),
    totals: q.totals, sourceType: 'quotation', sourceId: q.id, notes: q.notes
  });
  store.update('quotations', q.id, { convertedToId: so.id });
  store.insert('activities', { orgId: req.org.id, entityType: 'quotation', entityId: q.id, type: 'conversion', text: `Converted to Sales Order ${so.number}`, userId: req.user.id });
  audit(req.org.id, req.user.id, 'convert', 'quotation', q.id, { salesOrderId: so.id });
  res.json({ salesOrder: so });
});

/* ================= SALES ORDERS ================= */
router.get('/sales-orders', requirePerm('sales', 'view'), (req, res) => {
  const list = store.find('salesOrders', s => s.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(s => ({ ...s, customerName: (store.byId('customers', s.customerId) || {}).name || '-' }));
  res.json({ salesOrders: list });
});

router.post('/sales-orders', requirePerm('sales', 'create'), (req, res) => {
  const b = req.body || {};
  const customer = b.customerId ? store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id) : null;
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const enriched = enrichLines(b.lines, req.org.id);
  if (enriched.error) return res.status(400).json({ error: enriched.error });
  const lines = enriched.lines;
  if (!lines.length) return res.status(400).json({ error: 'At least one line item is required' });
  const doc = computeDoc(lines, req.org.stateCode, customer.stateCode);
  const so = store.insert('salesOrders', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'salesOrder'),
    customerId: customer.id, date: b.date || new Date().toISOString().slice(0, 10),
    expectedDate: b.expectedDate || null, placeOfSupply: customer.stateCode,
    status: 'confirmed',
    lines: doc.lines.map(l => ({ ...l, fulfilledQty: 0, invoicedQty: 0 })),
    totals: doc.totals, sourceType: 'manual', sourceId: null, notes: b.notes || ''
  });
  audit(req.org.id, req.user.id, 'create', 'sales_order', so.id, { number: so.number });
  res.json({ salesOrder: so });
});

/* SO -> Invoice (remaining uninvoiced quantity; partial supported) */
router.post('/sales-orders/:id/invoice', requirePerm('sales', 'edit'), (req, res) => {
  const so = store.findOne('salesOrders', s => s.id === req.params.id && s.orgId === req.org.id);
  if (!so) return res.status(404).json({ error: 'Sales order not found' });
  if (so.status === 'cancelled') return res.status(400).json({ error: 'Cancelled orders cannot be invoiced' });

  const requested = req.body.lines || []; // [{index, qty}]
  const outLines = [];
  so.lines.forEach((l, idx) => {
    const remaining = r2(l.qty - (l.invoicedQty || 0));
    if (remaining <= 0) return;
    let qty = remaining;
    const reqLine = requested.find(r => Number(r.index) === idx);
    if (reqLine) qty = Math.min(Number(reqLine.qty) || 0, remaining);
    if (qty <= 0) return;
    outLines.push({
      productId: l.productId, name: l.name, hsn: l.hsn, uom: l.uom,
      gstRate: l.gstRate, qty, rate: l.rate, discountPct: l.discountPct || 0,
      soIndex: idx
    });
  });
  if (!outLines.length) return res.status(400).json({ error: 'Nothing left to invoice on this order' });

  const customer = store.findOne('customers', c => c.id === so.customerId && c.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Sales order customer is no longer valid' });
  const requestedWarehouse = req.body.warehouseId
    ? store.findOne('warehouses', w => w.id === req.body.warehouseId && w.orgId === req.org.id)
    : null;
  if (req.body.warehouseId && !requestedWarehouse) return res.status(400).json({ error: 'Invalid warehouse' });
  const stockPlan = [];
  for (const line of outLines) {
    if (!line.productId) continue;
    const product = store.findOne('products', p => p.id === line.productId && p.orgId === req.org.id);
    if (!product) return res.status(400).json({ error: 'Sales order contains an invalid product' });
    if (product.type === 'service') continue;
    const warehouse = requestedWarehouse ||
      (product.warehouseId && store.findOne('warehouses', w => w.id === product.warehouseId && w.orgId === req.org.id)) ||
      store.findOne('warehouses', w => w.orgId === req.org.id);
    if (!warehouse) return res.status(400).json({ error: `No warehouse is available for ${product.name}` });
    const alreadyPlanned = stockPlan.filter(x => x.product.id === product.id && x.warehouse.id === warehouse.id)
      .reduce((sum, x) => sum + x.qty, 0);
    const available = stockBalance(req.org.id, product.id, warehouse.id);
    if (!req.org.allowNegativeStock && available < alreadyPlanned + line.qty) {
      return res.status(400).json({ error: `Insufficient stock of ${product.name} in ${warehouse.name}. Available: ${available}` });
    }
    stockPlan.push({ product, warehouse, qty: line.qty });
  }
  const doc = computeDoc(outLines, req.org.stateCode, so.placeOfSupply || customer.stateCode);
  const today = new Date().toISOString().slice(0, 10);
  const termsDays = Number(customer.paymentTermsDays) || 30;
  const due = new Date(); due.setDate(due.getDate() + termsDays);

  const inv = store.insert('invoices', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'invoice'),
    customerId: so.customerId, date: today, dueDate: due.toISOString().slice(0, 10),
    placeOfSupply: so.placeOfSupply || customer.stateCode,
    status: 'unpaid', paidAmount: 0,
    lines: doc.lines, totals: doc.totals,
    sourceType: 'sales_order', sourceId: so.id, notes: '',
    warehouseId: requestedWarehouse ? requestedWarehouse.id : null
  });

  for (const item of stockPlan) {
    postStock({
      orgId: req.org.id, productId: item.product.id, warehouseId: item.warehouse.id,
      type: 'sale', qty: -item.qty, rate: item.product.purchasePrice,
      refType: 'invoice', refId: inv.id, refNumber: inv.number,
      note: `Finished goods issued for ${inv.number}`
    });
  }

  /* update invoiced quantities + order status */
  let fullyInvoiced = true;
  for (const ol of outLines) {
    const line = so.lines[ol.soIndex];
    line.invoicedQty = r2((line.invoicedQty || 0) + ol.qty);
  }
  fullyInvoiced = so.lines.every(line => (Number(line.invoicedQty) || 0) >= Number(line.qty));
  store.update('salesOrders', so.id, {
    lines: so.lines,
    status: fullyInvoiced ? 'completed' : 'partial'
  });

  postInvoiceJournal(inv, req.user);
  createAmcFromInvoice(inv, req.user);
  audit(req.org.id, req.user.id, 'convert', 'sales_order', so.id, { invoiceId: inv.id });
  res.json({ invoice: inv });
});

/* ================= INVOICES ================= */
router.post('/invoices', requirePerm('sales', 'create'), (req, res) => {
  const b = req.body || {};
  const customer = b.customerId
    ? store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id)
    : null;
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });

  const enriched = enrichLines(b.lines, req.org.id);
  if (enriched.error) return res.status(400).json({ error: enriched.error });
  if (!enriched.lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  const today = new Date().toISOString().slice(0, 10);
  const invoiceDate = b.date || today;
  if (!validDate(invoiceDate)) return res.status(400).json({ error: 'Invoice date must be a valid YYYY-MM-DD date' });
  const dueDate = b.dueDate || dueDateFrom(invoiceDate, customer.paymentTermsDays);
  if (!validDate(dueDate)) return res.status(400).json({ error: 'Due date must be a valid YYYY-MM-DD date' });
  if (dueDate < invoiceDate) return res.status(400).json({ error: 'Due date cannot be before the invoice date' });

  const requestedWarehouse = b.warehouseId
    ? store.findOne('warehouses', w => w.id === b.warehouseId && w.orgId === req.org.id)
    : null;
  if (b.warehouseId && !requestedWarehouse) return res.status(400).json({ error: 'Invalid warehouse' });

  /* Manual lines do not affect stock. Product-linked API lines use the same
     warehouse-wise validation as invoices raised from a Sales Order. */
  const stockPlan = [];
  for (const line of enriched.lines) {
    if (!line.productId) continue;
    const product = store.findOne('products', p => p.id === line.productId && p.orgId === req.org.id);
    if (!product) return res.status(400).json({ error: 'Invoice contains an invalid product' });
    if (product.type === 'service') continue;
    const warehouse = requestedWarehouse ||
      (product.warehouseId && store.findOne('warehouses', w => w.id === product.warehouseId && w.orgId === req.org.id)) ||
      store.findOne('warehouses', w => w.orgId === req.org.id);
    if (!warehouse) return res.status(400).json({ error: `No warehouse is available for ${product.name}` });
    const alreadyPlanned = stockPlan
      .filter(item => item.product.id === product.id && item.warehouse.id === warehouse.id)
      .reduce((sum, item) => sum + item.qty, 0);
    const available = stockBalance(req.org.id, product.id, warehouse.id);
    if (!req.org.allowNegativeStock && available < alreadyPlanned + line.qty) {
      return res.status(400).json({ error: `Insufficient stock of ${product.name} in ${warehouse.name}. Available: ${available}` });
    }
    stockPlan.push({ product, warehouse, qty: line.qty });
  }

  const placeOfSupply = String(b.placeOfSupply || customer.stateCode || '').trim().slice(0, 4);
  const doc = computeDoc(enriched.lines, req.org.stateCode, placeOfSupply);
  const invoice = store.insert('invoices', {
    orgId: req.org.id,
    number: nextNumber(req.org.id, 'invoice'),
    customerId: customer.id,
    date: invoiceDate,
    dueDate,
    placeOfSupply,
    status: 'unpaid',
    paidAmount: 0,
    lines: doc.lines,
    totals: doc.totals,
    sourceType: 'manual',
    sourceId: null,
    notes: String(b.notes || '').trim().slice(0, 2000),
    warehouseId: requestedWarehouse ? requestedWarehouse.id : null
  });

  for (const item of stockPlan) {
    postStock({
      orgId: req.org.id,
      productId: item.product.id,
      warehouseId: item.warehouse.id,
      type: 'sale',
      qty: -item.qty,
      rate: item.product.purchasePrice,
      refType: 'invoice',
      refId: invoice.id,
      refNumber: invoice.number,
      note: `Finished goods issued for ${invoice.number}`
    });
  }

  postInvoiceJournal(invoice, req.user);
  createAmcFromInvoice(invoice, req.user);
  audit(req.org.id, req.user.id, 'create', 'invoice', invoice.id, { number: invoice.number, sourceType: 'manual' });
  res.json({ invoice });
});

router.get('/invoices', requirePerm('sales', 'view'), (req, res) => {
  const list = store.find('invoices', i => i.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(i => {
      const customer = store.byId('customers', i.customerId) || {};
      return ({
      ...i,
      customerName: customer.name || '-',
      customerEmail: customer.email || '',
      customerPhone: customer.phone || '',
      balanceDue: r2((i.totals?.grandTotal || 0) - (i.paidAmount || 0))
    });
    });
  res.json({ invoices: list });
});

router.get('/invoices/:id', requirePerm('sales', 'view'), (req, res) => {
  const inv = store.findOne('invoices', i => i.id === req.params.id && i.orgId === req.org.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json({
    invoice: inv,
    customer: store.byId('customers', inv.customerId),
    org: req.org,
    receipts: store.find('receipts', r => r.orgId === req.org.id &&
      (r.allocations || []).some(a => a.invoiceId === inv.id))
  });
});

router.post('/invoices/cancel/:id', requirePerm('sales', 'delete'), (req, res) => {
  const inv = store.findOne('invoices', i => i.id === req.params.id && i.orgId === req.org.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if ((inv.paidAmount || 0) > 0) return res.status(400).json({ error: 'Cannot cancel an invoice that has payments. Issue a credit note instead.' });
  if (inv.status === 'cancelled') return res.status(409).json({ error: 'Invoice is already cancelled' });

  const originalJournals = store.find('journals', j => j.orgId === req.org.id && j.refType === 'invoice' && j.refId === inv.id && j.posted);
  for (const journal of originalJournals) {
    const alreadyReversed = store.findOne('journals', j => j.orgId === req.org.id && j.refType === 'invoice_reversal' && j.refId === journal.id);
    if (!alreadyReversed) {
      store.insert('journals', {
        orgId: req.org.id, number: nextNumber(req.org.id, 'journal'),
        date: new Date().toISOString().slice(0, 10),
        narration: `Reversal of ${journal.number} for cancelled invoice ${inv.number}`,
        posted: true, refType: 'invoice_reversal', refId: journal.id,
        lines: journal.lines.map(line => ({ accountId: line.accountId, debit: Number(line.credit) || 0, credit: Number(line.debit) || 0 }))
      });
    }
  }

  for (const entry of store.find('stockLedger', e => e.orgId === req.org.id && e.refType === 'invoice' && e.refId === inv.id)) {
    if (!store.findOne('stockLedger', e => e.orgId === req.org.id && e.refType === 'invoice_cancel' && e.refId === entry.id)) {
      postStock({
        orgId: req.org.id, productId: entry.productId, warehouseId: entry.warehouseId,
        type: 'sale_reversal', qty: Math.abs(Number(entry.qty) || 0), rate: entry.rate,
        refType: 'invoice_cancel', refId: entry.id, refNumber: inv.number,
        note: `Stock restored after cancelling ${inv.number}`
      });
    }
  }

  if (inv.sourceType === 'sales_order' && inv.sourceId) {
    const so = store.findOne('salesOrders', s => s.id === inv.sourceId && s.orgId === req.org.id);
    if (so) {
      for (const line of inv.lines || []) {
        const soLine = Number.isInteger(line.soIndex) ? so.lines[line.soIndex] : null;
        if (soLine) soLine.invoicedQty = r2(Math.max(0, (Number(soLine.invoicedQty) || 0) - (Number(line.qty) || 0)));
      }
      const invoiced = so.lines.map(l => Number(l.invoicedQty) || 0);
      const status = invoiced.every((q, i) => q >= Number(so.lines[i].qty)) ? 'completed' :
        (invoiced.some(q => q > 0) ? 'partial' : 'confirmed');
      store.update('salesOrders', so.id, { lines: so.lines, status });
    }
  }

  for (const amc of store.find('amcContracts', a => a.orgId === req.org.id && a.invoiceId === inv.id && !['cancelled', 'renewed'].includes(a.status))) {
    store.update('amcContracts', amc.id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
  }
  store.update('invoices', inv.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancellationReason: req.body.reason || '' });
  audit(req.org.id, req.user.id, 'cancel', 'invoice', inv.id, { reason: req.body.reason || '' });
  res.json({ message: 'Invoice cancelled' });
});

/* ================= CREDIT NOTES ================= */
router.get('/credit-notes', requirePerm('sales', 'view'), (req, res) => {
  const list = store.find('creditNotes', note => note.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(note => ({
      ...note,
      customerName: (store.findOne('customers', c => c.id === note.customerId && c.orgId === req.org.id) || {}).name || '-',
      invoiceNumber: (store.findOne('invoices', i => i.id === note.invoiceId && i.orgId === req.org.id) || {}).number || '-'
    }));
  res.json({ creditNotes: list });
});

router.post('/credit-notes', requirePerm('sales', 'edit'), (req, res) => {
  const inv = store.findOne('invoices', i => i.id === req.body.invoiceId && i.orgId === req.org.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'cancelled') return res.status(400).json({ error: 'A cancelled invoice cannot be credited' });
  if (store.findOne('creditNotes', note => note.orgId === req.org.id && note.invoiceId === inv.id && note.status === 'posted')) {
    return res.status(409).json({ error: 'This invoice already has a posted full credit note' });
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required for a credit note' });
  const note = store.insert('creditNotes', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'creditNote'),
    invoiceId: inv.id, customerId: inv.customerId,
    date: req.body.date || new Date().toISOString().slice(0, 10),
    reason, status: 'posted', lines: inv.lines, totals: inv.totals
  });

  const income = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '4000');
  const gstOut = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '2100');
  const ar = store.findOne('accounts', a => a.orgId === req.org.id && a.code === '1100');
  if (income && ar) {
    const lines = [{ accountId: income.id, debit: inv.totals.taxable, credit: 0 }];
    const tax = r2((inv.totals.cgst || 0) + (inv.totals.sgst || 0) + (inv.totals.igst || 0));
    if (tax > 0 && gstOut) lines.push({ accountId: gstOut.id, debit: tax, credit: 0 });
    lines.push({ accountId: ar.id, debit: 0, credit: r2(inv.totals.taxable + (gstOut ? tax : 0)) });
    store.insert('journals', {
      orgId: req.org.id, number: nextNumber(req.org.id, 'journal'), date: note.date,
      narration: `Credit note ${note.number} against ${inv.number}`,
      posted: true, refType: 'credit_note', refId: note.id, lines
    });
  }

  for (const entry of store.find('stockLedger', e => e.orgId === req.org.id && e.refType === 'invoice' && e.refId === inv.id)) {
    postStock({
      orgId: req.org.id, productId: entry.productId, warehouseId: entry.warehouseId,
      type: 'sales_return', qty: Math.abs(Number(entry.qty) || 0), rate: entry.rate,
      refType: 'credit_note', refId: note.id, refNumber: note.number,
      note: `Stock return against ${inv.number}`
    });
  }
  for (const amc of store.find('amcContracts', a => a.orgId === req.org.id && a.invoiceId === inv.id && !['cancelled', 'renewed'].includes(a.status))) {
    store.update('amcContracts', amc.id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
  }
  if (inv.sourceType === 'sales_order' && inv.sourceId) {
    const so = store.findOne('salesOrders', order => order.id === inv.sourceId && order.orgId === req.org.id);
    if (so) {
      for (const line of inv.lines || []) {
        const originalLine = Number.isInteger(line.soIndex) ? so.lines[line.soIndex] : null;
        if (originalLine) originalLine.invoicedQty = r2(Math.max(0, (Number(originalLine.invoicedQty) || 0) - (Number(line.qty) || 0)));
      }
      const hasInvoices = so.lines.some(line => (Number(line.invoicedQty) || 0) > 0);
      store.update('salesOrders', so.id, { lines: so.lines, status: hasInvoices ? 'partial' : 'confirmed' });
    }
  }
  store.update('invoices', inv.id, { status: 'credited', creditNoteId: note.id });
  audit(req.org.id, req.user.id, 'create', 'credit_note', note.id, { number: note.number, invoice: inv.number });
  res.json({ creditNote: note });
});

/* ================= RECEIPTS ================= */
router.get('/receipts', requirePerm('sales', 'view'), (req, res) => {
  const list = store.find('receipts', r => r.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({ ...r, customerName: (store.byId('customers', r.customerId) || {}).name || '-' }));
  res.json({ receipts: list });
});

router.post('/receipts', requirePerm('sales', 'edit'), (req, res) => {
  const b = req.body || {};
  const customer = b.customerId ? store.findOne('customers', c => c.id === b.customerId && c.orgId === req.org.id) : null;
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const amount = r2(Number(b.amount) || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

  /* Validate the complete request before mutating any invoice. */
  const allocations = [];
  let allocated = 0;
  const seen = new Set();
  for (const a of (b.allocations || [])) {
    const inv = store.findOne('invoices', i => i.id === a.invoiceId && i.orgId === req.org.id);
    if (!inv) return res.status(400).json({ error: 'Invalid invoice in allocation' });
    if (inv.customerId !== customer.id) return res.status(400).json({ error: `Invoice ${inv.number} belongs to a different customer` });
    if (['cancelled', 'credited'].includes(inv.status)) return res.status(400).json({ error: `Invoice ${inv.number} cannot receive payment in status ${inv.status}` });
    if (seen.has(inv.id)) return res.status(400).json({ error: `Invoice ${inv.number} is allocated more than once` });
    seen.add(inv.id);
    const due = r2((inv.totals?.grandTotal || 0) - (inv.paidAmount || 0));
    const amt = r2(Number(a.amount) || 0);
    if (amt <= 0) return res.status(400).json({ error: 'Allocation amounts must be positive' });
    if (amt > due + 0.01) return res.status(400).json({ error: `Allocation exceeds the balance of invoice ${inv.number}` });
    allocations.push({ invoiceId: inv.id, amount: amt, invoice: inv });
    allocated = r2(allocated + amt);
  }
  if (allocated <= 0) return res.status(400).json({ error: 'No valid allocations (check invoice balances)' });
  if (allocated > amount + 0.01) return res.status(400).json({ error: 'Allocated total exceeds receipt amount' });
  if (Math.abs(allocated - amount) > 0.01) return res.status(400).json({ error: 'Receipt amount must be fully allocated' });

  for (const allocation of allocations) {
    const newPaid = r2((allocation.invoice.paidAmount || 0) + allocation.amount);
    store.update('invoices', allocation.invoice.id, {
      paidAmount: newPaid,
      status: newPaid >= (allocation.invoice.totals?.grandTotal || 0) ? 'paid' : 'partial'
    });
  }

  const rcp = store.insert('receipts', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'receipt'),
    customerId: customer.id, date: b.date || new Date().toISOString().slice(0, 10),
    amount: allocated, mode: b.mode || 'bank',
    reference: b.reference || '',
    allocations: allocations.map(({ invoiceId, amount: allocationAmount }) => ({ invoiceId, amount: allocationAmount })),
    note: b.note || ''
  });
  postReceiptJournal(rcp, req.user);
  audit(req.org.id, req.user.id, 'create', 'receipt', rcp.id, { number: rcp.number, amount: allocated });
  res.json({ receipt: rcp });
});

module.exports = router;

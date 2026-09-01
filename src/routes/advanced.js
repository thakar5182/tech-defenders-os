/**
 * Tech Defenders OS v3 operational foundation.
 *
 * This router deliberately keeps external providers behind explicit adapters.
 * A provider is never reported as working merely because its UI exists.
 */
'use strict';
const express = require('express');
const http = require('http');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, nextNumber, computeDoc, audit, notify, postStock, stockBalance } = require('../util');
const integrations = require('../services/integrations');

const router = express.Router();
router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function page(items, req, defaultLimit = 50) {
  const requested = Math.floor(asNumber(req.query.limit) || defaultLimit);
  const limit = Math.min(200, Math.max(1, requested));
  const pageNo = Math.max(1, Math.floor(asNumber(req.query.page) || 1));
  const q = clean(req.query.q, 100).toLowerCase();
  const filtered = q
    ? items.filter(item => JSON.stringify(item).toLowerCase().includes(q))
    : items;
  const start = (pageNo - 1) * limit;
  return {
    items: filtered.slice(start, start + limit),
    pagination: { page: pageNo, limit, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / limit)) }
  };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function customerFor(orgId, id) {
  return store.findOne('customers', item => item.id === id && item.orgId === orgId);
}

function supplierFor(orgId, id) {
  return store.findOne('suppliers', item => item.id === id && item.orgId === orgId);
}

function normalizeSalesLines(raw, orgId) {
  const incoming = Array.isArray(raw) ? raw : [];
  if (!incoming.length || incoming.length > 100) return { error: 'Add between 1 and 100 line items' };
  const lines = [];
  for (let index = 0; index < incoming.length; index++) {
    const source = incoming[index] || {};
    const product = source.productId
      ? store.findOne('products', item => item.id === source.productId && item.orgId === orgId)
      : null;
    if (source.productId && !product) return { error: `Invalid product on line ${index + 1}` };
    const name = clean(product ? product.name : (source.name || source.description), 200);
    const qty = asNumber(source.qty);
    const rate = asNumber(source.rate !== undefined ? source.rate : (product ? product.salePrice : 0));
    const discountPct = asNumber(source.discountPct);
    const gstRate = asNumber(product ? product.gstRate : source.gstRate);
    if (!name) return { error: `Description is required on line ${index + 1}` };
    if (qty <= 0) return { error: `Quantity must be positive on line ${index + 1}` };
    if (rate < 0 || discountPct < 0 || discountPct > 100 || gstRate < 0 || gstRate > 100) {
      return { error: `Invalid rate, discount or GST on line ${index + 1}` };
    }
    lines.push({
      productId: product ? product.id : null,
      name,
      hsn: clean(product ? product.hsn : source.hsn, 20),
      uom: clean(product ? product.uom : source.uom, 20) || 'Nos',
      qty, rate, discountPct, gstRate
    });
  }
  return { lines };
}

function account(orgId, code) {
  return store.findOne('accounts', item => item.orgId === orgId && item.code === code);
}

function postJournal(orgId, date, narration, refType, refId, lines) {
  const valid = lines.filter(line => line.accountId && (asNumber(line.debit) || asNumber(line.credit)))
    .map(line => ({ accountId: line.accountId, debit: r2(asNumber(line.debit)), credit: r2(asNumber(line.credit)) }));
  const debit = r2(valid.reduce((sum, line) => sum + line.debit, 0));
  const credit = r2(valid.reduce((sum, line) => sum + line.credit, 0));
  if (valid.length < 2 || debit !== credit) return null;
  return store.insert('journals', {
    orgId, number: nextNumber(orgId, 'journal'), date, narration,
    posted: true, refType, refId, lines: valid
  });
}

/* ================= COMPANY / BRANCHES ================= */
router.get('/admin/branches', requirePerm('admin', 'view'), (req, res) => {
  res.json({ branches: store.find('branches', item => item.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post('/admin/branches', requirePerm('admin', 'create'), (req, res) => {
  const body = req.body || {};
  const name = clean(body.name, 120);
  if (!name) return res.status(400).json({ error: 'Branch name is required' });
  const code = clean(body.code, 20).toUpperCase();
  if (code && store.findOne('branches', item => item.orgId === req.org.id && item.code === code)) {
    return res.status(409).json({ error: 'Branch code already exists' });
  }
  const branch = store.insert('branches', {
    orgId: req.org.id, name, code, gstin: clean(body.gstin, 20),
    stateCode: clean(body.stateCode || req.org.stateCode, 4),
    address: clean(body.address, 500), active: body.active !== false
  });
  audit(req.org.id, req.user.id, 'create', 'branch', branch.id, { code, name });
  res.status(201).json({ branch });
});

router.patch('/admin/branches/:id', requirePerm('admin', 'edit'), (req, res) => {
  const branch = store.findOne('branches', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const patch = {};
  for (const key of ['name', 'code', 'gstin', 'stateCode', 'address']) {
    if (req.body[key] !== undefined) patch[key] = clean(req.body[key], key === 'address' ? 500 : 120);
  }
  if (req.body.active !== undefined) patch.active = !!req.body.active;
  const updated = store.update('branches', branch.id, patch);
  audit(req.org.id, req.user.id, 'update', 'branch', branch.id, patch);
  res.json({ branch: updated });
});

/* ================= CRM INTELLIGENCE ================= */
function scoreLead(lead, orgId) {
  let score = 0;
  const reasons = [];
  if (lead.email) { score += 15; reasons.push('email'); }
  if (lead.phone) { score += 15; reasons.push('phone'); }
  if (lead.company) { score += 10; reasons.push('company'); }
  if (asNumber(lead.value) > 0) { score += Math.min(25, Math.round(asNumber(lead.value) / 10000)); reasons.push('value'); }
  if (['qualified', 'proposal', 'negotiation'].includes(lead.status)) { score += 25; reasons.push('stage'); }
  const activities = store.find('activities', item => item.orgId === orgId && item.entityType === 'lead' && item.entityId === lead.id).length;
  score += Math.min(10, activities * 2);
  if (activities) reasons.push('activity');
  return { score: Math.min(100, score), reasons };
}

router.get('/crm/lead-insights', requirePerm('crm', 'view'), (req, res) => {
  const leads = store.find('leads', item => item.orgId === req.org.id)
    .map(lead => ({ ...lead, intelligence: scoreLead(lead, req.org.id) }))
    .sort((a, b) => b.intelligence.score - a.intelligence.score);
  const paged = page(leads, req);
  res.json({ leads: paged.items, pagination: paged.pagination });
});

function duplicateKey(lead) {
  const email = clean(lead.email, 150).toLowerCase();
  const phone = clean(lead.phone, 30).replace(/\D/g, '');
  return email ? `e:${email}` : (phone ? `p:${phone}` : '');
}

router.post('/crm/lead-deduplicate', requirePerm('crm', 'edit'), (req, res) => {
  const groups = {};
  for (const lead of store.find('leads', item => item.orgId === req.org.id)) {
    const key = duplicateKey(lead);
    if (!key) continue;
    groups[key] = groups[key] || [];
    groups[key].push(lead);
  }
  const duplicates = Object.entries(groups).filter(([, records]) => records.length > 1)
    .map(([key, records]) => ({ key, records }));
  let removed = 0;
  if (req.body && req.body.merge === true) {
    for (const group of duplicates) {
      const [primary, ...rest] = group.records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const duplicate of rest) {
        for (const activity of store.find('activities', item => item.orgId === req.org.id && item.entityType === 'lead' && item.entityId === duplicate.id)) {
          store.update('activities', activity.id, { entityId: primary.id });
        }
        store.remove('leads', duplicate.id);
        removed++;
      }
    }
    audit(req.org.id, req.user.id, 'merge_duplicates', 'lead', null, { groups: duplicates.length, removed });
  }
  res.json({ duplicateGroups: duplicates.length, duplicates, merged: req.body && req.body.merge === true, removed });
});

router.post('/crm/leads-import', requirePerm('crm', 'create'), (req, res) => {
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  if (!records.length || records.length > 500) return res.status(400).json({ error: 'Provide 1 to 500 lead records' });
  let imported = 0, skipped = 0;
  const errors = [];
  for (let index = 0; index < records.length; index++) {
    const source = records[index] || {};
    const name = clean(source.name, 120);
    if (!name) { errors.push({ row: index + 1, error: 'Name is required' }); continue; }
    const candidate = { email: clean(source.email, 150), phone: clean(source.phone, 30) };
    const key = duplicateKey(candidate);
    const exists = key && store.findOne('leads', lead => lead.orgId === req.org.id && duplicateKey(lead) === key);
    if (exists) { skipped++; continue; }
    store.insert('leads', {
      orgId: req.org.id, name, company: clean(source.company, 120), email: candidate.email,
      phone: candidate.phone, source: clean(source.source, 60) || 'import', status: 'new',
      value: r2(Math.max(0, asNumber(source.value))), assignedTo: req.user.id,
      notes: clean(source.notes, 1000)
    });
    imported++;
  }
  audit(req.org.id, req.user.id, 'import', 'lead', null, { imported, skipped, errors: errors.length });
  res.json({ imported, skipped, errors });
});

router.get('/crm/leads-export', requirePerm('crm', 'export'), (req, res) => {
  const escape = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const rows = [['Name', 'Company', 'Email', 'Phone', 'Source', 'Status', 'Value']]
    .concat(store.find('leads', item => item.orgId === req.org.id).map(item => [
      item.name, item.company, item.email, item.phone, item.source, item.status, item.value
    ]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tech-defenders-leads.csv"');
  res.send('\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n'));
});

/* ================= ADVANCED SALES DOCUMENTS ================= */
function listSalesDoc(collection, req) {
  return store.find(collection, item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({ ...item, customerName: (store.byId('customers', item.customerId) || {}).name || '-' }));
}

function createTaxDocument(req, res, collection, type, initialStatus) {
  const body = req.body || {};
  const customer = customerFor(req.org.id, body.customerId);
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const normalized = normalizeSalesLines(body.lines, req.org.id);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const date = body.date || today();
  if (!validDate(date)) return res.status(400).json({ error: 'Date must use YYYY-MM-DD' });
  const place = clean(body.placeOfSupply || customer.stateCode || req.org.stateCode, 4);
  const calculated = computeDoc(normalized.lines, req.org.stateCode, place);
  const record = store.insert(collection, {
    orgId: req.org.id, number: nextNumber(req.org.id, type), customerId: customer.id,
    date, validUntil: body.validUntil || null, placeOfSupply: place,
    status: initialStatus, lines: calculated.lines, totals: calculated.totals,
    notes: clean(body.notes, 2000), sourceType: clean(body.sourceType, 40) || 'manual',
    sourceId: body.sourceId || null, convertedToId: null
  });
  audit(req.org.id, req.user.id, 'create', type, record.id, { number: record.number });
  res.status(201).json({ document: record });
}

router.get('/sales/proformas', requirePerm('sales', 'view'), (req, res) => res.json({ proformas: listSalesDoc('proformas', req) }));
router.post('/sales/proformas', requirePerm('sales', 'create'), (req, res) => createTaxDocument(req, res, 'proformas', 'proforma', 'draft'));

router.post('/sales/proformas/:id/convert-invoice', requirePerm('sales', 'edit'), (req, res) => {
  const proforma = store.findOne('proformas', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!proforma) return res.status(404).json({ error: 'Proforma not found' });
  if (proforma.convertedToId) return res.status(409).json({ error: 'Proforma already converted' });
  const customer = customerFor(req.org.id, proforma.customerId);
  if (!customer) return res.status(400).json({ error: 'Customer no longer exists' });
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + (asNumber(customer.paymentTermsDays) || 30));
  const invoice = store.insert('invoices', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'invoice'), customerId: customer.id,
    date: today(), dueDate: due.toISOString().slice(0, 10), placeOfSupply: proforma.placeOfSupply,
    status: 'unpaid', paidAmount: 0, lines: proforma.lines, totals: proforma.totals,
    sourceType: 'proforma', sourceId: proforma.id, notes: proforma.notes, warehouseId: null
  });
  const ar = account(req.org.id, '1100');
  const income = account(req.org.id, '4000');
  const gst = account(req.org.id, '2100');
  postJournal(req.org.id, invoice.date, `Sales invoice ${invoice.number}`, 'invoice', invoice.id, [
    { accountId: ar && ar.id, debit: invoice.totals.grandTotal, credit: 0 },
    { accountId: income && income.id, debit: 0, credit: invoice.totals.taxable },
    { accountId: gst && gst.id, debit: 0, credit: r2(invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst) }
  ]);
  store.update('proformas', proforma.id, { status: 'converted', convertedToId: invoice.id });
  audit(req.org.id, req.user.id, 'convert', 'proforma', proforma.id, { invoiceId: invoice.id });
  res.json({ invoice });
});

router.get('/sales/delivery-challans', requirePerm('sales', 'view'), (req, res) => res.json({ deliveryChallans: listSalesDoc('deliveryChallans', req) }));
router.post('/sales/delivery-challans', requirePerm('sales', 'create'), (req, res) => {
  const body = req.body || {};
  const customer = customerFor(req.org.id, body.customerId);
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const normalized = normalizeSalesLines(body.lines, req.org.id);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const challan = store.insert('deliveryChallans', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'deliveryChallan'), customerId: customer.id,
    date: body.date || today(), status: 'issued', lines: normalized.lines,
    vehicleNo: clean(body.vehicleNo, 30), transporter: clean(body.transporter, 120),
    ewayBillNo: clean(body.ewayBillNo, 30), notes: clean(body.notes, 2000),
    sourceType: clean(body.sourceType, 40) || 'manual', sourceId: body.sourceId || null
  });
  audit(req.org.id, req.user.id, 'create', 'delivery_challan', challan.id, { number: challan.number });
  res.status(201).json({ deliveryChallan: challan });
});

router.get('/sales/debit-notes', requirePerm('sales', 'view'), (req, res) => res.json({ debitNotes: listSalesDoc('debitNotes', req) }));
router.post('/sales/debit-notes', requirePerm('sales', 'edit'), (req, res) => {
  const body = req.body || {};
  const customer = customerFor(req.org.id, body.customerId);
  if (!customer) return res.status(400).json({ error: 'Valid customerId is required' });
  const normalized = normalizeSalesLines(body.lines, req.org.id);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const calculated = computeDoc(normalized.lines, req.org.stateCode, customer.stateCode);
  const note = store.insert('debitNotes', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'debitNote'), customerId: customer.id,
    date: body.date || today(), status: 'posted', reason: clean(body.reason, 500),
    lines: calculated.lines, totals: calculated.totals, invoiceId: body.invoiceId || null
  });
  const ar = account(req.org.id, '1100');
  const income = account(req.org.id, '4000');
  const gst = account(req.org.id, '2100');
  postJournal(req.org.id, note.date, `Debit note ${note.number}`, 'debit_note', note.id, [
    { accountId: ar && ar.id, debit: note.totals.grandTotal, credit: 0 },
    { accountId: income && income.id, debit: 0, credit: note.totals.taxable },
    { accountId: gst && gst.id, debit: 0, credit: r2(note.totals.cgst + note.totals.sgst + note.totals.igst) }
  ]);
  audit(req.org.id, req.user.id, 'create', 'debit_note', note.id, { number: note.number });
  res.status(201).json({ debitNote: note });
});

/* ================= PURCHASE BILLING / VENDOR LEDGER ================= */
function normalizePurchaseLines(raw, orgId) {
  const incoming = Array.isArray(raw) ? raw : [];
  if (!incoming.length || incoming.length > 100) return { error: 'Add between 1 and 100 line items' };
  const lines = [];
  for (let index = 0; index < incoming.length; index++) {
    const source = incoming[index] || {};
    const product = source.productId
      ? store.findOne('products', item => item.id === source.productId && item.orgId === orgId)
      : null;
    if (source.productId && !product) return { error: `Invalid product on line ${index + 1}` };
    const description = clean(product ? product.name : source.description, 200);
    const qty = asNumber(source.qty);
    const rate = asNumber(source.rate);
    const taxPct = asNumber(source.taxPct);
    if (!description || qty <= 0 || rate < 0 || taxPct < 0 || taxPct > 100) return { error: `Invalid line ${index + 1}` };
    const taxable = r2(qty * rate);
    const tax = r2(taxable * taxPct / 100);
    lines.push({ productId: product ? product.id : null, description, qty, rate, taxPct, taxable, tax, total: r2(taxable + tax) });
  }
  return { lines };
}

router.get('/purchase/invoices', requirePerm('purchase', 'view'), (req, res) => {
  const items = store.find('purchaseInvoices', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({ ...item, supplierName: (store.byId('suppliers', item.supplierId) || {}).name || '-' }));
  const paged = page(items, req);
  res.json({ purchaseInvoices: paged.items, pagination: paged.pagination });
});

router.post('/purchase/invoices', requirePerm('purchase', 'create'), (req, res) => {
  const body = req.body || {};
  const supplier = supplierFor(req.org.id, body.supplierId);
  if (!supplier) return res.status(400).json({ error: 'Valid supplierId is required' });
  const supplierInvoiceNo = clean(body.supplierInvoiceNo, 80);
  if (!supplierInvoiceNo) return res.status(400).json({ error: 'Supplier invoice number is required' });
  if (store.findOne('purchaseInvoices', item => item.orgId === req.org.id && item.supplierId === supplier.id && item.supplierInvoiceNo.toLowerCase() === supplierInvoiceNo.toLowerCase())) {
    return res.status(409).json({ error: 'This supplier invoice number already exists' });
  }
  const normalized = normalizePurchaseLines(body.lines, req.org.id);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const subtotal = r2(normalized.lines.reduce((sum, line) => sum + line.taxable, 0));
  const tax = r2(normalized.lines.reduce((sum, line) => sum + line.tax, 0));
  const total = r2(subtotal + tax);
  const invoice = store.insert('purchaseInvoices', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'purchaseInvoice'), supplierId: supplier.id,
    supplierInvoiceNo, date: body.date || today(), dueDate: body.dueDate || null,
    poId: body.poId || null, grnId: body.grnId || null, status: 'unpaid', paidAmount: 0,
    lines: normalized.lines, totals: { taxable: subtotal, tax, grandTotal: total }, notes: clean(body.notes, 2000)
  });
  const purchases = account(req.org.id, '5700') || account(req.org.id, '1200');
  const gstInput = account(req.org.id, '1300');
  const ap = account(req.org.id, '2000');
  postJournal(req.org.id, invoice.date, `Purchase invoice ${invoice.number}`, 'purchase_invoice', invoice.id, [
    { accountId: purchases && purchases.id, debit: subtotal, credit: 0 },
    { accountId: gstInput && gstInput.id, debit: tax, credit: 0 },
    { accountId: ap && ap.id, debit: 0, credit: total }
  ]);
  audit(req.org.id, req.user.id, 'create', 'purchase_invoice', invoice.id, { number: invoice.number, supplierInvoiceNo });
  res.status(201).json({ purchaseInvoice: invoice });
});

router.get('/purchase/returns', requirePerm('purchase', 'view'), (req, res) => {
  const items = store.find('purchaseReturns', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({ ...item, supplierName: (store.byId('suppliers', item.supplierId) || {}).name || '-' }));
  res.json({ purchaseReturns: items });
});

router.post('/purchase/returns', requirePerm('purchase', 'edit'), (req, res) => {
  const body = req.body || {};
  const invoice = store.findOne('purchaseInvoices', item => item.id === body.purchaseInvoiceId && item.orgId === req.org.id);
  if (!invoice) return res.status(404).json({ error: 'Purchase invoice not found' });
  const warehouse = body.warehouseId
    ? store.findOne('warehouses', item => item.id === body.warehouseId && item.orgId === req.org.id)
    : null;
  const lines = [];
  for (const requested of Array.isArray(body.lines) ? body.lines : []) {
    const source = invoice.lines[asNumber(requested.index)];
    const qty = asNumber(requested.qty);
    if (!source || qty <= 0 || qty > source.qty) return res.status(400).json({ error: 'Invalid return line or quantity' });
    if (source.productId && !warehouse) return res.status(400).json({ error: 'Warehouse is required for stock returns' });
    if (source.productId && stockBalance(req.org.id, source.productId, warehouse.id) < qty) {
      return res.status(400).json({ error: `Insufficient stock to return ${source.description}` });
    }
    const taxable = r2(qty * source.rate);
    const tax = r2(taxable * source.taxPct / 100);
    lines.push({ ...source, qty, taxable, tax, total: r2(taxable + tax) });
  }
  if (!lines.length) return res.status(400).json({ error: 'At least one return line is required' });
  const subtotal = r2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const tax = r2(lines.reduce((sum, line) => sum + line.tax, 0));
  const total = r2(subtotal + tax);
  const record = store.insert('purchaseReturns', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'purchaseReturn'),
    purchaseInvoiceId: invoice.id, supplierId: invoice.supplierId,
    date: body.date || today(), reason: clean(body.reason, 500), status: 'posted',
    warehouseId: warehouse ? warehouse.id : null, lines, totals: { taxable: subtotal, tax, grandTotal: total }
  });
  for (const line of lines.filter(item => item.productId)) {
    postStock({
      orgId: req.org.id, productId: line.productId, warehouseId: warehouse.id,
      date: record.date, type: 'purchase_return', qty: -line.qty, rate: line.rate,
      refType: 'purchase_return', refId: record.id, refNumber: record.number,
      note: `Returned against ${invoice.number}`
    });
  }
  const purchases = account(req.org.id, '5700') || account(req.org.id, '1200');
  const gstInput = account(req.org.id, '1300');
  const ap = account(req.org.id, '2000');
  postJournal(req.org.id, record.date, `Purchase return ${record.number}`, 'purchase_return', record.id, [
    { accountId: ap && ap.id, debit: total, credit: 0 },
    { accountId: purchases && purchases.id, debit: 0, credit: subtotal },
    { accountId: gstInput && gstInput.id, debit: 0, credit: tax }
  ]);
  audit(req.org.id, req.user.id, 'create', 'purchase_return', record.id, { number: record.number });
  res.status(201).json({ purchaseReturn: record });
});

router.get('/purchase/payments', requirePerm('finance', 'view'), (req, res) => {
  const items = store.find('supplierPayments', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({ ...item, supplierName: (store.byId('suppliers', item.supplierId) || {}).name || '-' }));
  res.json({ supplierPayments: items });
});

router.post('/purchase/payments', requirePerm('finance', 'create'), (req, res) => {
  const body = req.body || {};
  const supplier = supplierFor(req.org.id, body.supplierId);
  if (!supplier) return res.status(400).json({ error: 'Valid supplierId is required' });
  const amount = r2(asNumber(body.amount));
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  const allocations = [];
  let allocated = 0;
  for (const source of Array.isArray(body.allocations) ? body.allocations : []) {
    const invoice = store.findOne('purchaseInvoices', item => item.id === source.invoiceId && item.orgId === req.org.id && item.supplierId === supplier.id);
    if (!invoice) return res.status(400).json({ error: 'Invalid invoice allocation' });
    const value = r2(asNumber(source.amount));
    const outstanding = r2(invoice.totals.grandTotal - (invoice.paidAmount || 0));
    if (value <= 0 || value > outstanding) return res.status(400).json({ error: `Allocation exceeds ${invoice.number} outstanding` });
    allocations.push({ invoiceId: invoice.id, amount: value });
    allocated = r2(allocated + value);
  }
  if (allocated > amount) return res.status(400).json({ error: 'Allocations cannot exceed payment amount' });
  const payment = store.insert('supplierPayments', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'supplierPayment'), supplierId: supplier.id,
    date: body.date || today(), amount, mode: clean(body.mode, 30) || 'bank',
    reference: clean(body.reference, 100), allocations, notes: clean(body.notes, 1000)
  });
  for (const allocation of allocations) {
    const invoice = store.byId('purchaseInvoices', allocation.invoiceId);
    const paidAmount = r2((invoice.paidAmount || 0) + allocation.amount);
    store.update('purchaseInvoices', invoice.id, {
      paidAmount, status: paidAmount >= invoice.totals.grandTotal ? 'paid' : 'partial'
    });
  }
  const ap = account(req.org.id, '2000');
  const bank = account(req.org.id, body.mode === 'cash' ? '1000' : '1010');
  postJournal(req.org.id, payment.date, `Supplier payment ${payment.number}`, 'supplier_payment', payment.id, [
    { accountId: ap && ap.id, debit: amount, credit: 0 },
    { accountId: bank && bank.id, debit: 0, credit: amount }
  ]);
  audit(req.org.id, req.user.id, 'create', 'supplier_payment', payment.id, { number: payment.number, amount });
  res.status(201).json({ supplierPayment: payment });
});

router.get('/purchase/vendor-ledger/:supplierId', requirePerm('finance', 'view'), (req, res) => {
  const supplier = supplierFor(req.org.id, req.params.supplierId);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  const rows = [];
  for (const invoice of store.find('purchaseInvoices', item => item.orgId === req.org.id && item.supplierId === supplier.id)) {
    rows.push({ date: invoice.date, type: 'Purchase Invoice', number: invoice.number, debit: 0, credit: invoice.totals.grandTotal });
  }
  for (const note of store.find('purchaseReturns', item => item.orgId === req.org.id && item.supplierId === supplier.id)) {
    rows.push({ date: note.date, type: 'Purchase Return', number: note.number, debit: note.totals.grandTotal, credit: 0 });
  }
  for (const payment of store.find('supplierPayments', item => item.orgId === req.org.id && item.supplierId === supplier.id)) {
    rows.push({ date: payment.date, type: 'Payment', number: payment.number, debit: payment.amount, credit: 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let balance = 0;
  const ledger = rows.map(row => ({ ...row, balance: balance = r2(balance + row.credit - row.debit) }));
  res.json({ supplier, rows: ledger, closingBalance: balance });
});

/* ================= INVENTORY CATEGORIES / RESERVATIONS ================= */
router.get('/inventory/categories', requirePerm('inventory', 'view'), (req, res) => {
  res.json({ categories: store.find('productCategories', item => item.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post('/inventory/categories', requirePerm('inventory', 'create'), (req, res) => {
  const name = clean(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (store.findOne('productCategories', item => item.orgId === req.org.id && item.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Category already exists' });
  }
  const category = store.insert('productCategories', { orgId: req.org.id, name, code: clean(req.body.code, 30), active: true });
  audit(req.org.id, req.user.id, 'create', 'product_category', category.id, { name });
  res.status(201).json({ category });
});

router.get('/inventory/reservations', requirePerm('inventory', 'view'), (req, res) => {
  const items = store.find('stockReservations', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(item => ({
      ...item,
      productName: (store.byId('products', item.productId) || {}).name || '-',
      warehouseName: (store.byId('warehouses', item.warehouseId) || {}).name || '-'
    }));
  res.json({ reservations: items });
});

router.post('/inventory/reservations', requirePerm('inventory', 'edit'), (req, res) => {
  const body = req.body || {};
  const product = store.findOne('products', item => item.id === body.productId && item.orgId === req.org.id);
  const warehouse = store.findOne('warehouses', item => item.id === body.warehouseId && item.orgId === req.org.id);
  if (!product || !warehouse) return res.status(400).json({ error: 'Valid product and warehouse are required' });
  const qty = r2(asNumber(body.qty));
  if (qty <= 0) return res.status(400).json({ error: 'Quantity must be positive' });
  const reserved = store.find('stockReservations', item => item.orgId === req.org.id && item.productId === product.id && item.warehouseId === warehouse.id && item.status === 'active')
    .reduce((sum, item) => sum + asNumber(item.qty), 0);
  const onHand = stockBalance(req.org.id, product.id, warehouse.id);
  if (onHand - reserved < qty) return res.status(400).json({ error: `Only ${r2(onHand - reserved)} is available to reserve` });
  const reservation = store.insert('stockReservations', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'reservation'), productId: product.id,
    warehouseId: warehouse.id, qty, status: 'active', sourceType: clean(body.sourceType, 40) || 'manual',
    sourceId: body.sourceId || null, expiresOn: body.expiresOn || null, note: clean(body.note, 500)
  });
  audit(req.org.id, req.user.id, 'create', 'stock_reservation', reservation.id, { number: reservation.number, qty });
  res.status(201).json({ reservation, onHand, available: r2(onHand - reserved - qty) });
});

router.patch('/inventory/reservations/:id/release', requirePerm('inventory', 'edit'), (req, res) => {
  const item = store.findOne('stockReservations', record => record.id === req.params.id && record.orgId === req.org.id);
  if (!item) return res.status(404).json({ error: 'Reservation not found' });
  if (item.status !== 'active') return res.status(400).json({ error: 'Reservation is already closed' });
  const reservation = store.update('stockReservations', item.id, { status: 'released', releasedAt: new Date().toISOString(), releasedBy: req.user.id });
  audit(req.org.id, req.user.id, 'release', 'stock_reservation', item.id, { number: item.number });
  res.json({ reservation });
});

router.get('/inventory/availability/:productId', requirePerm('inventory', 'view'), (req, res) => {
  const product = store.findOne('products', item => item.id === req.params.productId && item.orgId === req.org.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const rows = store.find('warehouses', item => item.orgId === req.org.id).map(warehouse => {
    const onHand = stockBalance(req.org.id, product.id, warehouse.id);
    const reserved = r2(store.find('stockReservations', item => item.orgId === req.org.id && item.productId === product.id && item.warehouseId === warehouse.id && item.status === 'active')
      .reduce((sum, item) => sum + asNumber(item.qty), 0));
    return { warehouseId: warehouse.id, warehouseName: warehouse.name, onHand, reserved, available: r2(onHand - reserved) };
  });
  res.json({ product, warehouses: rows, totalAvailable: r2(rows.reduce((sum, row) => sum + row.available, 0)) });
});

/* ================= FINANCE LEDGERS / STATEMENTS ================= */
function accountBalances(orgId) {
  const rows = new Map();
  for (const item of store.find('accounts', accountItem => accountItem.orgId === orgId)) {
    rows.set(item.id, { id: item.id, code: item.code, name: item.name, type: item.type, debit: 0, credit: 0, balance: 0 });
  }
  for (const journal of store.find('journals', item => item.orgId === orgId && item.posted)) {
    for (const line of journal.lines || []) {
      const row = rows.get(line.accountId);
      if (!row) continue;
      row.debit = r2(row.debit + asNumber(line.debit));
      row.credit = r2(row.credit + asNumber(line.credit));
      row.balance = r2(row.debit - row.credit);
    }
  }
  return [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
}

router.get('/finance/general-ledger', requirePerm('finance', 'view'), (req, res) => {
  const accountId = clean(req.query.accountId, 100);
  if (accountId && !store.findOne('accounts', item => item.id === accountId && item.orgId === req.org.id)) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const rows = [];
  for (const journal of store.find('journals', item => item.orgId === req.org.id && item.posted)) {
    for (const line of journal.lines || []) {
      if (accountId && line.accountId !== accountId) continue;
      const ledgerAccount = store.byId('accounts', line.accountId);
      rows.push({
        date: journal.date, journalNumber: journal.number, narration: journal.narration,
        accountId: line.accountId, accountCode: ledgerAccount ? ledgerAccount.code : '',
        accountName: ledgerAccount ? ledgerAccount.name : 'Unknown', debit: asNumber(line.debit), credit: asNumber(line.credit)
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.journalNumber.localeCompare(b.journalNumber));
  const balances = {};
  const output = rows.map(row => {
    balances[row.accountId] = r2((balances[row.accountId] || 0) + row.debit - row.credit);
    return { ...row, runningBalance: balances[row.accountId] };
  });
  const paged = page(output, req, 100);
  res.json({ rows: paged.items, pagination: paged.pagination });
});

router.get('/finance/customer-ledger/:customerId', requirePerm('finance', 'view'), (req, res) => {
  const customer = customerFor(req.org.id, req.params.customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const rows = [];
  for (const invoice of store.find('invoices', item => item.orgId === req.org.id && item.customerId === customer.id && item.status !== 'cancelled')) {
    rows.push({ date: invoice.date, type: 'Invoice', number: invoice.number, debit: invoice.totals.grandTotal, credit: 0 });
  }
  for (const receipt of store.find('receipts', item => item.orgId === req.org.id && item.customerId === customer.id)) {
    rows.push({ date: receipt.date, type: 'Receipt', number: receipt.number, debit: 0, credit: receipt.amount });
  }
  for (const note of store.find('creditNotes', item => item.orgId === req.org.id && item.customerId === customer.id && item.status !== 'cancelled')) {
    rows.push({ date: note.date, type: 'Credit Note', number: note.number, debit: 0, credit: note.totals.grandTotal });
  }
  for (const note of store.find('debitNotes', item => item.orgId === req.org.id && item.customerId === customer.id)) {
    rows.push({ date: note.date, type: 'Debit Note', number: note.number, debit: note.totals.grandTotal, credit: 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let balance = 0;
  const ledger = rows.map(row => ({ ...row, balance: balance = r2(balance + row.debit - row.credit) }));
  res.json({ customer, rows: ledger, closingBalance: balance });
});

router.get('/finance/balance-sheet', requirePerm('finance', 'view'), (req, res) => {
  const balances = accountBalances(req.org.id);
  const normalized = balances.map(row => ({ ...row, statementBalance: ['liability', 'equity', 'income'].includes(row.type) ? r2(-row.balance) : row.balance }));
  const assets = normalized.filter(row => row.type === 'asset');
  const liabilities = normalized.filter(row => row.type === 'liability');
  const equity = normalized.filter(row => row.type === 'equity');
  const income = normalized.filter(row => row.type === 'income').reduce((sum, row) => sum + row.statementBalance, 0);
  const expenses = normalized.filter(row => row.type === 'expense').reduce((sum, row) => sum + row.statementBalance, 0);
  const currentProfit = r2(income - expenses);
  res.json({
    assets, liabilities, equity, currentProfit,
    totals: {
      assets: r2(assets.reduce((sum, row) => sum + row.statementBalance, 0)),
      liabilities: r2(liabilities.reduce((sum, row) => sum + row.statementBalance, 0)),
      equity: r2(equity.reduce((sum, row) => sum + row.statementBalance, 0) + currentProfit)
    }
  });
});

router.get('/finance/cash-flow', requirePerm('finance', 'view'), (req, res) => {
  const cashIds = store.find('accounts', item => item.orgId === req.org.id && ['1000', '1010'].includes(item.code)).map(item => item.id);
  const rows = [];
  for (const journal of store.find('journals', item => item.orgId === req.org.id && item.posted)) {
    const cashLines = (journal.lines || []).filter(line => cashIds.includes(line.accountId));
    for (const line of cashLines) {
      rows.push({
        date: journal.date, number: journal.number, narration: journal.narration,
        inflow: asNumber(line.debit), outflow: asNumber(line.credit), net: r2(asNumber(line.debit) - asNumber(line.credit))
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  res.json({
    rows,
    totals: {
      inflow: r2(rows.reduce((sum, row) => sum + row.inflow, 0)),
      outflow: r2(rows.reduce((sum, row) => sum + row.outflow, 0)),
      net: r2(rows.reduce((sum, row) => sum + row.net, 0))
    }
  });
});

router.get('/finance/bank-transactions', requirePerm('finance', 'view'), (req, res) => {
  res.json({ bankTransactions: store.find('bankTransactions', item => item.orgId === req.org.id).sort((a, b) => b.date.localeCompare(a.date)) });
});

router.post('/finance/bank-transactions', requirePerm('finance', 'create'), (req, res) => {
  const body = req.body || {};
  const amount = r2(asNumber(body.amount));
  if (amount <= 0 || !['credit', 'debit'].includes(body.direction)) return res.status(400).json({ error: 'Positive amount and credit/debit direction are required' });
  const transaction = store.insert('bankTransactions', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'bankTransaction'),
    date: body.date || today(), amount, direction: body.direction,
    reference: clean(body.reference, 120), description: clean(body.description, 500),
    reconciled: false, journalId: null
  });
  audit(req.org.id, req.user.id, 'create', 'bank_transaction', transaction.id, { number: transaction.number });
  res.status(201).json({ bankTransaction: transaction });
});

router.patch('/finance/bank-transactions/:id/reconcile', requirePerm('finance', 'edit'), (req, res) => {
  const transaction = store.findOne('bankTransactions', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!transaction) return res.status(404).json({ error: 'Bank transaction not found' });
  const journal = req.body.journalId
    ? store.findOne('journals', item => item.id === req.body.journalId && item.orgId === req.org.id)
    : null;
  if (req.body.journalId && !journal) return res.status(400).json({ error: 'Journal not found' });
  const updated = store.update('bankTransactions', transaction.id, {
    reconciled: !!req.body.reconciled, journalId: journal ? journal.id : null,
    reconciledBy: req.body.reconciled ? req.user.id : null,
    reconciledAt: req.body.reconciled ? new Date().toISOString() : null
  });
  audit(req.org.id, req.user.id, 'reconcile', 'bank_transaction', transaction.id, { reconciled: updated.reconciled });
  res.json({ bankTransaction: updated });
});

/* ================= CONFIGURABLE APPROVALS ================= */
router.get('/approvals/workflows', requirePerm('admin', 'view'), (req, res) => {
  res.json({ workflows: store.find('approvalWorkflows', item => item.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post('/approvals/workflows', requirePerm('admin', 'create'), (req, res) => {
  const body = req.body || {};
  const name = clean(body.name, 120);
  const entityType = clean(body.entityType, 60);
  const approverRole = clean(body.approverRole, 60);
  if (!name || !entityType || !approverRole) return res.status(400).json({ error: 'Name, entity type and approver role are required' });
  const workflow = store.insert('approvalWorkflows', {
    orgId: req.org.id, name, entityType, approverRole,
    minimumAmount: r2(Math.max(0, asNumber(body.minimumAmount))), active: body.active !== false,
    steps: [{ order: 1, approverRole }]
  });
  audit(req.org.id, req.user.id, 'create', 'approval_workflow', workflow.id, { name });
  res.status(201).json({ workflow });
});

router.patch('/approvals/workflows/:id', requirePerm('admin', 'edit'), (req, res) => {
  const workflow = store.findOne('approvalWorkflows', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  const updated = store.update('approvalWorkflows', workflow.id, {
    name: req.body.name !== undefined ? clean(req.body.name, 120) : workflow.name,
    approverRole: req.body.approverRole !== undefined ? clean(req.body.approverRole, 60) : workflow.approverRole,
    minimumAmount: req.body.minimumAmount !== undefined ? r2(Math.max(0, asNumber(req.body.minimumAmount))) : workflow.minimumAmount,
    active: req.body.active !== undefined ? !!req.body.active : workflow.active
  });
  audit(req.org.id, req.user.id, 'update', 'approval_workflow', workflow.id, { active: updated.active });
  res.json({ workflow: updated });
});

router.get('/approvals/requests', requirePerm('admin', 'view'), (req, res) => {
  const items = store.find('approvalRequests', item => item.orgId === req.org.id)
    .filter(item => req.user.role === 'super_admin' || req.user.role === 'admin' || item.approverRole === req.user.role || item.requestedBy === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ approvalRequests: items });
});

router.post('/approvals/requests', (req, res) => {
  const body = req.body || {};
  const entityType = clean(body.entityType, 60);
  const entityId = clean(body.entityId, 100);
  const workflow = body.workflowId
    ? store.findOne('approvalWorkflows', item => item.id === body.workflowId && item.orgId === req.org.id && item.active)
    : store.findOne('approvalWorkflows', item => item.orgId === req.org.id && item.entityType === entityType && item.active && asNumber(body.amount) >= asNumber(item.minimumAmount));
  if (!entityType || !entityId || !workflow) return res.status(400).json({ error: 'A matching active approval workflow is required' });
  if (store.findOne('approvalRequests', item => item.orgId === req.org.id && item.entityType === entityType && item.entityId === entityId && item.status === 'pending')) {
    return res.status(409).json({ error: 'A pending request already exists for this record' });
  }
  const request = store.insert('approvalRequests', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'approval'), workflowId: workflow.id,
    entityType, entityId, entityNumber: clean(body.entityNumber, 80), amount: r2(asNumber(body.amount)),
    requestedBy: req.user.id, approverRole: workflow.approverRole, status: 'pending', decisions: []
  });
  notify(req.org.id, { title: 'Approval requested', body: `${request.number} requires ${workflow.approverRole}`, type: 'warning', link: '#/admin/approvals' });
  audit(req.org.id, req.user.id, 'request', 'approval', request.id, { number: request.number });
  res.status(201).json({ approvalRequest: request });
});

router.post('/approvals/requests/:id/decision', (req, res) => {
  const request = store.findOne('approvalRequests', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is already decided' });
  if (!['super_admin', 'admin', request.approverRole].includes(req.user.role)) return res.status(403).json({ error: 'This request is assigned to another role' });
  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const entry = { decision, by: req.user.id, at: new Date().toISOString(), note: clean(req.body.note, 500) };
  const updated = store.update('approvalRequests', request.id, { status: decision, decisions: [...request.decisions, entry] });
  notify(req.org.id, { title: `Approval ${decision}`, body: `${request.number} was ${decision}`, type: decision === 'approved' ? 'success' : 'danger' });
  audit(req.org.id, req.user.id, decision, 'approval', request.id, { note: entry.note });
  res.json({ approvalRequest: updated });
});

/* ================= AI PROVIDER (LOCAL OLLAMA) ================= */
function ollamaConfig() {
  const enabled = process.env.OLLAMA_ENABLED === 'true';
  const url = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  let parsed;
  try { parsed = new URL(url); } catch (_) { parsed = null; }
  const safeLocal = parsed && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  return { enabled, url, safeLocal, model: process.env.OLLAMA_MODEL || 'qwen3:4b' };
}

router.get('/ai/status', requirePerm('sales', 'view'), (req, res) => {
  const config = ollamaConfig();
  res.json({
    provider: 'ollama', enabled: config.enabled, configured: config.enabled && !!config.model && config.safeLocal,
    model: config.model, mode: 'local', reviewRequired: true,
    message: !config.enabled ? 'Local AI is disabled. Set OLLAMA_ENABLED=true after installing Ollama.'
      : (!config.safeLocal ? 'OLLAMA_URL must be a loopback HTTP address.' : 'Configured; availability is checked when a draft is requested.')
  });
});

function callOllama(config, prompt) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/api/generate', config.url);
    const payload = JSON.stringify({ model: config.model, stream: false, format: 'json', prompt });
    const request = http.request({
      hostname: endpoint.hostname, port: endpoint.port || 11434, path: endpoint.pathname,
      method: 'POST', timeout: 30_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(parsed.error || `Ollama returned ${response.statusCode}`));
          resolve(parsed.response || '');
        } catch (error) { reject(new Error('Ollama returned an invalid response')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Ollama request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

router.post('/ai/quotation-draft', requirePerm('sales', 'create'), async (req, res) => {
  const config = ollamaConfig();
  if (!config.enabled) return res.status(503).json({ error: 'Local AI is disabled', code: 'AI_DISABLED' });
  if (!config.safeLocal) return res.status(503).json({ error: 'Unsafe OLLAMA_URL configuration', code: 'AI_CONFIG_INVALID' });
  const requestText = clean(req.body.requestText, 8000);
  if (requestText.length < 10) return res.status(400).json({ error: 'Add a meaningful customer/RFQ request' });
  const systemPrompt = [
    'You convert a sales request into a draft quotation. Return JSON only.',
    'Schema: {"customerName":"","summary":"","lines":[{"description":"","qty":1,"uom":"Nos","rate":0,"gstRate":18}],"assumptions":[]}.',
    'Never invent a final selling price. Use rate 0 when the request does not provide one.',
    'This output will always require human review before saving or sending.',
    'Request:', requestText
  ].join('\n');
  try {
    const response = await callOllama(config, systemPrompt);
    let structured;
    try { structured = JSON.parse(response); } catch (_) { return res.status(502).json({ error: 'AI output was not valid JSON. Please retry or draft manually.' }); }
    if (!structured || !Array.isArray(structured.lines)) return res.status(502).json({ error: 'AI output did not contain quotation lines' });
    const draft = store.insert('aiDrafts', {
      orgId: req.org.id, type: 'quotation', provider: 'ollama', model: config.model,
      requestedBy: req.user.id, requestText, output: structured,
      status: 'review_required', savedDocumentId: null
    });
    audit(req.org.id, req.user.id, 'generate_draft', 'ai_quotation', draft.id, { provider: 'ollama', model: config.model });
    res.json({ draft, reviewRequired: true });
  } catch (error) {
    res.status(503).json({ error: `Local AI unavailable: ${error.message}`, code: 'AI_UNAVAILABLE' });
  }
});

/* ================= INTEGRATIONS / AUTOMATION ================= */
router.get('/admin/integrations', requirePerm('admin', 'view'), (req, res) => {
  res.json({ integrations: integrations.PROVIDERS.map(provider => integrations.providerState(req.org.id, provider)) });
});

router.patch('/admin/integrations/:provider', requirePerm('admin', 'edit'), (req, res) => {
  const definition = integrations.definition(req.params.provider);
  if (!definition) return res.status(404).json({ error: 'Unknown provider' });
  if (req.body.apiKey || req.body.token || req.body.secret || req.body.password) return res.status(400).json({ error: 'Secrets must be configured in server environment variables, not saved in the database' });
  const result = integrations.setProviderEnabled(req.org.id, definition.key, req.body.enabled, req.user.id);
  audit(req.org.id, req.user.id, 'configure', 'integration', result.config.id, { provider: definition.key, enabled: result.config.enabled });
  res.json({ integration: result.state });
});

router.get('/automation/rules', requirePerm('admin', 'view'), (req, res) => {
  res.json({ automationRules: store.find('automationRules', item => item.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) });
});

router.post('/automation/rules', requirePerm('admin', 'create'), (req, res) => {
  const body = req.body || {};
  if (!['low_stock_alert', 'overdue_invoice_alert', 'followup_reminder'].includes(body.type)) return res.status(400).json({ error: 'Unsupported automation type' });
  const name = clean(body.name, 120);
  if (!name) return res.status(400).json({ error: 'Rule name is required' });
  const rule = store.insert('automationRules', {
    orgId: req.org.id, name, type: body.type, active: body.active !== false,
    schedule: clean(body.schedule, 40) || 'daily', config: typeof body.config === 'object' ? body.config : {}, lastRunAt: null
  });
  audit(req.org.id, req.user.id, 'create', 'automation_rule', rule.id, { name, type: rule.type });
  res.status(201).json({ automationRule: rule });
});

router.patch('/automation/rules/:id', requirePerm('admin', 'edit'), (req, res) => {
  const rule = store.findOne('automationRules', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!rule) return res.status(404).json({ error: 'Automation rule not found' });
  const updated = store.update('automationRules', rule.id, {
    name: req.body.name !== undefined ? clean(req.body.name, 120) : rule.name,
    active: req.body.active !== undefined ? !!req.body.active : rule.active,
    schedule: req.body.schedule !== undefined ? clean(req.body.schedule, 40) : rule.schedule
  });
  audit(req.org.id, req.user.id, 'update', 'automation_rule', rule.id, { active: updated.active });
  res.json({ automationRule: updated });
});

function automationPeriod(rule, date = new Date()) {
  if (rule.schedule !== 'weekly') return date.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - first) / 86400000) + first.getUTCDay() + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function executeRuleForOrg(orgId, rule) {
  const key = `${rule.id}:${automationPeriod(rule)}`;
  const existing = store.findOne('backgroundJobs', item => item.orgId === orgId && item.idempotencyKey === key && item.status === 'completed');
  if (existing) return { job: existing, duplicate: true };
  const job = store.insert('backgroundJobs', {
    orgId, ruleId: rule.id, type: rule.type, idempotencyKey: key,
    status: 'running', startedAt: new Date().toISOString(), result: null
  });
  let matched = 0;
  if (rule.type === 'low_stock_alert') {
    for (const product of store.find('products', item => item.orgId === orgId)) {
      const available = stockBalance(orgId, product.id);
      const reorderPoint = asNumber(product.reorderLevel !== undefined ? product.reorderLevel : product.minStock);
      if (available <= reorderPoint) {
        notify(orgId, { title: 'Low stock', body: `${product.name}: ${available} available`, type: 'warning', link: '#/inventory/summary' });
        matched++;
      }
    }
  } else if (rule.type === 'overdue_invoice_alert') {
    for (const invoice of store.find('invoices', item => item.orgId === orgId && item.status !== 'cancelled' && item.dueDate < today() && asNumber(item.paidAmount) < asNumber(item.totals && item.totals.grandTotal))) {
      notify(orgId, { title: 'Invoice overdue', body: `${invoice.number} has an outstanding balance`, type: 'danger', link: '#/sales/invoices' });
      matched++;
    }
  } else if (rule.type === 'followup_reminder') {
    for (const task of store.find('tasks', item => item.orgId === orgId && !item.completed && item.dueDate && item.dueDate <= today())) {
      notify(orgId, { userId: task.assignedTo || null, title: 'Follow-up due', body: task.title, type: 'warning', link: '#/crm/tasks' });
      matched++;
    }
  }
  const completed = store.update('backgroundJobs', job.id, {
    status: 'completed', completedAt: new Date().toISOString(), result: { matched }
  });
  store.update('automationRules', rule.id, { lastRunAt: new Date().toISOString() });
  return { job: completed, duplicate: false };
}

router.post('/automation/rules/:id/run', requirePerm('admin', 'edit'), (req, res) => {
  const rule = store.findOne('automationRules', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!rule) return res.status(404).json({ error: 'Automation rule not found' });
  if (!rule.active) return res.status(400).json({ error: 'Automation rule is disabled' });
  const result = executeRuleForOrg(req.org.id, rule);
  audit(req.org.id, req.user.id, 'run', 'automation_rule', rule.id, { duplicate: result.duplicate, jobId: result.job.id });
  res.json(result);
});

router.get('/automation/jobs', requirePerm('admin', 'view'), (req, res) => {
  const items = store.find('backgroundJobs', item => item.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const paged = page(items, req);
  res.json({ backgroundJobs: paged.items, pagination: paged.pagination });
});

router.runScheduledAutomations = function runScheduledAutomations() {
  const results = [];
  for (const rule of store.find('automationRules', item => item.active)) {
    try { results.push(executeRuleForOrg(rule.orgId, rule)); }
    catch (error) {
      store.insert('backgroundJobs', {
        orgId: rule.orgId, ruleId: rule.id, type: rule.type,
        idempotencyKey: `${rule.id}:${automationPeriod(rule)}:failed`,
        status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        result: { error: clean(error.message, 500) }
      });
    }
  }
  store.flushSync();
  return results;
};

/* ================= SAVED REPORTS ================= */
router.get('/reports/saved', requirePerm('reports', 'view'), (req, res) => {
  res.json({ savedReports: store.find('savedReports', item => item.orgId === req.org.id && (item.ownerId === req.user.id || item.shared)) });
});

router.post('/reports/saved', requirePerm('reports', 'create'), (req, res) => {
  const name = clean(req.body.name, 120);
  const reportType = clean(req.body.reportType, 60);
  if (!name || !reportType) return res.status(400).json({ error: 'Name and report type are required' });
  const report = store.insert('savedReports', {
    orgId: req.org.id, ownerId: req.user.id, name, reportType,
    filters: typeof req.body.filters === 'object' ? req.body.filters : {}, shared: !!req.body.shared
  });
  audit(req.org.id, req.user.id, 'create', 'saved_report', report.id, { name, reportType });
  res.status(201).json({ savedReport: report });
});

module.exports = router;

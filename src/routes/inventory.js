/**
 * Inventory routes: Products master, Warehouses, perpetual Stock Ledger,
 * stock summary, reason-coded adjustments, inter-warehouse transfers,
 * low-stock alerts. Stock is ALWAYS derived from ledger events.
 */
'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { r2, audit, notify, postStock } = require('../util');

const router = express.Router();
router.use(requireAuth);

function balance(orgId, productId, warehouseId) {
  return r2(store.find('stockLedger', e =>
    e.orgId === orgId && e.productId === productId &&
    (!warehouseId || e.warehouseId === warehouseId)
  ).reduce((s, e) => s + (Number(e.qty) || 0), 0));
}

/* ================= PRODUCTS ================= */
router.get('/products', requirePerm('inventory', 'view'), (req, res) => {
  const products = store.find('products', p => p.orgId === req.org.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => ({ ...p, balance: balance(req.org.id, p.id) }));
  res.json({ products });
});

router.post('/products', requirePerm('inventory', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.sku) return res.status(400).json({ error: 'SKU and name are required' });
  if (store.findOne('products', p => p.orgId === req.org.id && p.sku.toLowerCase() === String(b.sku).toLowerCase())) {
    return res.status(409).json({ error: 'SKU already exists' });
  }
  const selectedWarehouse = b.warehouseId
    ? store.findOne('warehouses', w => w.id === b.warehouseId && w.orgId === req.org.id)
    : null;
  if (b.warehouseId && !selectedWarehouse) return res.status(400).json({ error: 'Invalid warehouse' });
  const product = store.insert('products', {
    orgId: req.org.id,
    sku: b.sku, name: b.name,
    category: b.category || 'General',
    type: ['goods', 'raw', 'finished', 'service'].includes(b.type) ? b.type : 'goods',
    hsn: b.hsn || '', uom: b.uom || 'Nos',
    gstRate: Number(b.gstRate) || 18,
    purchasePrice: Number(b.purchasePrice) || 0,
    salePrice: Number(b.salePrice) || 0,
    minStock: Number(b.minStock) || 0,
    warehouseId: selectedWarehouse ? selectedWarehouse.id : null,
    amcEligible: !!b.amcEligible,
    amcMonths: Number(b.amcMonths) || 0,
    active: true
  });
  /* opening stock via ledger event */
  const openingQty = Number(b.openingStock) || 0;
  if (openingQty > 0 && product.type !== 'service') {
    const wh = selectedWarehouse || store.findOne('warehouses', w => w.orgId === req.org.id);
    if (wh) {
      postStock({
        orgId: req.org.id, productId: product.id, warehouseId: wh.id,
        type: 'opening', qty: openingQty, rate: product.purchasePrice,
        refType: 'opening', note: 'Opening stock'
      });
    }
  }
  audit(req.org.id, req.user.id, 'create', 'product', product.id, { sku: product.sku });
  res.json({ product });
});

router.patch('/products/:id', requirePerm('inventory', 'edit'), (req, res) => {
  const p = store.findOne('products', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const allowed = ['name', 'category', 'type', 'hsn', 'uom', 'gstRate', 'purchasePrice', 'salePrice', 'minStock', 'warehouseId', 'amcEligible', 'amcMonths', 'active'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.warehouseId && !store.findOne('warehouses', w => w.id === patch.warehouseId && w.orgId === req.org.id)) {
    return res.status(400).json({ error: 'Invalid warehouse' });
  }
  const updated = store.update('products', p.id, patch);
  audit(req.org.id, req.user.id, 'update', 'product', p.id, patch);
  res.json({ product: updated });
});

/* ================= WAREHOUSES ================= */
router.get('/warehouses', requirePerm('inventory', 'view'), (req, res) => {
  res.json({ warehouses: store.find('warehouses', w => w.orgId === req.org.id) });
});
router.post('/warehouses', requirePerm('inventory', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Warehouse name is required' });
  const wh = store.insert('warehouses', { orgId: req.org.id, name: b.name, location: b.location || '' });
  audit(req.org.id, req.user.id, 'create', 'warehouse', wh.id, { name: wh.name });
  res.json({ warehouse: wh });
});

/* ================= STOCK LEDGER & SUMMARY ================= */
router.get('/ledger', requirePerm('inventory', 'view'), (req, res) => {
  const { productId, warehouseId } = req.query;
  let entries = store.find('stockLedger', e =>
    e.orgId === req.org.id &&
    (!productId || e.productId === productId) &&
    (!warehouseId || e.warehouseId === warehouseId)
  ).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  entries = entries.slice(0, 500).map(e => ({
    ...e,
    productName: (store.byId('products', e.productId) || {}).name || '?',
    warehouseName: (store.byId('warehouses', e.warehouseId) || {}).name || '-'
  }));
  res.json({ entries });
});

router.get('/summary', requirePerm('inventory', 'view'), (req, res) => {
  const rows = [];
  for (const p of store.find('products', x => x.orgId === req.org.id && x.type !== 'service')) {
    for (const wh of store.find('warehouses', w => w.orgId === req.org.id)) {
      const bal = balance(req.org.id, p.id, wh.id);
      if (bal !== 0) {
        rows.push({
          productId: p.id, sku: p.sku, productName: p.name, uom: p.uom,
          warehouse: wh.name, balance: bal,
          value: r2(bal * (Number(p.purchasePrice) || 0)),
          minStock: p.minStock,
          status: bal <= 0 ? 'out_of_stock' : (bal <= (Number(p.minStock) || 0) ? 'low' : 'ok')
        });
      }
    }
  }
  res.json({ summary: rows });
});

router.get('/low-stock', requirePerm('inventory', 'view'), (req, res) => {
  const items = [];
  for (const p of store.find('products', x => x.orgId === req.org.id && x.type !== 'service')) {
    const bal = balance(req.org.id, p.id);
    if (bal <= (Number(p.minStock) || 0)) {
      items.push({ id: p.id, sku: p.sku, name: p.name, balance: bal, minStock: p.minStock });
    }
  }
  res.json({ items });
});

/* ================= ADJUSTMENTS (reason-coded) ================= */
router.post('/adjustments', requirePerm('inventory', 'edit'), (req, res) => {
  const b = req.body || {};
  const product = store.findOne('products', p => p.id === b.productId && p.orgId === req.org.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!b.reason || !String(b.reason).trim()) return res.status(400).json({ error: 'A reason is mandatory for stock adjustments' });
  const qty = Number(b.qty);
  if (!qty || qty === 0) return res.status(400).json({ error: 'Adjustment quantity cannot be zero' });

  const wh = b.warehouseId
    ? store.findOne('warehouses', w => w.id === b.warehouseId && w.orgId === req.org.id)
    : store.findOne('warehouses', w => w.orgId === req.org.id);
  if (!wh) return res.status(400).json({ error: 'No warehouse available' });

  const current = balance(req.org.id, product.id, wh.id);
  if (qty < 0 && current + qty < 0 && !req.org.allowNegativeStock) {
    return res.status(400).json({ error: `Insufficient stock in ${wh.name}. Current balance: ${current}` });
  }

  const entry = postStock({
    orgId: req.org.id, productId: product.id, warehouseId: wh.id,
    type: 'adjustment', qty, rate: product.purchasePrice,
    refType: 'adjustment', note: String(b.reason).trim()
  });
  audit(req.org.id, req.user.id, 'stock_adjustment', 'product', product.id, { qty, reason: b.reason, warehouse: wh.name });
  notify(req.org.id, { title: 'Stock adjusted', body: `${product.name}: ${qty > 0 ? '+' : ''}${qty} by ${req.user.name} (${b.reason})`, type: 'warning', link: '#/inventory/ledger' });
  res.json({ entry });
});

/* ================= TRANSFERS ================= */
router.post('/transfers', requirePerm('inventory', 'edit'), (req, res) => {
  const b = req.body || {};
  const product = store.findOne('products', p => p.id === b.productId && p.orgId === req.org.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const fromWh = store.findOne('warehouses', w => w.id === b.fromWarehouseId && w.orgId === req.org.id);
  const toWh = store.findOne('warehouses', w => w.id === b.toWarehouseId && w.orgId === req.org.id);
  if (!fromWh || !toWh) return res.status(400).json({ error: 'Select valid source and destination warehouses' });
  if (fromWh.id === toWh.id) return res.status(400).json({ error: 'Source and destination must differ' });
  const qty = Number(b.qty);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be positive' });
  const current = balance(req.org.id, product.id, fromWh.id);
  if (current < qty && !req.org.allowNegativeStock) {
    return res.status(400).json({ error: `Insufficient stock at ${fromWh.name}. Available: ${current}` });
  }
  const out = postStock({
    orgId: req.org.id, productId: product.id, warehouseId: fromWh.id,
    type: 'transfer_out', qty: -qty, rate: product.purchasePrice,
    refType: 'transfer', note: `To ${toWh.name}`
  });
  const inn = postStock({
    orgId: req.org.id, productId: product.id, warehouseId: toWh.id,
    type: 'transfer_in', qty, rate: product.purchasePrice,
    refType: 'transfer', note: `From ${fromWh.name}`
  });
  audit(req.org.id, req.user.id, 'stock_transfer', 'product', product.id, { qty, from: fromWh.name, to: toWh.name });
  res.json({ out, in: inn });
});

module.exports = router;

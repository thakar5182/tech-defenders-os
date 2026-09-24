const fs = require('fs');
const path = require('path');

// 1. Modify manufacturing.js
const mFile = path.join(__dirname, '..', 'src', 'routes', 'manufacturing.js');
let mCode = fs.readFileSync(mFile, 'utf8');

mCode = mCode.replace(
  "notes: b.notes || ''",
  "notes: b.notes || '', salesOrderId: b.salesOrderId || null"
);

mCode = mCode.replace(
  "router.get('/boms', requirePerm('manufacturing', 'view'), (req, res) => {\n  const list = store.find('boms', b => b.orgId === req.org.id)",
  "router.get('/boms', requirePerm('manufacturing', 'view'), (req, res) => {\n  const list = store.find('boms', b => b.orgId === req.org.id).map(b => ({...b, salesOrderNumber: b.salesOrderId ? store.byId('salesOrders', b.salesOrderId)?.number : null }))"
);

fs.writeFileSync(mFile, mCode);

// 2. Modify sales.js to include BOMs in SO response
const sFile = path.join(__dirname, '..', 'src', 'routes', 'sales.js');
let sCode = fs.readFileSync(sFile, 'utf8');

if (!sCode.includes("router.get('/sales-orders/:id'")) {
  sCode = sCode.replace(
    "/* SO -> Invoice (remaining uninvoiced quantity; partial supported) */",
    `router.get('/sales-orders/:id', requirePerm('sales', 'view'), (req, res) => {
  const so = store.findOne('salesOrders', s => s.id === req.params.id && s.orgId === req.org.id);
  if (!so) return res.status(404).json({ error: 'Sales order not found' });
  const boms = store.find('boms', b => b.orgId === req.org.id && b.salesOrderId === so.id);
  const receipts = store.find('receipts', r => r.orgId === req.org.id && r.salesOrderId === so.id);
  res.json({ salesOrder: so, boms, receipts });
});\n\n/* SO -> Invoice (remaining uninvoiced quantity; partial supported) */`
  );
}
fs.writeFileSync(sFile, sCode);

// 3. Patch UI
const uiFile = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let uiCode = fs.readFileSync(uiFile, 'utf8');

uiCode = uiCode.replace(
  "Pages.openSOEdit = async function(soId) {",
  `Pages.openSOEdit = async function(soId) {
    const data = await Core.get('/sales/sales-orders/' + soId);
    let extraHTML = '';
    if (data.boms && data.boms.length) {
      extraHTML += '<h4>Associated BOMs</h4><ul>' + data.boms.map(b => '<li>' + Core.esc(b.code) + ' - ' + Core.esc(b.notes) + '</li>').join('') + '</ul>';
    } else {
      extraHTML += '<h4>Associated BOMs</h4><p class="muted">No BOMs linked.</p>';
    }
`
);

uiCode = uiCode.replace(
  "Core.formModal({\n      title: 'Edit Sales Order Details',",
  "Core.formModal({\n      title: 'Edit Sales Order Details',\n      afterBody: extraHTML,"
);

fs.writeFileSync(uiFile, uiCode);

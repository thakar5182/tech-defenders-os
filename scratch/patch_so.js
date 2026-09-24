const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let code = fs.readFileSync(file, 'utf8');

// Update sales order table
code = code.replace(
  "{ label: 'Customer', key: 'customerName' },",
  "{ label: 'Customer', render: s => \`<b>\${Core.esc(s.customerName)}</b><br><small class=\"muted\">#\${Core.esc(s.customerNumber)}</small>\` },"
);

// Add 'Edit' button for Sales Orders
code = code.replace(
  "render: s => canEdit && !['completed', 'cancelled'].includes(s.status)\n          ? `<button class=\"btn btn-gold btn-sm\" onclick=\"Pages.openInvoiceFromSO('${s.id}')\">Create Invoice</button>`\n: '' }",
  "render: s => `<div class=\"actions-cell\">\${canEdit && !['completed', 'cancelled'].includes(s.status) ? \`<button class=\"btn btn-gold btn-sm\" onclick=\"Pages.openInvoiceFromSO('\${s.id}')\">Create Invoice</button>\` : ''} \${canEdit ? \`<button class=\"btn btn-outline btn-sm\" onclick=\"Pages.openSOEdit('\${s.id}')\">Edit</button>\` : ''}</div>` }"
);

// Add Pages.openSOEdit function
code = code.replace(
  "Pages.openInvoiceFromSO = async soId => {",
  `Pages.openSOEdit = async function(soId) {
    const d = await Core.get('/sales/sales-orders');
    const so = d.salesOrders.find(s => s.id === soId);
    Core.formModal({
      title: 'Edit Sales Order Details',
      fields: [
        { name: 'poNumber', label: 'PO Number', value: so.poNumber },
        { name: 'transportDetails', label: 'Transport Details', value: so.transportDetails },
        { name: 'packingDetails', label: 'Packing Details', value: so.packingDetails },
        { name: 'notes', label: 'Notes', type: 'textarea', value: so.notes }
      ],
      submitLabel: 'Save',
      onSubmit: async v => {
        await Core.patch('/sales/sales-orders/' + soId, v);
        toast('Updated', 'Sales order updated', 'success');
        Core.render();
      }
    });
  };

  Pages.openInvoiceFromSO = async soId => {`
);

fs.writeFileSync(file, code);

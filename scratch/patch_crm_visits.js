const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'routes', 'crm.js');
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  "    const documents = store.find('customerDocuments', doc => doc.orgId === orgId && doc.customerId === c.id)\n      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))\n      .map(doc => ({ id: doc.id, title: doc.title, mimeType: doc.mimeType, createdAt: doc.createdAt }));\n    \n    // Check CRM Notes added in Phase 3\n    const notes = store.find('notes', n => n.orgId === req.org.id && n.customerId === req.params.id)\n      .sort((a,b) => b.createdAt.localeCompare(a.createdAt))\n      .map(n => ({ ...n, userName: (store.byId('users', n.userId) || {}).name || 'System' }));\n\n    res.json({\n      customer: c,",
  `    const documents = store.find('customerDocuments', doc => doc.orgId === orgId && doc.customerId === c.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(doc => ({ id: doc.id, title: doc.title, mimeType: doc.mimeType, createdAt: doc.createdAt }));
    
    // Check CRM Notes added in Phase 3
    const notes = store.find('notes', n => n.orgId === req.org.id && n.customerId === req.params.id)
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt))
      .map(n => ({ ...n, userName: (store.byId('users', n.userId) || {}).name || 'System' }));

    // Fetch Product Sales (invoices) and Sales Visits for CRM Customer View
    const productSales = invoices.map(i => ({ id: i.id, number: i.number, date: i.date, total: i.totals?.grandTotal || 0, status: i.status }));
    const salesVisits = store.find('salesVisits', v => v.orgId === req.org.id && v.customerId === c.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt));

    res.json({
      customer: c, productSales, salesVisits,`
);

fs.writeFileSync(file, code);

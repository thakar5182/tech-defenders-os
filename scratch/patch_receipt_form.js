const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let pCode = fs.readFileSync(pFile, 'utf8');

pCode = pCode.replace(
  "Pages.openReceiptForm = async (selectedCustomerId) => {\n    const custD = await Core.get('/crm/customers');",
  "Pages.openReceiptForm = async (selectedCustomerId) => {\n    const [custD, soD] = await Promise.all([Core.get('/crm/customers'), Core.get('/sales/sales-orders')]);"
);

pCode = pCode.replace(
  "{ name: 'date', label: 'Date', type: 'date', half: true },",
  "{ name: 'date', label: 'Date', type: 'date', half: true },\n        { name: 'salesOrderId', label: 'Link to Sales Order (optional)', type: 'select', options: [{value: '', label: '-- None --'}].concat(soD.salesOrders.map(so => ({ value: so.id, label: so.number + ' (' + so.customerName + ')' }))) },"
);

fs.writeFileSync(pFile, pCode);

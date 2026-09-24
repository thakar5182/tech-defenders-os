const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  "{ label: 'Date', render: r => Core.fmtDate(r.date) },",
  "{ label: 'Date', render: r => Core.fmtDate(r.date) },\n        { label: 'Sales Order(s)', render: r => Core.esc(r.salesOrderNumbers) },"
);

fs.writeFileSync(file, code);

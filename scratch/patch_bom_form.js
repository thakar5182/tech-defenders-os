const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'public', 'js', 'pages-ops.js');
let pCode = fs.readFileSync(pFile, 'utf8');

pCode = pCode.replace(
  "Pages.openBomForm = async () => {\n    const pd = await Core.get('/inventory/products');",
  "Pages.openBomForm = async (defaultSO = null) => {\n    const [pd, sod] = await Promise.all([Core.get('/inventory/products'), Core.get('/sales/sales-orders')]);"
);

pCode = pCode.replace(
  "<label class=\"field\"><span>Output quantity per batch</span><input type=\"number\" name=\"outputQty\" value=\"1\" step=\"any\"></label>",
  `<label class="field"><span>Output quantity per batch</span><input type="number" name="outputQty" value="1" step="any"></label>
          <label class="field"><span>Linked Sales Order</span><select name="salesOrderId"><option value="">-- None --</option>\${sod.salesOrders.map(so => \`<option value="\${so.id}" \${so.id === defaultSO ? 'selected' : ''}>\${so.number} (\${Core.esc(so.customerName)})\</option>\`).join('')}</select></label>`
);

pCode = pCode.replace(
  "const lines = [];",
  "const salesOrderId = d.get('salesOrderId') || null;\n          const lines = [];"
);

pCode = pCode.replace(
  "body: { outputProductId: d.get('outputProductId'), outputQty: d.get('outputQty'),",
  "body: { outputProductId: d.get('outputProductId'), outputQty: d.get('outputQty'), salesOrderId,"
);

fs.writeFileSync(pFile, pCode);

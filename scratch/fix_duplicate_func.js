const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'public', 'js', 'pages-core.js');
let pCode = fs.readFileSync(pFile, 'utf8');

const targetStr = "Pages.generateQuotationFromLead = async id => {";
let idx = pCode.lastIndexOf(targetStr); // find the last one!
if (idx !== -1 && idx > pCode.indexOf(targetStr)) {
  let endIdx = pCode.indexOf("};\n", idx);
  if (endIdx !== -1) {
    pCode = pCode.slice(0, idx) + `Pages.generateQuotationFromLead = async id => {
  try {
    const res = await Core.post('/crm/leads/' + id + '/generate-quotation', {});
    toast('Quotation created', 'Redirecting to quotation edit page...', 'success');
    location.hash = '#/sales/quotations/' + res.quotation.id;
  } catch (e) {
    toast('Error', e.message, 'error');
  }
};\n` + pCode.slice(endIdx + 3);
  }
}

fs.writeFileSync(pFile, pCode);

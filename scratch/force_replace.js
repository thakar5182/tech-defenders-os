const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'public', 'js', 'pages-core.js');
let pCode = fs.readFileSync(pFile, 'utf8');

const regex = /Pages\.generateQuotationFromLead = async id => \{[\s\S]*?location\.hash = '#\/sales\/quotations\/new';[\s\S]*?\}\s*\};/g;

pCode = pCode.replace(regex, `Pages.generateQuotationFromLead = async id => {
  try {
    const res = await Core.post('/crm/leads/' + id + '/generate-quotation', {});
    toast('Quotation created', 'Redirecting to quotation edit page...', 'success');
    location.hash = '#/sales/quotations/' + res.quotation.id;
  } catch (e) {
    toast('Error', e.message, 'error');
  }
};`);

fs.writeFileSync(pFile, pCode);

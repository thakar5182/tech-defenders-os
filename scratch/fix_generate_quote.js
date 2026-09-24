const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'public', 'js', 'pages-core.js');
let pCode = fs.readFileSync(pFile, 'utf8');

const targetStr = `Pages.generateQuotationFromLead = async id => {
    const d = await Core.get('/crm/leads');
    const lead = d.leads.find(l => l.id === id);
    if (!lead) return toast('Error', 'Lead not found', 'error');
    
    // Assuming a sales/quotations route or creation function exists. We will prefill the quotation form.
    if (typeof Pages.openQuotationForm === 'function') {
      Pages.openQuotationForm(null, {
        customerId: lead.customerId,
        customerName: lead.name,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        address: lead.address,
        description: lead.description,
        gstDetails: lead.gstDetails
      });
    } else {
      // Fallback redirect if modal function is not available
      location.hash = '#/sales/quotations/new';
    }
  };`;

pCode = pCode.replace(targetStr, `Pages.generateQuotationFromLead = async id => {
  try {
    const res = await Core.post('/crm/leads/' + id + '/generate-quotation', {});
    toast('Quotation created', 'Redirecting to quotation edit page...', 'success');
    location.hash = '#/sales/quotations/' + res.quotation.id;
  } catch (e) {
    toast('Error', e.message, 'error');
  }
};`);

fs.writeFileSync(pFile, pCode);

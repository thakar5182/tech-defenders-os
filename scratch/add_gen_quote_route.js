const fs = require('fs');
const path = require('path');
const pFile = path.join(__dirname, '..', 'src', 'routes', 'crm.js');
let pCode = fs.readFileSync(pFile, 'utf8');

const routeStr = `
/* ================= LEAD TO QUOTATION ================= */
router.post('/leads/:id/generate-quotation', requirePerm('crm', 'edit'), (req, res) => {
  const lead = store.findOne('leads', l => l.id === req.params.id && l.orgId === req.org.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  
  let customer;
  if (lead.customerId) {
    customer = store.byId('customers', lead.customerId);
  } else {
    customer = store.insert('customers', {
      orgId: req.org.id, name: lead.company || lead.name, contactPerson: lead.company ? lead.name : '',
      email: lead.email, phone: lead.phone, address: lead.address,
      source: lead.source, creditLimit: 0, paymentTermsDays: 0, status: 'active'
    });
    store.update('leads', lead.id, { status: 'converted', customerId: customer.id });
    audit(req.org.id, req.user.id, 'update', 'lead', lead.id, { event: 'auto_converted_to_customer', customerId: customer.id });
  }
  
  const { nextNumber } = require('../util');
  const quotation = store.insert('quotations', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'quotation'),
    customerId: customer.id, date: new Date().toISOString().slice(0,10),
    validUntil: new Date(Date.now() + 30*86400000).toISOString().slice(0,10),
    status: 'draft', notes: lead.description || '',
    lines: [
      {
        description: (lead.description || 'Service/Product as discussed').slice(0, 100),
        hsnSac: '', unit: 'NOS', qty: 1, rate: 0, discount: 0,
        gstRate: 18, gstAmount: 0, total: 0
      }
    ],
    totals: { taxable: 0, gstAmount: 0, grandTotal: 0 }
  });
  
  audit(req.org.id, req.user.id, 'create', 'quotation', quotation.id, { sourceLeadId: lead.id });
  res.json({ quotation });
});
`;

if (!pCode.includes('/leads/:id/generate-quotation')) {
  pCode = pCode.replace("module.exports = router;", routeStr + "\nmodule.exports = router;");
  fs.writeFileSync(pFile, pCode);
}

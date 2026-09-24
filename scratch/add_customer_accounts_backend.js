const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'routes', 'finance.js');
let code = fs.readFileSync(file, 'utf8');

const newCode = `
/* ================= CUSTOMER ACCOUNTS ================= */
router.get('/customer-accounts', requirePerm('finance', 'view'), (req, res) => {
  const customers = store.find('customers', c => c.orgId === req.org.id);
  const invoices = store.find('invoices', i => i.orgId === req.org.id && i.status !== 'cancelled');
  const receipts = store.find('receipts', r => r.orgId === req.org.id);
  
  const accs = customers.map(c => {
    const custInvs = invoices.filter(i => i.customerId === c.id);
    const totalBilled = custInvs.reduce((sum, i) => sum + (i.totals?.grandTotal || 0), 0);
    const totalPaid = receipts.filter(r => r.customerId === c.id).reduce((sum, r) => sum + (r.amount || 0), 0);
    return {
      id: c.id, name: c.name, stateCode: c.stateCode,
      totalBilled: r2(totalBilled),
      totalPaid: r2(totalPaid),
      outstanding: Math.max(0, r2(totalBilled - totalPaid))
    };
  });
  
  const recurring = store.find('customerRecurring', r => r.orgId === req.org.id && r.status === 'active');
  const totals = {
    receivables: accs.reduce((sum, a) => sum + a.outstanding, 0),
    received: accs.reduce((sum, a) => sum + a.totalPaid, 0),
    recurringCount: recurring.length
  };
  
  res.json({ customers: accs, totals });
});

router.get('/customer-accounts/:id', requirePerm('finance', 'view'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  
  const custInvs = store.find('invoices', i => i.orgId === req.org.id && i.customerId === c.id && i.status !== 'cancelled');
  const payments = store.find('receipts', r => r.orgId === req.org.id && r.customerId === c.id);
  const totalBilled = custInvs.reduce((sum, i) => sum + (i.totals?.grandTotal || 0), 0);
  const totalPaid = payments.reduce((sum, r) => sum + (r.amount || 0), 0);
  
  const summary = {
    billed: r2(totalBilled),
    paid: r2(totalPaid),
    outstanding: Math.max(0, r2(totalBilled - totalPaid))
  };
  
  // Collect all sales documents related to this customer (Quotations, SOs, Invoices, Receipts)
  const qIds = store.find('quotations', q => q.orgId === req.org.id && q.customerId === c.id).map(q => q.id);
  const soIds = store.find('salesOrders', s => s.orgId === req.org.id && s.customerId === c.id).map(s => s.id);
  const invIds = custInvs.map(i => i.id);
  const recIds = payments.map(r => r.id);
  
  let documents = store.find('salesDocuments', d => d.orgId === req.org.id);
  documents = documents.filter(d => 
    (d.entityType === 'customer' && d.entityId === c.id) ||
    (d.entityType === 'quotation' && qIds.includes(d.entityId)) ||
    (d.entityType === 'salesOrder' && soIds.includes(d.entityId)) ||
    (d.entityType === 'invoice' && invIds.includes(d.entityId)) ||
    (d.entityType === 'receipt' && recIds.includes(d.entityId))
  ).map(d => {
    // Add entityRef for display
    let ref = '';
    if (d.entityType === 'quotation') ref = store.byId('quotations', d.entityId)?.number;
    if (d.entityType === 'salesOrder') ref = store.byId('salesOrders', d.entityId)?.number;
    if (d.entityType === 'invoice') ref = store.byId('invoices', d.entityId)?.number;
    if (d.entityType === 'receipt') ref = store.byId('receipts', d.entityId)?.number;
    return { ...d, entityRef: ref };
  });
  
  const recurring = store.find('customerRecurring', r => r.orgId === req.org.id && r.customerId === c.id);
  
  res.json({ customer: c, summary, payments, documents, recurring });
});

router.post('/customer-accounts/:id/recurring', requirePerm('finance', 'edit'), (req, res) => {
  const c = store.findOne('customers', x => x.id === req.params.id && x.orgId === req.org.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body;
  const rec = store.insert('customerRecurring', {
    orgId: req.org.id, customerId: c.id,
    description: b.description, frequency: b.frequency,
    amount: Number(b.amount), startDate: b.startDate,
    nextDueDate: b.startDate, status: 'active'
  });
  res.json({ recurring: rec });
});
`;

code = code + "\n" + newCode;
fs.writeFileSync(file, code);

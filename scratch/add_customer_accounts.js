const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'pages-ops.js');
let code = fs.readFileSync(file, 'utf8');

const newCode = `
/* ================= CUSTOMER ACCOUNTS (Finance Module) ================= */
Core.route('finance/customer-accounts', async () => {
  const d = await Core.get('/finance/customer-accounts');
  document.getElementById('content').innerHTML = \`
    \${Core.pageHead('Customer Accounts', 'Manage payments, recurring transactions, and sales documents per customer')}
    <div class="kpi-grid">
      \${Core.kpi('Total Receivables', Core.moneyShort(d.totals.receivables), 'Overall outstanding amount')}
      \${Core.kpi('Total Received', Core.moneyShort(d.totals.received), 'Total payments received')}
      \${Core.kpi('Active Recurring', d.totals.recurringCount, 'Active subscriptions / recurring plans')}
    </div>
    \${Core.table([
      { label: 'Customer / Account', render: c => \`<a href="#/finance/customer-accounts/\${c.id}"><b>\${Core.esc(c.name)}</b></a>\` },
      { label: 'State', key: 'stateCode' },
      { label: 'Total Billed', num: true, render: c => Core.money(c.totalBilled) },
      { label: 'Total Paid', num: true, render: c => Core.money(c.totalPaid) },
      { label: 'Outstanding', num: true, render: c => Core.money(c.outstanding) },
      { label: '', render: c => \`<a class="btn btn-outline btn-sm" href="#/finance/customer-accounts/\${c.id}">View Account</a>\` }
    ], d.customers, { emptyTitle: 'No customer accounts', emptyText: 'Customers will appear here once created.' })}\`;
});

Core.route('finance/customer-accounts/:id', async (p) => {
  const d = await Core.get('/finance/customer-accounts/' + p.id);
  const c = d.customer;
  
  document.getElementById('content').innerHTML = \`
    \${Core.pageHead(c.name, 'Customer Account Dashboard', '<button class="btn btn-outline" onclick="history.back()">Back</button>')}
    <div class="grid-kpi">
      \${Core.kpi('Total Billed', Core.money(d.summary.billed))}
      \${Core.kpi('Total Received', Core.money(d.summary.paid), '', 'k-success')}
      \${Core.kpi('Outstanding', Core.money(d.summary.outstanding), '', d.summary.outstanding > 0 ? 'k-danger' : '')}
      \${Core.kpi('Credit Limit', Core.money(c.creditLimit))}
    </div>
    
    <div class="grid cols" style="margin-top:16px;">
      <div class="card card-pad">
        <div class="section-title"><h3>Payment History</h3></div>
        \${Core.table([
          { label: 'Date', render: r => Core.fmtDate(r.date) },
          { label: 'Receipt No.', render: r => \`<b>\${Core.esc(r.number)}</b>\` },
          { label: 'Mode', key: 'mode' },
          { label: 'Amount', num: true, render: r => Core.money(r.amount) }
        ], d.payments, { emptyTitle: 'No payments', emptyText: 'No payments received yet.' })}
      </div>
      
      <div class="card card-pad">
        <div class="section-title"><h3>Sales Documents</h3></div>
        \${Core.table([
          { label: 'Document', render: doc => \`<b>\${Core.esc(doc.title)}</b><br><small>\${Core.esc(doc.entityType.toUpperCase())} \${doc.entityRef || ''}</small>\` },
          { label: 'Date', render: doc => Core.fmtDate(doc.createdAt) },
          { label: '', render: doc => \`<a class="btn btn-outline btn-sm" href="/api/sales/documents/\${doc.id}/download" target="_blank">Download</a>\` }
        ], d.documents, { emptyTitle: 'No sales documents', emptyText: 'No related documents found.' })}
      </div>
      
      <div class="card card-pad wide">
        <div class="section-title"><div><h3>Recurring Transactions / Subscriptions</h3></div>\${Core.can('finance', 'edit') ? '<button class="btn btn-gold btn-sm" onclick="Pages.openRecurringForm(\\'' + c.id + '\\')">+ Add Recurring</button>' : ''}</div>
        \${Core.table([
          { label: 'Plan / Description', key: 'description' },
          { label: 'Frequency', render: r => r.frequency },
          { label: 'Amount', num: true, render: r => Core.money(r.amount) },
          { label: 'Next Due', render: r => Core.fmtDate(r.nextDueDate) },
          { label: 'Status', render: r => Core.badge(r.status) }
        ], d.recurring, { emptyTitle: 'No recurring transactions', emptyText: 'Set up recurring payments or subscriptions.' })}
      </div>
    </div>
  \`;
});

Pages.openRecurringForm = async function(customerId) {
  Core.formModal({
    title: 'Setup Recurring Transaction',
    fields: [
      { name: 'description', label: 'Description', required: true },
      { name: 'frequency', label: 'Frequency', type: 'select', options: [{value: 'monthly', label: 'Monthly'}, {value: 'quarterly', label: 'Quarterly'}, {value: 'yearly', label: 'Yearly'}] },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'startDate', label: 'Start Date', type: 'date', required: true }
    ],
    submitLabel: 'Save',
    onSubmit: async v => {
      await Core.post('/finance/customer-accounts/' + customerId + '/recurring', v);
      toast('Saved', 'Recurring transaction added', 'success');
      Core.render();
    }
  });
};
`;

code = code + "\n" + newCode;
fs.writeFileSync(file, code);

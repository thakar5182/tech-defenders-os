'use strict';
window.Pages = window.Pages || {};
const collectionMoney = value => Core.money(Number(value) || 0);
Pages.collectionCustomer = async id => {
  const data = await Core.get('/collections/customers/' + id);
  Pages._collectionData = data;
  const invoices = data.invoices || [];
  document.getElementById('content').innerHTML = `${Core.pageHead(Core.esc(data.customer.name), 'Collection account, credit position and communication history', '<button class="btn btn-outline" onclick="location.hash=\'#/sales/collections\'">Back to collections</button>')}
    <div class="stats-grid" style="margin-bottom:18px">${Core.kpi('Outstanding', collectionMoney(data.outstanding), '')}${Core.kpi('Overdue', collectionMoney(data.overdueAmount), data.overdueCount + ' invoice(s)')}${Core.kpi('Credit limit', data.creditLimit ? collectionMoney(data.creditLimit) : 'Not set', data.creditExceeded ? 'Limit exceeded' : 'Available control')}${Core.kpi('Contact', Core.esc(data.customer.phone || data.customer.email || '-'), '')}</div>
    ${data.creditExceeded || data.overdueCount ? `<div class="manual-entry-callout invoice-callout"><b>Collection attention needed</b><span>${data.creditExceeded ? 'Outstanding is above the configured credit limit. ' : ''}${data.overdueCount ? `${data.overdueCount} invoice(s) are overdue.` : ''}</span></div>` : ''}
    <div class="card card-pad" style="margin-top:18px"><h3>Open invoices</h3>${Core.table([{label:'Invoice',key:'number'},{label:'Due date',render:r=>Core.fmtDate(r.dueDate)},{label:'Due',render:r=>collectionMoney((Number(r.totals?.grandTotal)||0)-(Number(r.paidAmount)||0))},{label:'Status',render:r=>Core.badge(r.status)},{label:'Action',render:r=>Core.can('sales','edit')?`<button class="btn btn-gold btn-sm" onclick="Pages.sendCollectionReminder('${Core.esc(r.id)}')">Send reminder</button>`:'-'}], invoices,{emptyTitle:'No open invoices',emptyText:'This customer has no outstanding invoices.'})}</div>
    <div class="card card-pad" style="margin-top:18px"><h3>Communication history</h3>${Core.table([{label:'When',render:r=>r.createdAt ? new Date(r.createdAt).toLocaleString() : '-'},{label:'Channel',render:r=>Core.badge(r.channel)},{label:'Type',key:'messageType'},{label:'Status',render:r=>Core.badge(r.status)},{label:'Invoice',render:r=>invoices.find(i=>i.id===r.relatedInvoiceId)?.number || '-'}],data.history,{emptyTitle:'No collection messages yet',emptyText:'Use Send reminder to create a logged WhatsApp-ready reminder.'})}</div>`;
};
Core.route('sales/collections', async () => {
  const data = await Core.get('/collections/customers');
  document.getElementById('content').innerHTML = `${Core.pageHead('Collections Centre', 'Prioritize overdue receivables, credit exposure and payment follow-up')}${Core.table([{label:'Customer',key:'name'},{label:'Outstanding',render:r=>collectionMoney(r.outstanding)},{label:'Overdue',render:r=>r.overdueCount ? collectionMoney(r.overdueAmount) : '-'},{label:'Credit limit',render:r=>r.creditLimit ? collectionMoney(r.creditLimit) : '-'},{label:'Risk',render:r=>r.creditExceeded?Core.badge('Credit exceeded'):r.overdueCount?Core.badge('Overdue'):'-'},{label:'',render:r=>`<button class="btn btn-outline btn-sm" onclick="Pages.collectionCustomer('${Core.esc(r.id)}')">Open</button>`}], data.customers,{emptyTitle:'No receivables to follow up',emptyText:'Open invoices will appear here automatically.'})}`;
});
Pages.sendCollectionReminder = async invoiceId => {
  const data = Pages._collectionData; const invoice = (data?.invoices || []).find(row => row.id === invoiceId); if (!invoice) return;
  const result = await Core.post('/collections/reminders', { invoiceId });
  window.open(result.url, '_blank', 'noopener,noreferrer');
  toast('WhatsApp opened', 'Review the message and press Send. The reminder was logged.', 'success');
  Pages.collectionCustomer(data.customer.id);
};

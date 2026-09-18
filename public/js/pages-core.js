/* ============================================================
   Pages: Dashboard + CRM (Leads, Customers, Deals, Tasks)
   ============================================================ */
'use strict';

const Pages = window.Pages || {};

/* ================= DASHBOARD ================= */
Core.route('dashboard', async () => {
  stopDashboardWorldClocks();
  const d = await Core.get('/dashboard/summary');
  const k = d.kpis;
  const widgets = d.widgets || {};
  const trendRows = d.salesTrend.map(t => ({ ...t, fmt: Core.moneyShort(t.total) }));
  const maxFunnel = Math.max(...Object.values(d.leadFunnel), 1);
  const visibleWidgetCount = Object.values(widgets).filter(Boolean).length;

  document.getElementById('content').innerHTML = `
    ${Core.pageHead(`Good ${greeting()}, ${Core.state.user.name.split(' ')[0]}`, 'Live snapshot of your business - every figure is computed from real records.')}

    ${dashboardWorldClocks()}

    ${Core.appLauncher()}

    <div class="grid-kpi">
      ${k.openLeads != null ? Core.kpi('Open Leads', k.openLeads, 'active pipeline entries', '', '#/crm/leads') : ''}
      ${k.pipelineValue != null ? Core.kpi('Pipeline Value', Core.moneyShort(k.pipelineValue), 'open deals total', 'k-gold', '#/crm/deals') : ''}
      ${k.weightedForecast != null ? Core.kpi('Weighted Forecast', Core.moneyShort(k.weightedForecast), 'probability adjusted', '', '#/crm/deals') : ''}
      ${k.outstandingReceivable != null ? Core.kpi('Outstanding Receivable', Core.moneyShort(k.outstandingReceivable), k.overdueReceivable ? Core.moneyShort(k.overdueReceivable) + ' overdue' : 'nothing overdue', k.overdueReceivable ? 'k-danger' : '', d.access.reports ? '#/reports/receivables' : '#/sales/invoices') : ''}
    </div>
    <div class="grid-kpi">
      ${k.dueToday != null ? Core.kpi('Follow-ups Due Today', k.dueToday, k.overdueTasks + ' overdue', k.dueToday ? 'k-gold' : '', '#/crm/tasks') : ''}
      ${k.invoicedThisMonth != null ? Core.kpi('Invoiced This Month', Core.moneyShort(k.invoicedThisMonth), 'GST invoices raised', '', '#/sales/invoices') : ''}
      ${k.collectedThisMonth != null ? Core.kpi('Collected This Month', Core.moneyShort(k.collectedThisMonth), 'receipts recorded', 'k-success', '#/sales/receipts') : ''}
      ${k.lowStockCount != null ? Core.kpi('Low Stock Items', k.lowStockCount, 'at or below reorder level', k.lowStockCount ? 'k-danger' : 'k-success', '#/inventory/summary') : ''}
      ${k.openTickets != null ? Core.kpi('Open Tickets', k.openTickets, 'service desk load', '', '#/service/tickets') : ''}
      ${k.pendingPOs != null ? Core.kpi('Pending POs', k.pendingPOs, 'awaiting delivery', '', '#/purchase/orders') : ''}
    </div>

    <div class="grid-2col">
      ${widgets.salesTrend ? `<a class="card dashboard-link-card" href="${d.access.reports ? '#/reports/sales' : '#/sales/invoices'}">
        <div class="card-head"><h3>Sales Trend - last 6 months (invoiced value)</h3></div>
        <div class="card-pad">${Core.barChart(trendRows, 'total', 'month')}</div>
      </a>` : ''}
      ${widgets.leadFunnel ? `<a class="card dashboard-link-card" href="${d.access.reports ? '#/reports/funnel' : '#/crm/leads'}">
        <div class="card-head"><h3>Lead Funnel</h3><span class="badge b-gold">${d.leadFunnel.converted} converted</span></div>
        <div class="card-pad">
          ${['new', 'contacted', 'qualified', 'converted', 'lost'].map(s => `
            <div class="funnel-row"><span style="text-transform:capitalize">${s}</span>
              <div class="funnel-track"><div class="funnel-fill" style="width:${Math.round(d.leadFunnel[s] / maxFunnel * 100)}%"></div></div>
              <b>${d.leadFunnel[s]}</b></div>`).join('')}
        </div>
      </a>` : ''}
    </div>

    <div class="grid-even" style="margin-top:16px">
      ${widgets.followUps ? `<div class="card">
        <div class="card-head"><h3>Follow-ups due / overdue</h3><a class="link" href="#/crm/tasks">View all</a></div>
        ${d.dueTasksList.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Task</th><th>Due</th><th>Priority</th><th>Assignee</th></tr></thead>
          <tbody>${d.dueTasksList.map(t => `<tr>
            <td><a href="#/crm/tasks"><b>${Core.esc(t.title)}</b></a></td><td>${Core.fmtDate(t.dueDate)}</td>
            <td>${Core.badge(t.priority)}</td><td>${Core.esc(t.assignee)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty-state">No follow-ups due today.</div>'}
      </div>` : ''}
      ${widgets.inventoryAlerts ? `<div class="card">
        <div class="card-head"><h3>Low stock alerts</h3><a class="link" href="#/inventory/summary">Stock summary</a></div>
        ${d.lowStock.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Product</th><th>Balance</th><th>Min</th></tr></thead>
          <tbody>${d.lowStock.map(p => `<tr>
            <td><a href="#/inventory/summary"><b>${Core.esc(p.name)}</b><br><small class="muted">${Core.esc(p.sku)}</small></a></td>
            <td class="num">${p.balance}</td><td class="num">${p.minStock}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty-state">All stock levels are healthy.</div>'}
      </div>` : ''}
    </div>

    ${widgets.recentActivity ? `<div class="card" style="margin-top:16px">
      <div class="card-head"><h3>Recent activity</h3></div>
      ${d.recentActivity.length ? `<ul class="timeline" style="padding:16px 20px">${d.recentActivity.map(a => `
        <li><a href="#/crm/${a.entityType === 'deal' ? 'deals' : 'leads'}"><b>${Core.esc(a.text)}</b><small>${Core.esc(a.entityType)} &middot; ${Core.fmtDate(a.createdAt)}</small></a></li>`).join('')}</ul>`
      : '<div class="empty-state">Activity will appear as your team works.</div>'}
    </div>` : ''}
    ${visibleWidgetCount === 0 ? `<div class="card card-pad"><div class="empty-state">
      <div class="big">&#9881;</div><h3>Your dashboard is intentionally minimal</h3>
      <p>Your administrator has hidden all optional dashboard widgets. Your allowed modules remain available in the sidebar.</p>
    </div></div>` : ''}`;

  startDashboardWorldClocks();
});

const DASHBOARD_CLOCKS = [
  { city: 'Ahmedabad', zone: 'Asia/Kolkata', short: 'IST' },
  { city: 'Dubai', zone: 'Asia/Dubai', short: 'GST' },
  { city: 'London', zone: 'Europe/London', short: 'UK' },
  { city: 'New York', zone: 'America/New_York', short: 'ET' }
];
let dashboardClockTimer = null;

function dashboardWorldClocks() {
  return `<section class="world-clock-panel" aria-label="Live world clocks">
    <div class="world-clock-intro"><span class="world-clock-eyebrow">LIVE WORLD TIME</span><h2>Time, wherever business moves.</h2><p>Tap a clock to focus its time zone.</p></div>
    <div class="world-clock-list" role="list">
      ${DASHBOARD_CLOCKS.map((clock, index) => `<button type="button" class="world-clock ${index === 0 ? 'is-primary' : ''}" data-world-clock="${clock.zone}" aria-label="${clock.city} analog clock">
        <span class="clock-face" aria-hidden="true"><i class="clock-tick tick-12"></i><i class="clock-tick tick-3"></i><i class="clock-tick tick-6"></i><i class="clock-tick tick-9"></i><b class="clock-hand hour"></b><b class="clock-hand minute"></b><b class="clock-hand second"></b><em class="clock-pin"></em></span>
        <span class="world-clock-copy"><b>${clock.city}</b><small>${clock.short} · Live</small></span>
      </button>`).join('')}
    </div>
  </section>`;
}

function startDashboardWorldClocks() {
  const update = () => {
    if ((location.hash || '#/dashboard') !== '#/dashboard') {
      stopDashboardWorldClocks();
      return;
    }
    document.querySelectorAll('[data-world-clock]').forEach(clock => {
      const timeZone = clock.dataset.worldClock;
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
      const value = type => Number(parts.find(part => part.type === type)?.value || 0);
      const seconds = value('second');
      const minutes = value('minute');
      const hours = value('hour') % 12;
      clock.querySelector('.hour').style.transform = `rotate(${hours * 30 + minutes * .5}deg)`;
      clock.querySelector('.minute').style.transform = `rotate(${minutes * 6 + seconds * .1}deg)`;
      clock.querySelector('.second').style.transform = `rotate(${seconds * 6}deg)`;
    });
  };
  update();
  dashboardClockTimer = window.setInterval(update, 1000);
  document.querySelectorAll('[data-world-clock]').forEach(clock => {
    clock.addEventListener('click', () => {
      document.querySelectorAll('[data-world-clock]').forEach(item => item.classList.toggle('is-primary', item === clock));
    });
  });
}

function stopDashboardWorldClocks() {
  if (dashboardClockTimer) window.clearInterval(dashboardClockTimer);
  dashboardClockTimer = null;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

/* ================= LEADS ================= */
Core.route('crm/leads', async () => {
  const d = await Core.get('/crm/leads');
  const canEdit = Core.can('crm', 'edit'), canCreate = Core.can('crm', 'create');

  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Leads', `${d.leads.length} leads in your pipeline`,
      canCreate ? '<button class="btn btn-gold" onclick="Pages.openLeadForm()">+ New Lead</button>' : '')}
    <div class="filter-bar">
      <input id="lead-q" placeholder="Filter by name, company..." oninput="Pages.filterTable('leads-tbody', this.value)">
      <select id="lead-status" onchange="Pages.filterLeadStatus()">
        <option value="">All statuses</option>
        ${['new', 'contacted', 'qualified', 'converted', 'lost'].map(s => `<option>${s}</option>`).join('')}
      </select>
    </div>
    <div id="leads-table"></div>`;

  const render = rows => {
    document.getElementById('leads-table').innerHTML = Core.table([
      { label: 'Lead', render: r => `<b>${Core.esc(r.name)}</b><br><small class="muted">${Core.esc(r.company || '')}</small>` },
      { label: 'Contact', render: r => `${Core.esc(r.email || '-')}<br><small class="muted">${Core.esc(r.phone || '')}</small>` },
      { label: 'Source', key: 'source' },
      { label: 'Interest', key: 'productInterest' },
      { label: 'Value', num: true, render: r => Core.money(r.value) },
      { label: 'Status', render: r => Core.badge(r.status) },
      { label: 'Next follow-up', render: r => Core.fmtDate(r.nextFollowUp) },
      { label: '', render: r => `<div class="actions-cell">
          ${canEdit && r.status !== 'converted' ? `<button class="btn btn-outline btn-sm" onclick="Pages.convertLead('${r.id}')">Convert</button>` : ''}
          ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="Pages.openLeadForm('${r.id}')">Edit</button>` : ''}
          ${canEdit && r.status !== 'converted' ? `<button class="btn btn-ghost btn-sm" title="Delete" onclick="Pages.deleteLead('${r.id}')">&#128465;</button>` : ''}
        </div>` }
    ], rows, { emptyTitle: 'No leads yet', emptyText: 'Capture your first enquiry to start the Lead-to-Cash chain.' });
  };
  render(d.leads);
  Pages._leads = d.leads;
  Pages._renderLeads = render;

  Pages.filterLeadStatus = () => {
    const s = document.getElementById('lead-status').value;
    const q = document.getElementById('lead-q').value.toLowerCase();
    render(Pages._leads.filter(l =>
      (!s || l.status === s) &&
      (!q || (l.name + ' ' + (l.company || '')).toLowerCase().includes(q))));
  };
});

Pages.filterTable = (tbodyId, q) => { /* generic hook (status filter re-renders anyway) */ };

Pages.openLeadForm = async id => {
  let lead = null;
  if (id) lead = (await Core.get('/crm/leads')).leads.find(l => l.id === id);
  Core.formModal({
    title: lead ? 'Edit lead' : 'New lead',
    fields: [
      { name: 'name', label: 'Contact name *', required: true, value: lead?.name },
      { name: 'company', label: 'Company', half: true, value: lead?.company },
      { name: 'phone', label: 'Phone', half: true, value: lead?.phone },
      { name: 'email', label: 'Email', type: 'email', value: lead?.email },
      { name: 'source', label: 'Source', type: 'select', half: true, options: ['manual', 'IndiaMART', 'Justdial', 'TradeIndia', 'Website', 'Referral', 'Campaign'].map(s => ({ value: s, label: s })), value: lead?.source || 'manual' },
      { name: 'priority', label: 'Priority', type: 'select', half: true, options: ['low', 'medium', 'high'].map(s => ({ value: s, label: s })), value: lead?.priority || 'medium' },
      { name: 'productInterest', label: 'Product interest', value: lead?.productInterest },
      { name: 'value', label: 'Expected value (INR)', type: 'number', step: '0.01', half: true, value: lead?.value },
      { name: 'nextFollowUp', label: 'Next follow-up date', type: 'date', half: true, value: lead?.nextFollowUp },
      { name: 'status', label: 'Status', type: 'select', options: ['new', 'contacted', 'qualified', 'lost'].map(s => ({ value: s, label: s })), value: lead?.status || 'new' }
    ],
    submitLabel: lead ? 'Save changes' : 'Create lead',
    onSubmit: async v => {
      if (lead) await Core.patch('/crm/leads/' + lead.id, v);
      else await Core.post('/crm/leads', v);
      toast('Saved', lead ? 'Lead updated' : 'Lead created', 'success');
      Core.render();
    }
  });
};

Pages.convertLead = async id => {
  const ok = await Core.confirm('Convert this lead into a customer and a deal? The lead will be marked converted.', 'Convert lead');
  if (!ok) return;
  try {
    const r = await Core.post('/crm/leads/' + id + '/convert');
    toast('Converted', `Customer "${r.customer.name}" and deal created`, 'success');
    Core.render();
  } catch (e) { toast('Conversion failed', e.message, 'error'); }
};

Pages.deleteLead = async id => {
  const ok = await Core.confirm('Delete this lead? This cannot be undone.', 'Delete lead');
  if (!ok) return;
  try { await Core.del('/crm/leads/' + id); toast('Deleted', 'Lead removed', 'success'); Core.render(); }
  catch (e) { toast('Delete failed', e.message, 'error'); }
};

/* ================= CUSTOMERS ================= */
Core.route('crm/customers', async () => {
  const d = await Core.get('/crm/customers');
  const canCreate = Core.can('crm', 'create');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Customers', `${d.customers.length} customers with full 360-degree history`,
      canCreate ? '<button class="btn btn-gold" onclick="Pages.openCustomerForm()">+ New Customer</button>' : '')}
    <div id="cust-table"></div>`;
  document.getElementById('cust-table').innerHTML = Core.table([
    { label: 'Customer', render: c => `<a href="#/crm/customers/${c.id}"><b>${Core.esc(c.name)}</b></a><br><small class="muted">${Core.esc(c.contactPerson || '')}</small>` },
    { label: 'Contact', render: c => `${Core.esc(c.email || '-')}<br><small class="muted">${Core.esc(c.phone || '')}</small>` },
    { label: 'GSTIN', key: 'gstin' },
    { label: 'State code', key: 'stateCode' },
    { label: 'Credit limit', num: true, render: c => Core.money(c.creditLimit) },
    { label: 'Terms', num: true, render: c => c.paymentTermsDays + ' days' },
    { label: '', render: c => `<a class="btn btn-outline btn-sm" href="#/crm/customers/${c.id}">Open 360&deg;</a>` }
  ], d.customers, { emptyTitle: 'No customers yet', emptyText: 'Convert a lead or create a customer directly.' });
});

Core.route('crm/customers/:id', async p => {
  const [d, comm] = await Promise.all([
    Core.get('/crm/customers/' + p.id),
    Core.can('communication', 'view') ? Core.get('/ops/communications?customerId=' + encodeURIComponent(p.id)) : Promise.resolve({ communications: [] })
  ]);
  const c = d.customer;
  const phoneDigits = String(c.phone || '').replace(/\D/g, '');
  const reminderText = `Hello ${c.contactPerson || c.name}, this is a friendly reminder from ${Core.state.org.name}. Your pending amount is ${Core.money(d.summary.outstanding)}. Please share the expected payment date. Thank you.`;
  const healthLabel = { healthy: 'Healthy', watch: 'Needs follow-up', attention: 'Action needed' }[d.summary.health] || 'Healthy';
  document.getElementById('content').innerHTML = `
    ${Core.pageHead(c.name, 'Customer 360-degree view',
      `<button class="btn btn-outline" onclick="history.back()">Back</button>
       ${Core.can('crm', 'edit') ? `<button class="btn btn-outline" onclick="Pages.openCustomerForm('${c.id}')">Edit customer</button>` : ''}
       ${Core.can('crm', 'delete') ? `<button class="btn btn-outline" onclick="Pages.deleteCustomer('${c.id}')">Delete customer</button>` : ''}
       ${Core.can('sales', 'create') ? `<button class="btn btn-gold" onclick="location.hash='#/sales/quotations/new'">New Quotation</button>` : ''}
       ${Core.can('crm', 'edit') ? `<button class="btn btn-outline" onclick="Pages.createPortalInvite('${c.id}')">Invite to Portal</button>` : ''}`)}
    <div class="customer-actionbar" aria-label="Customer quick actions">
      ${phoneDigits ? `<a class="btn btn-outline btn-sm" href="tel:${phoneDigits}">Call</a><a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="https://wa.me/91${phoneDigits.replace(/^91/, '')}">WhatsApp</a>` : ''}
      ${c.email ? `<a class="btn btn-outline btn-sm" href="mailto:${encodeURIComponent(c.email)}">Email</a>` : ''}
      ${Core.can('sales', 'edit') ? `<button class="btn btn-gold btn-sm" onclick="Pages.openReceiptForm('${c.id}')">Receive Payment</button>` : ''}
      ${Core.can('service', 'create') ? `<button class="btn btn-outline btn-sm" onclick="Pages.openTicketForm('${c.id}')">New Ticket</button>` : ''}
      ${d.summary.outstanding > 0 && phoneDigits ? `<a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="https://wa.me/91${phoneDigits.replace(/^91/, '')}?text=${encodeURIComponent(reminderText)}">Send Reminder</a>` : ''}
    </div>
    <div class="grid-kpi">
      ${Core.kpi('Total Billed', Core.moneyShort(d.summary.billed))}
      ${Core.kpi('Total Received', Core.moneyShort(d.summary.paid), '', 'k-success')}
      ${Core.kpi('Outstanding', Core.moneyShort(d.summary.outstanding), '', d.summary.outstanding > 0 ? 'k-danger' : '')}
      ${Core.kpi('Payment Terms', c.paymentTermsDays + ' days', 'credit limit ' + Core.moneyShort(c.creditLimit))}
    </div>
    <div class="customer-health customer-health-${Core.esc(d.summary.health)}"><b>${healthLabel}</b><span>${d.summary.overdueInvoices ? `${d.summary.overdueInvoices} overdue invoice(s): ${Core.money(d.summary.overdueAmount)}` : 'No overdue invoice'} &middot; ${d.summary.openTickets} open ticket(s)${d.summary.amcDaysRemaining != null ? ` &middot; AMC ${d.summary.amcDaysRemaining < 0 ? 'expired' : `expires in ${d.summary.amcDaysRemaining} day(s)`}` : ''}</span></div>
    <div class="meta-grid" style="margin-bottom:16px">
      <div class="meta-item"><span>Contact person</span><b>${Core.esc(c.contactPerson || '-')}</b></div>
      <div class="meta-item"><span>Email</span><b>${Core.esc(c.email || '-')}</b></div>
      <div class="meta-item"><span>Phone</span><b>${Core.esc(c.phone || '-')}</b></div>
      <div class="meta-item"><span>GSTIN</span><b>${Core.esc(c.gstin || '-')}</b></div>
      <div class="meta-item"><span>Billing address</span><b>${Core.esc([c.billingAddress?.line1, c.billingAddress?.city, c.billingAddress?.state].filter(Boolean).join(', ') || '-')}</b></div>
      <div class="meta-item"><span>Godown / delivery address</span><b>${Core.esc([c.shippingAddress?.line1, c.shippingAddress?.city, c.shippingAddress?.state].filter(Boolean).join(', ') || '-')}</b></div>
      <div class="meta-item"><span>Place of supply</span><b>State code ${Core.esc(c.stateCode)}</b></div>
    </div>
    <div class="grid-even">
      <div class="card"><div class="card-head"><h3>Invoices (${d.invoices.length})</h3></div>
        ${d.invoices.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Number</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${d.invoices.map(i => `<tr><td><a href="#/print/invoice/${i.id}">${Core.esc(i.number)}</a></td><td>${Core.fmtDate(i.date)}</td><td class="num">${Core.money(i.totals?.grandTotal)}</td><td>${Core.badge(i.status)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty-state">No invoices yet.</div>'}
      </div>
      <div class="card"><div class="card-head"><h3>Tickets & AMC</h3></div>
        ${(d.tickets.length + d.amcContracts.length) ? `<ul class="timeline" style="padding:14px 20px">
          ${d.amcContracts.map(a => `<li><b>AMC ${Core.esc(a.number)} - ${Core.esc(a.assetDesc)}</b><small>till ${Core.fmtDate(a.endDate)} &middot; ${Core.badge(a.status)}</small></li>`).join('')}
          ${d.tickets.map(t => `<li><b>${Core.esc(t.subject)}</b><small>${Core.esc(t.number)} &middot; ${Core.badge(t.status)}</small></li>`).join('')}
        </ul>` : '<div class="empty-state">No service history.</div>'}
      </div>
    </div>
    <div class="card customer-documents" style="margin-top:16px"><div class="card-head"><div><h3>Customer Documents</h3><small class="muted">PO, agreement, GST certificate or approved quotation</small></div>${Core.can('crm', 'edit') ? `<button class="btn btn-outline btn-sm" onclick="Pages.openCustomerDocumentForm('${c.id}')">Upload document</button>` : ''}</div>
      ${d.documents.length ? `<div class="document-list">${d.documents.map(doc => `<div class="document-item"><span><b>${Core.esc(doc.title)}</b><small>${Core.esc((doc.mimeType || '').replace('application/', '').replace('image/', '').toUpperCase())} &middot; ${Core.fmtDate(doc.createdAt)}</small></span><span><a class="btn btn-outline btn-sm" href="/api/crm/customers/${c.id}/documents/${doc.id}/download">Download</a>${Core.can('crm', 'edit') ? `<button class="btn btn-ghost btn-sm" onclick="Pages.deleteCustomerDocument('${c.id}','${doc.id}')">Remove</button>` : ''}</span></div>`).join('')}</div>` : '<div class="empty-state">No documents uploaded yet.</div>'}
    </div>
    ${Core.can('communication', 'view') ? `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Communication Timeline</h3><a class="link" href="#/communication/history">View all</a></div>${comm.communications.length ? `<ul class="timeline" style="padding:16px 20px">${comm.communications.slice(0,20).map(item => `<li><b>${Core.esc(String(item.messageType || 'message').replace(/_/g,' '))} · ${Core.esc(item.channel)}</b><small>${Core.fmtDate(item.createdAt)} · ${Core.badge(item.status)}</small></li>`).join('')}</ul>` : '<div class="empty-state">No communication history for this customer.</div>'}</div>` : ''}`;
});

Pages.openCustomerDocumentForm = function (customerId) {
  const modal = Core.openModal({ title: 'Upload customer document', wide: false,
    body: `<form id="customer-document-form"><label class="field"><span>Document title *</span><input name="title" required maxlength="120" placeholder="e.g. Purchase Order - Sep 2026"></label><label class="field"><span>File * (PDF, PNG, JPG or WEBP; max 1.5 MB)</span><input name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></label></form>`,
    footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="customer-document-form">Upload</button>' });
  modal.el.querySelector('[data-cancel]').onclick = modal.close;
  modal.el.querySelector('#customer-document-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, file = form.file.files[0];
    if (!file) return;
    if (file.size > 1536 * 1024) { toast('File too large', 'Choose a file smaller than 1.5 MB', 'error'); return; }
    const button = modal.el.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const contentData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      await Core.post('/crm/customers/' + customerId + '/documents', { title: form.title.value, contentData });
      toast('Document uploaded', 'Customer document is available to your team', 'success'); modal.close(); Core.render();
    } catch (error) { toast('Upload failed', error.message || 'Please try again', 'error'); button.disabled = false; }
  });
};

Pages.deleteCustomerDocument = async function (customerId, documentId) {
  if (!await Core.confirm('Remove this document? This cannot be undone.', 'Remove document')) return;
  try { await Core.del('/crm/customers/' + customerId + '/documents/' + documentId); toast('Removed', 'Customer document removed', 'success'); Core.render(); }
  catch (error) { toast('Remove failed', error.message, 'error'); }
};

Pages.createPortalInvite = async id => { try { const r = await Core.post('/crm/customers/' + id + '/portal-invite', {}); const value = r.inviteUrl || r.token; await navigator.clipboard.writeText(value); toast('Portal invite created', r.inviteUrl ? 'Secure portal link copied.' : 'Access code copied. Set PORTAL_WEB_URL in Render first.', 'success'); } catch (e) { toast('Invite failed', e.message, 'error'); } };
Pages.openCustomerForm = async function (id) {
  const existing = id ? (await Core.get('/crm/customers/' + id)).customer : null;
  Core.formModal({
    title: existing ? 'Edit customer' : 'New customer',
    fields: [
      { name: 'name', label: 'Company / customer name *', required: true, value: existing?.name },
      { name: 'contactPerson', label: 'Contact person', half: true, value: existing?.contactPerson },
      { name: 'phone', label: 'Phone', half: true, value: existing?.phone },
      { name: 'email', label: 'Email', type: 'email', value: existing?.email },
      { name: 'gstin', label: 'GSTIN', half: true, value: existing?.gstin },
      { name: 'stateCode', label: 'State code (place of supply)', type: 'select', half: true,
        options: [['27', 'Maharashtra (27)'], ['29', 'Karnataka (29)'], ['24', 'Gujarat (24)'], ['33', 'Tamil Nadu (33)'], ['36', 'Telangana (36)'], ['07', 'Delhi (07)']].map(([v, l]) => ({ value: v, label: l })), value: existing?.stateCode || '24' },
      { name: 'creditLimit', label: 'Credit limit (INR)', type: 'number', half: true, value: existing?.creditLimit },
      { name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', half: true, value: existing?.paymentTermsDays ?? 30 }
      ,{ name: 'billingLine1', label: 'Billing address', type: 'textarea', value: existing?.billingAddress?.line1, placeholder: 'Office / billing address' }
      ,{ name: 'billingCity', label: 'Billing city', half: true, value: existing?.billingAddress?.city }
      ,{ name: 'billingState', label: 'Billing state', half: true, value: existing?.billingAddress?.state }
      ,{ name: 'billingPincode', label: 'Billing PIN code', half: true, value: existing?.billingAddress?.pincode }
      ,{ name: 'shippingLine1', label: 'Godown / delivery address', type: 'textarea', value: existing?.shippingAddress?.line1, placeholder: 'Optional warehouse or delivery address' }
      ,{ name: 'shippingCity', label: 'Godown / delivery city', half: true, value: existing?.shippingAddress?.city }
      ,{ name: 'shippingState', label: 'Godown / delivery state', half: true, value: existing?.shippingAddress?.state }
      ,{ name: 'shippingPincode', label: 'Godown / delivery PIN code', half: true, value: existing?.shippingAddress?.pincode }
    ],
    submitLabel: existing ? 'Save changes' : 'Create customer',
    onSubmit: async v => {
      v.billingAddress = { line1: v.billingLine1 || '', city: v.billingCity || '', state: v.billingState || '', pincode: v.billingPincode || '' };
      v.shippingAddress = { line1: v.shippingLine1 || '', city: v.shippingCity || '', state: v.shippingState || '', pincode: v.shippingPincode || '' };
      delete v.billingLine1; delete v.billingCity; delete v.billingState; delete v.billingPincode;
      delete v.shippingLine1; delete v.shippingCity; delete v.shippingState; delete v.shippingPincode;
      if (existing) await Core.patch('/crm/customers/' + existing.id, v); else await Core.post('/crm/customers', v);
      toast('Saved', existing ? 'Customer updated' : 'Customer added', 'success');
      Core.render();
    }
  });
};

/* ================= DEALS (kanban) ================= */
Core.route('crm/deals', async () => {
  const d = await Core.get('/crm/deals');
  const stages = d.stages;
  const canEdit = Core.can('crm', 'edit');

  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Deals Pipeline', 'Drag cards between stages to update the deal',
      Core.can('crm', 'create') ? '<button class="btn btn-gold" onclick="Pages.openDealForm()">+ New Deal</button>' : '')}
    <div class="kanban" id="kanban">
      ${stages.map(st => {
        const deals = d.deals.filter(x => x.stage === st);
        const total = deals.reduce((s, x) => s + x.value, 0);
        return `<div class="kan-col" data-stage="${st}">
          <h4>${st}<span>${deals.length} &middot; ${Core.moneyShort(total)}</span></h4>
          ${deals.map(dl => `
            <div class="kan-card" draggable="${canEdit}" data-id="${dl.id}">
              <b>${Core.esc(dl.title)}</b>
              <div class="kv"><span>${Core.esc(dl.customerName)}</span><span class="val">${Core.moneyShort(dl.value)}</span></div>
              <div class="kv"><span>P${dl.probability} &middot; close ${Core.fmtDate(dl.expectedClose)}</span>
                ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();Pages.openDealForm('${dl.id}')">&#9998;</button>` : ''}</div>
            </div>`).join('')}
        </div>`;
      }).join('')}
    </div>`;

  if (!canEdit) return;
  let dragId = null;
  document.querySelectorAll('.kan-card').forEach(card => {
    card.addEventListener('dragstart', () => { dragId = card.dataset.id; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.kan-col').forEach(col => {
    col.addEventListener('dragover', e => e.preventDefault());
    col.addEventListener('drop', async () => {
      if (!dragId) return;
      const deal = d.deals.find(x => x.id === dragId);
      const stage = col.dataset.stage;
      dragId = null;
      if (!deal || deal.stage === stage) return;
      try {
        await Core.patch('/crm/deals/' + deal.id, { stage });
        toast('Stage updated', `"${deal.title}" moved to ${stage}`, 'success');
        Core.render();
      } catch (e) { toast('Move failed', e.message, 'error'); }
    });
  });
});

Pages.openDealForm = async id => {
  const [dealsD, custD] = await Promise.all([Core.get('/crm/deals'), Core.get('/crm/customers')]);
  const deal = id ? dealsD.deals.find(x => x.id === id) : null;
  Core.formModal({
    title: deal ? 'Edit deal' : 'New deal',
    fields: [
      { name: 'title', label: 'Deal title *', required: true, value: deal?.title },
      { name: 'customerId', label: 'Customer', type: 'select',
        options: [{ value: '', label: '- none -' }, ...custD.customers.map(c => ({ value: c.id, label: c.name }))], value: deal?.customerId || '' },
      { name: 'value', label: 'Value (INR)', type: 'number', step: '0.01', half: true, value: deal?.value },
      { name: 'stage', label: 'Stage', type: 'select', half: true,
        options: dealsD.stages.map(s => ({ value: s, label: s })), value: deal?.stage || 'new' },
      { name: 'probability', label: 'Probability %', type: 'number', half: true, value: deal?.probability ?? 10 },
      { name: 'expectedClose', label: 'Expected close', type: 'date', half: true, value: deal?.expectedClose }
    ],
    submitLabel: deal ? 'Save changes' : 'Create deal',
    onSubmit: async v => {
      if (deal) await Core.patch('/crm/deals/' + deal.id, v);
      else await Core.post('/crm/deals', v);
      toast('Saved', 'Deal saved', 'success');
      Core.render();
    }
  });
};

/* ================= TASKS ================= */
Core.route('crm/tasks', async () => {
  const d = await Core.get('/crm/tasks');
  const today = new Date().toISOString().slice(0, 10);
  const canEdit = Core.can('crm', 'edit');

  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Tasks & Follow-ups', 'Calls, visits and reminders across the team',
      Core.can('crm', 'create') ? '<button class="btn btn-gold" onclick="Pages.openTaskForm()">+ New Task</button>' : '')}
    ${Core.table([
      { label: 'Task', render: t => `<b>${Core.esc(t.title)}</b>${t.notes ? `<br><small class="muted">${Core.esc(t.notes)}</small>` : ''}` },
      { label: 'Type', render: t => Core.badge(t.type) },
      { label: 'Due', render: t => Core.fmtDate(t.dueDate) + (t.status === 'open' && t.dueDate < today ? ' <span class="badge b-danger">overdue</span>' : '') },
      { label: 'Priority', render: t => Core.badge(t.priority) },
      { label: 'Assignee', key: 'assigneeName' },
      { label: 'Status', render: t => Core.badge(t.status) },
      { label: '', render: t => canEdit && t.status === 'open'
        ? `<button class="btn btn-outline btn-sm" onclick="Pages.completeTask('${t.id}')">Mark done</button>` : '' }
    ], d.tasks, { emptyTitle: 'No tasks', emptyText: 'Schedule follow-ups so no enquiry goes cold.' })}`;
});

Pages.openTaskForm = function () {
  Core.formModal({
    title: 'New task / follow-up',
    fields: [
      { name: 'title', label: 'What needs doing? *', required: true },
      { name: 'type', label: 'Type', type: 'select', half: true, options: ['followup', 'task', 'visit'].map(v => ({ value: v, label: v })) },
      { name: 'priority', label: 'Priority', type: 'select', half: true, options: ['low', 'medium', 'high', 'urgent'].map(v => ({ value: v, label: v })) },
      { name: 'dueDate', label: 'Due date', type: 'date', half: true },
      { name: 'notes', label: 'Notes' }
    ],
    submitLabel: 'Create task',
    onSubmit: async v => {
      await Core.post('/crm/tasks', v);
      toast('Created', 'Task scheduled', 'success');
      Core.render();
    }
  });
};

Pages.completeTask = async id => {
  try { await Core.patch('/crm/tasks/' + id, { status: 'done' }); toast('Done', 'Task completed', 'success'); Core.render(); }
  catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.deleteCustomer = async id => {
  const ok = await Core.confirm('Delete this customer? Customers with invoices, receipts, deals, tickets or AMC records cannot be deleted.', 'Delete customer');
  if (!ok) return;
  try { await Core.del('/crm/customers/' + id); toast('Deleted', 'Customer removed', 'success'); location.hash = '#/crm/customers'; }
  catch (e) { toast('Delete blocked', e.message, 'error'); }
};

/* ================= CONTACTS + MEETINGS ================= */
Core.route('crm/contacts', async () => {
  const [d, customers] = await Promise.all([Core.get('/crm/contacts'), Core.get('/crm/customers')]);
  document.getElementById('content').innerHTML = `${Core.pageHead('Contacts', 'Customer decision makers and operational contacts', Core.can('crm','edit') ? '<button class="btn btn-gold" onclick="Pages.openContactForm()">+ New Contact</button>' : '')}
    ${Core.table([{label:'Contact',render:r=>`<b>${Core.esc(r.name)}</b><br><small class="muted">${Core.esc(r.designation||'')}</small>`},{label:'Customer',key:'customerName'},{label:'Phone',key:'phone'},{label:'Email',key:'email'},{label:'',render:r=>r.primary?'<span class="badge b-gold">Primary</span>':''}],d.contacts,{emptyTitle:'No contacts yet',emptyText:'Add a contact person against a customer.'})}`;
  Pages._contactCustomers = customers.customers;
});
Pages.openContactForm = () => Core.formModal({title:'New customer contact',fields:[{name:'customerId',label:'Customer *',type:'select',required:true,options:(Pages._contactCustomers||[]).map(c=>({value:c.id,label:c.name}))},{name:'name',label:'Contact name *',required:true},{name:'designation',label:'Designation',half:true},{name:'phone',label:'Phone',half:true},{name:'email',label:'Email',type:'email'},{name:'primary',label:'Primary contact',type:'select',options:[{value:'false',label:'No'},{value:'true',label:'Yes'}]}],submitLabel:'Save contact',onSubmit:async v=>{v.primary=v.primary==='true';await Core.post('/crm/contacts',v);toast('Saved','Contact added','success');Core.render();}});

Core.route('crm/meetings', async () => {
  const [d, customers] = await Promise.all([Core.get('/crm/meetings'), Core.get('/crm/customers')]);
  document.getElementById('content').innerHTML = `${Core.pageHead('Meetings', 'Planned client calls, visits and online meetings', Core.can('crm','edit') ? '<button class="btn btn-gold" onclick="Pages.openMeetingForm()">+ Schedule Meeting</button>' : '')}
    ${Core.table([{label:'Meeting',render:r=>`<b>${Core.esc(r.title)}</b><br><small class="muted">${Core.esc(r.mode)}</small>`},{label:'Customer',key:'customerName'},{label:'When',render:r=>Core.fmtDate(r.scheduledAt)},{label:'Owner',key:'ownerName'},{label:'Status',render:r=>Core.badge(r.status)}],d.meetings,{emptyTitle:'No meetings planned',emptyText:'Schedule a client discussion or field visit.'})}`;
  Pages._meetingCustomers=customers.customers;
});
Pages.openMeetingForm=()=>Core.formModal({title:'Schedule meeting',fields:[{name:'customerId',label:'Customer *',type:'select',required:true,options:(Pages._meetingCustomers||[]).map(c=>({value:c.id,label:c.name}))},{name:'title',label:'Meeting title *',required:true},{name:'scheduledAt',label:'Date and time *',type:'datetime-local',required:true,half:true},{name:'durationMinutes',label:'Duration (minutes)',type:'number',half:true,value:30},{name:'mode',label:'Mode',type:'select',options:['office','online','visit'].map(v=>({value:v,label:v}))},{name:'notes',label:'Notes',type:'textarea'}],submitLabel:'Schedule',onSubmit:async v=>{await Core.post('/crm/meetings',v);toast('Scheduled','Meeting added to your plan','success');Core.render();}});

Core.route('crm/daily-work', async () => {
  const d = await Core.get('/crm/daily-work');
  document.getElementById('content').innerHTML = `${Core.pageHead('Daily Follow-up Command Centre', 'Today\'s calls, meetings and overdue collections in one view')}
    <div class="kpi-grid">${Core.kpi('Follow-ups due',d.totals.followUps,'Open tasks due today','#/crm/tasks')}${Core.kpi('Meetings today',d.totals.meetings,'Planned customer discussions','#/crm/meetings')}${Core.kpi('Late payments',d.totals.latePayments,Core.money(d.totals.overdueAmount)+' outstanding','#/crm/late-payments')}</div>
    <section class="section-block"><h3>Follow-ups due</h3>${Core.table([{label:'Task',key:'title'},{label:'Due',render:r=>Core.fmtDate(r.dueDate)},{label:'Priority',render:r=>Core.badge(r.priority)},{label:'Assignee',key:'assigneeName'}],d.tasks,{emptyTitle:'No follow-ups due',emptyText:'Your due follow-ups are clear for today.'})}</section>
    <section class="section-block"><h3>Meetings today</h3>${Core.table([{label:'Meeting',key:'title'},{label:'Customer',key:'customerName'},{label:'Time',render:r=>new Date(r.scheduledAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})},{label:'Mode',render:r=>Core.badge(r.mode)}],d.meetings,{emptyTitle:'No meetings today',emptyText:'Schedule a customer meeting when needed.'})}</section>`;
});

Core.route('crm/late-payments', async () => {
  const d = await Core.get('/crm/late-payments');
  document.getElementById('content').innerHTML = `${Core.pageHead('Late Payments',Core.money(d.totalOutstanding)+' pending beyond the due date')}
    ${Core.table([{label:'Invoice',key:'number'},{label:'Customer',key:'customerName'},{label:'Due date',render:r=>Core.fmtDate(r.dueDate)},{label:'Overdue',render:r=>r.overdueDays+' days'},{label:'Outstanding',render:r=>Core.money(r.outstanding)},{label:'Status',render:r=>Core.badge(r.status)}],d.invoices,{emptyTitle:'No late payments',emptyText:'All open invoices are within their payment terms.'})}`;
});

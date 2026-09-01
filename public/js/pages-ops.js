/* ============================================================
   Pages: Manufacturing, Service/AMC/Tickets, Finance, HR,
          Reports, Admin, Print documents
   ============================================================ */
'use strict';

/* ================= MANUFACTURING - BOMs ================= */
Core.route('manufacturing/boms', async () => {
  const d = await Core.get('/manufacturing/boms');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Bills of Material', 'Component recipes with cost roll-up',
      Core.can('manufacturing', 'create') ? '<button class="btn btn-gold" onclick="Pages.openBomForm()">+ New BOM</button>' : '')}
    ${Core.table([
      { label: 'Code', render: b => `<b>${Core.esc(b.code)}</b> <span class="badge b-neutral">rev ${Core.esc(b.revision)}</span>` },
      { label: 'Output', key: 'outputName' },
      { label: 'Output qty', num: true, key: 'outputQty' },
      { label: 'Components', render: b => b.lines.map(l => {
          const p = Pages._prodCache?.[l.productId];
          return `${p ? Core.esc(p.name) : '?'} x${l.qty}${l.scrapPct ? ` (+${l.scrapPct}% scrap)` : ''}`;
        }).join('<br>') },
      { label: 'Material cost', num: true, render: b => Core.money(b.materialCost) },
      { label: '', render: b => `<button class="btn btn-outline btn-sm" onclick="Pages.showBomCost('${b.id}')">Cost roll-up</button>` }
    ], d.boms, { emptyTitle: 'No BOMs', emptyText: 'Define how finished goods are assembled.' })}`;
  /* cache products for component names */
  Core.get('/inventory/products').then(pd => { Pages._prodCache = Object.fromEntries(pd.products.map(p => [p.id, p])); }).catch(() => {});
});

Pages.openBomForm = async () => {
  const pd = await Core.get('/inventory/products');
  const m = Core.openModal({
    title: 'New BOM',
    wide: true,
    body: `<form id="bom-form">
      <div class="grid-2">
        <label class="field"><span>Output product *</span><select name="outputProductId" required>
          ${pd.products.filter(p => p.type !== 'service').map(p => `<option value="${p.id}">${Core.esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Output quantity per batch</span><input type="number" name="outputQty" value="1" step="any"></label>
        <label class="field"><span>Labor cost / unit</span><input type="number" step="any" name="laborCostPerUnit" value="0"></label>
        <label class="field"><span>Overhead / unit</span><input type="number" step="any" name="overheadPerUnit" value="0"></label>
      </div>
      <p style="font-weight:700;font-size:13px;margin:8px 0">Components</p>
      <div id="bom-lines">
        <div class="grid-2 bom-line" style="margin-bottom:8px">
          <select name="compProduct">${pd.products.filter(p => p.type !== 'finished').map(p => `<option value="${p.id}">${Core.esc(p.name)}</option>`).join('')}</select>
          <div style="display:flex;gap:8px">
            <input type="number" name="compQty" placeholder="qty" step="any" required>
            <input type="number" name="compScrap" placeholder="scrap %" step="any" value="0">
            <button type="button" class="rm" onclick="this.closest('.bom-line').remove()">&times;</button>
          </div>
        </div>
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="Pages.addBomLine()">+ Add component</button>
    </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="bom-form">Create BOM</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#bom-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = [...m.el.querySelectorAll('.bom-line')].map(row => ({
      productId: row.querySelector('select').value,
      qty: Number(row.querySelector('[name="compQty"]').value),
      scrapPct: Number(row.querySelector('[name="compScrap"]').value) || 0
    })).filter(l => l.productId && l.qty > 0);
    try {
      await Core.post('/manufacturing/boms', {
        outputProductId: fd.get('outputProductId'), outputQty: Number(fd.get('outputQty')) || 1,
        laborCostPerUnit: Number(fd.get('laborCostPerUnit')) || 0,
        overheadPerUnit: Number(fd.get('overheadPerUnit')) || 0, lines
      });
      toast('Created', 'BOM saved', 'success');
      m.close(); Core.render();
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};
Pages.addBomLine = () => {
  const wrap = document.getElementById('bom-lines');
  if (!wrap) return;
  const first = wrap.querySelector('.bom-line');
  const clone = first.cloneNode(true);
  clone.querySelectorAll('input').forEach(i => { if (!i.name.includes('Scrap')) i.value = ''; });
  wrap.appendChild(clone);
};

Pages.showBomCost = async id => {
  const d = await Core.get('/manufacturing/boms/' + id + '/cost');
  Core.openModal({
    title: 'Cost roll-up',
    wide: true,
    body: `
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Component</th><th>Qty</th><th>Unit cost</th><th>Scrap %</th><th class="num">Cost</th></tr></thead>
        <tbody>${d.detail.map(r => `<tr><td>${Core.esc(r.component)}</td><td>${r.qty} ${Core.esc(r.uom)}</td>
          <td>${Core.money(r.unitCost)}</td><td>${r.scrapPct}%</td><td class="num">${Core.money(r.cost)}</td></tr>`).join('')}</tbody></table></div>
      <div class="totals-box" style="margin-top:14px">
        <div class="tr"><span>Material</span><span>${Core.money(d.totals.material)}</span></div>
        <div class="tr"><span>Labor</span><span>${Core.money(d.totals.labor)}</span></div>
        <div class="tr"><span>Overhead</span><span>${Core.money(d.totals.overhead)}</span></div>
        <div class="tr grand"><span>Total (per ${d.totals.outputQty} unit)</span><span>${Core.money(d.totals.total)}</span></div>
        <div class="tr"><span>Cost per output unit</span><span><b>${Core.money(d.totals.perUnit)}</b></span></div>
      </div>`,
    footer: '<button class="btn btn-outline" data-cancel>Close</button>'
  });
};

/* ================= MANUFACTURING - JOB ORDERS ================= */
Core.route('manufacturing/jobs', async () => {
  const d = await Core.get('/manufacturing/job-orders');
  const canEdit = Core.can('manufacturing', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Job Orders', 'Production runs: issue material, record output and wastage',
      Core.can('manufacturing', 'create') ? '<button class="btn btn-gold" onclick="Pages.openJobForm()">+ New Job Order</button>' : '')}
    ${Core.table([
      { label: 'Job', render: j => `<b>${Core.esc(j.number)}</b><br><small class="muted">${Core.esc(j.bomCode)} &rarr; ${Core.esc(j.outputName)}</small>` },
      { label: 'Planned', num: true, key: 'plannedQty' },
      { label: 'Issued', render: j => j.issues.length ? j.issues.map(i => `${Core.esc(i.name)} x${i.qty}`).join('<br>') : '-' },
      { label: 'Output', render: j => j.outputs.length
          ? j.outputs.map(o => `<span class="badge b-success">+${o.goodQty}</span> <span class="badge b-danger">-${o.rejectedQty}</span>`).join(' ')
          : '-' },
      { label: 'Due', render: j => Core.fmtDate(j.dueDate) },
      { label: 'Status', render: j => Core.badge(j.status) },
      { label: '', render: j => `<div class="actions-cell">
        ${canEdit && j.status === 'planned' ? `<button class="btn btn-outline btn-sm" onclick="Pages.jobAction('${j.id}','release')">Release</button>` : ''}
        ${canEdit && ['released', 'in_progress'].includes(j.status) ? `<button class="btn btn-gold btn-sm" onclick="Pages.openIssueForm('${j.id}')">Issue material</button>` : ''}
        ${canEdit && j.status === 'in_progress' ? `<button class="btn btn-dark btn-sm" onclick="Pages.openOutputForm('${j.id}')">Record output</button>` : ''}
        ${canEdit && ['completed', 'in_progress'].includes(j.status) ? `<button class="btn btn-ghost btn-sm" onclick="Pages.jobAction('${j.id}','close')">Close</button>` : ''}
      </div>` }
    ], d.jobOrders, { emptyTitle: 'No job orders', emptyText: 'Plan production from a BOM.' })}`;
});

Pages.openJobForm = async () => {
  const bd = await Core.get('/manufacturing/boms');
  if (!bd.boms.length) return toast('No BOMs', 'Create a BOM first', 'warning');
  Core.formModal({
    title: 'New job order',
    fields: [
      { name: 'bomId', label: 'BOM *', type: 'select', required: true, options: bd.boms.map(b => ({ value: b.id, label: `${b.code} (${b.outputName})` })) },
      { name: 'plannedQty', label: 'Planned quantity *', type: 'number', required: true, half: true },
      { name: 'dueDate', label: 'Due date', type: 'date', half: true },
      { name: 'priority', label: 'Priority', type: 'select', half: true, options: ['low', 'normal', 'high'].map(v => ({ value: v, label: v })) }
    ],
    submitLabel: 'Create job order',
    onSubmit: async v => { await Core.post('/manufacturing/job-orders', v); toast('Created', 'Job order planned', 'success'); Core.render(); }
  });
};

Pages.jobAction = async (id, action) => {
  try { await Core.post(`/manufacturing/job-orders/${id}/${action}`); toast('Done', 'Job order updated', 'success'); Core.render(); }
  catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.openIssueForm = async jobId => {
  const [jd, pd] = await Promise.all([Core.get('/manufacturing/job-orders'), Core.get('/inventory/products')]);
  const job = jd.jobOrders.find(j => j.id === jobId);
  const bom = (await Core.get('/manufacturing/boms')).boms.find(b => b.id === job.bomId);
  const perUnit = Math.max(1, bom.outputQty);
  const remaining = Math.max(0, job.plannedQty - job.outputs.reduce((s, o) => s + o.goodQty + o.rejectedQty, 0));
  const m = Core.openModal({
    title: 'Issue material - ' + job.number,
    wide: true,
    body: `<form id="issue-form">
      <p class="muted" style="font-size:13px;margin-bottom:10px">Suggested quantities for ${remaining} remaining unit(s):</p>
      ${bom.lines.map((l, i) => {
        const p = pd.products.find(x => x.id === l.productId);
        return `<label class="field"><span>${Core.esc(p?.name || '?')} <small>(BOM: ${l.qty}/unit${l.scrapPct ? ' +' + l.scrapPct + '% scrap' : ''})</small></span>
          <input type="number" step="any" name="qty_${i}" value="${Math.ceil(l.qty * (1 + l.scrapPct / 100) * remaining)}"></label>
          <input type="hidden" name="pid_${i}" value="${l.productId}">`;
      }).join('')}
    </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="issue-form">Post issue to ledger</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#issue-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = bom.lines.map((_, i) => ({ productId: fd.get('pid_' + i), qty: Number(fd.get('qty_' + i)) || 0 }))
      .filter(l => l.qty > 0);
    if (!lines.length) return toast('Nothing entered', 'Enter at least one quantity', 'warning');
    try {
      await Core.post(`/manufacturing/job-orders/${jobId}/issue-material`, { lines });
      toast('Issued', 'Material issued - stock reduced via ledger', 'success');
      m.close(); Core.render();
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};

Pages.openOutputForm = async jobId => {
  const jd = await Core.get('/manufacturing/job-orders');
  const job = jd.jobOrders.find(j => j.id === jobId);
  const produced = job.outputs.reduce((s, o) => s + o.goodQty + o.rejectedQty, 0);
  const remaining = job.plannedQty - produced;
  Core.formModal({
    title: 'Record production output - ' + job.number,
    fields: [
      { name: 'goodQty', label: `Good quantity * (max ${remaining})`, type: 'number', required: true, half: true },
      { name: 'rejectedQty', label: 'Rejected / wastage', type: 'number', half: true, value: 0 }
    ],
    submitLabel: 'Record output',
    onSubmit: async v => {
      await Core.post(`/manufacturing/job-orders/${jobId}/record-output`, v);
      toast('Recorded', 'Finished stock updated via ledger', 'success');
      Core.render();
    }
  });
};

/* ================= SERVICE - AMC ================= */
Core.route('service/amc', async () => {
  const d = await Core.get('/service/amc');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('AMC Contracts', 'Annual maintenance contracts - auto-created from eligible invoices',
      Core.can('service', 'create') ? '<button class="btn btn-gold" onclick="Pages.openAmcForm()">+ New Contract</button>' : '')}
    ${Core.table([
      { label: 'Contract', render: a => `<b>${Core.esc(a.number)}</b><br><small class="muted">${Core.esc(a.assetDesc)}</small>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Period', render: a => `${Core.fmtDate(a.startDate)} &rarr; ${Core.fmtDate(a.endDate)}` },
      { label: 'Value', num: true, render: a => Core.money(a.value) },
      { label: 'Visits', num: true, render: a => `${a.visitsUsed}/${a.visitsAllowed}` },
      { label: 'Status', render: a => Core.badge(a.status) + (a.daysLeft >= 0 && a.daysLeft <= 60 ? ` <small class="muted">(${a.daysLeft}d left)</small>` : '') },
      { label: '', render: a => Core.can('service', 'edit') && !['renewed', 'cancelled'].includes(a.status)
        ? `<button class="btn btn-outline btn-sm" onclick="Pages.renewAmc('${a.id}')">Renew</button>` : '' }
    ], d.contracts, { emptyTitle: 'No AMC contracts', emptyText: 'Invoice an AMC-eligible product or create one manually.' })}`;
});

Pages.renewAmc = async id => {
  Core.formModal({
    title: 'Renew AMC contract',
    fields: [
      { name: 'months', label: 'Duration (months)', type: 'number', value: 12, half: true },
      { name: 'value', label: 'Renewal value (INR)', type: 'number', step: '0.01', half: true }
    ],
    submitLabel: 'Renew contract',
    onSubmit: async v => {
      await Core.post(`/service/amc/${id}/renew`, v);
      toast('Renewed', 'New contract created', 'success');
      Core.render();
    }
  });
};

Pages.openAmcForm = function () {
  Core.get('/crm/customers').then(custD => {
    Core.formModal({
      title: 'New AMC contract',
      fields: [
        { name: 'customerId', label: 'Customer *', type: 'select', required: true, options: custD.customers.map(c => ({ value: c.id, label: c.name })) },
        { name: 'assetDesc', label: 'Asset description' },
        { name: 'startDate', label: 'Start date', type: 'date', required: true, half: true },
        { name: 'endDate', label: 'End date', type: 'date', required: true, half: true },
        { name: 'value', label: 'Contract value', type: 'number', step: '0.01', half: true },
        { name: 'visitsAllowed', label: 'Visits allowed', type: 'number', value: 4, half: true }
      ],
      submitLabel: 'Create contract',
      onSubmit: async v => { await Core.post('/service/amc', v); toast('Created', 'AMC contract created', 'success'); Core.render(); }
    });
  });
};

/* ================= SERVICE - TICKETS ================= */
Core.route('service/tickets', async () => {
  const d = await Core.get('/service/tickets');
  const canEdit = Core.can('service', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Service Tickets', 'SLA-tracked tickets with engineer assignment and parts usage',
      Core.can('service', 'create') ? '<button class="btn btn-gold" onclick="Pages.openTicketForm()">+ New Ticket</button>' : '')}
    ${Core.table([
      { label: 'Ticket', render: t => `<b>${Core.esc(t.number)}</b><br><small class="muted">${Core.esc(t.subject)}</small>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Priority', render: t => Core.badge(t.priority) },
      { label: 'Assignee', key: 'assignedName' },
      { label: 'SLA', render: t => t.slaBreached ? '<span class="badge b-danger">breached</span>' : `<small class="muted">due ${new Date(t.slaDueAt).toLocaleString('en-IN')}</small>` },
      { label: 'Status', render: t => Core.badge(t.status) },
      { label: '', render: t => canEdit ? `<div class="actions-cell">
          <button class="btn btn-outline btn-sm" onclick="Pages.openTicketDetail('${t.id}')">Manage</button>
        </div>` : '' }
    ], d.tickets, { emptyTitle: 'No tickets', emptyText: 'Log customer issues here.' })}`;
});

Pages.openTicketForm = function () {
  Promise.all([Core.get('/crm/customers')]).then(([custD]) => {
    Core.formModal({
      title: 'New service ticket',
      fields: [
        { name: 'customerId', label: 'Customer *', type: 'select', required: true, options: custD.customers.map(c => ({ value: c.id, label: c.name })) },
        { name: 'subject', label: 'Subject *', required: true },
        { name: 'category', label: 'Category', type: 'select', half: true, options: ['general', 'mechanical', 'electrical', 'installation', 'warranty'].map(v => ({ value: v, label: v })) },
        { name: 'priority', label: 'Priority', type: 'select', half: true, options: ['low', 'medium', 'high', 'urgent'].map(v => ({ value: v, label: v })) },
        { name: 'slaHours', label: 'SLA hours', type: 'number', value: 24, half: true },
        { name: 'assetDesc', label: 'Asset / serial no.', half: true }
      ],
      submitLabel: 'Create ticket',
      onSubmit: async v => { await Core.post('/service/tickets', v); toast('Created', 'Ticket logged', 'success'); Core.render(); }
    });
  });
};

Pages.openTicketDetail = async id => {
  const d = await Core.get('/service/tickets');
  const t = d.tickets.find(x => x.id === id);
  const users = (await Core.get('/service/assignees')).users;

  const m = Core.openModal({
    title: t.number + ' - ' + t.subject,
    wide: true,
    body: `
      <div class="meta-grid" style="margin-bottom:14px">
        <div class="meta-item"><span>Status</span><b>${Core.badge(t.status)}</b></div>
        <div class="meta-item"><span>Customer</span><b>${Core.esc(t.customerName)}</b></div>
        <div class="meta-item"><span>Assigned</span><b>${Core.esc(t.assignedName)}</b></div>
        <div class="meta-item"><span>SLA</span><b>${t.slaBreached ? 'BREACHED' : 'within SLA'}</b></div>
      </div>
      <div class="grid-even">
        <div>
          <p style="font-weight:700;font-size:12px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Work log</p>
          <ul class="timeline">${(t.workLog || []).map(w => `<li><b>${Core.esc(w.text)}</b><small>${Core.esc(w.by)} &middot; ${new Date(w.at).toLocaleString('en-IN')}</small></li>`).join('') || '<li>No entries yet.</li>'}</ul>
        </div>
        <div>
          <p style="font-weight:700;font-size:12px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Parts used</p>
          ${(t.partsUsed || []).length ? `<ul class="timeline">${t.partsUsed.map(p => `<li><b>${Core.esc(p.name)} x${p.qty}</b><small>${Core.esc(p.by)}</small></li>`).join('')}</ul>` : '<p class="muted" style="font-size:13px">None yet.</p>'}
          <form id="tl-actions" style="margin-top:10px">
            <label class="field"><span>Change status</span><select name="status">
              ${['open', 'assigned', 'in_progress', 'waiting_customer', 'waiting_parts', 'resolved', 'closed'].map(s => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select></label>
            <label class="field"><span>Note (goes to work log)</span><input name="note"></label>
            <button class="btn btn-dark btn-sm">Update status</button>
          </form>
          <form id="tl-part" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
            <p style="font-weight:700;font-size:12px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Consume part from stock</p>
            <label class="field"><span>Part</span><select name="productId" id="part-select"></select></label>
            <label class="field"><span>Warehouse</span><select name="warehouseId" id="part-warehouse"></select></label>
            <label class="field"><span>Quantity</span><input type="number" name="qty" min="1" value="1"></label>
            <button class="btn btn-outline btn-sm">Consume part</button>
          </form>
        </div>
      </div>`,
    footer: `<button class="btn btn-outline" data-cancel>Close</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;

  /* assign dropdown */
  const assignHtml = `<label class="field" style="margin-top:12px"><span>Assign engineer</span><select id="assign-select">
      <option value="">- choose -</option>
      ${users.map(u => `<option value="${u.id}" ${u.id === t.assignedTo ? 'selected' : ''}>${Core.esc(u.name)} (${Core.esc(u.role)})</option>`).join('')}
    </select></label>`;
  m.el.querySelector('#tl-actions').insertAdjacentHTML('beforebegin', assignHtml);
  m.el.querySelector('#assign-select').addEventListener('change', async e => {
    if (!e.target.value) return;
    try { await Core.post(`/service/tickets/${id}/assign`, { userId: e.target.value }); toast('Assigned', 'Engineer assigned', 'success'); m.close(); Pages.openTicketDetail(id); }
    catch (err) { toast('Failed', err.message, 'error'); }
  });

  m.el.querySelector('#tl-actions').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await Core.patch(`/service/tickets/${id}/status`, { status: fd.get('status'), note: fd.get('note') });
      toast('Updated', 'Ticket status changed', 'success');
      m.close(); Core.render();
    } catch (err) { toast('Failed', err.message, 'error'); }
  });

  Promise.all([Core.get('/inventory/products'), Core.get('/inventory/warehouses')]).then(([pd, wd]) => {
    const sel = m.el.querySelector('#part-select');
    sel.innerHTML = pd.products.filter(p => p.type !== 'service').map(p => `<option value="${p.id}">${Core.esc(p.name)} (stock ${p.balance})</option>`).join('');
    m.el.querySelector('#part-warehouse').innerHTML = wd.warehouses.map(warehouse => `<option value="${warehouse.id}">${Core.esc(warehouse.name)}</option>`).join('');
  });
  m.el.querySelector('#tl-part').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await Core.post(`/service/tickets/${id}/parts`, { productId: fd.get('productId'), warehouseId: fd.get('warehouseId'), qty: Number(fd.get('qty')) });
      toast('Part consumed', 'Stock deducted via ledger', 'success');
      m.close(); Pages.openTicketDetail(id);
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};

/* ================= FINANCE - ACCOUNTS ================= */
Core.route('finance/accounts', async () => {
  const d = await Core.get('/finance/accounts');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Chart of Accounts', 'Double-entry foundation for all postings',
      Core.can('finance', 'create') ? '<button class="btn btn-gold" onclick="Pages.openAccountForm()">+ New Account</button>' : '')}
    ${Core.table([
      { label: 'Code', render: a => `<b>${Core.esc(a.code)}</b>` },
      { label: 'Account name', key: 'name' },
      { label: 'Type', render: a => Core.badge(a.type === 'income' ? 'approved' : a.type === 'expense' ? 'pending' : 'info') + ' ' + a.type }
    ], d.accounts, { emptyTitle: 'No accounts' })}`;
});

Pages.openAccountForm = function () {
  Core.formModal({
    title: 'New account',
    fields: [
      { name: 'code', label: 'Code *', required: true, half: true },
      { name: 'name', label: 'Name *', required: true, half: true },
      { name: 'type', label: 'Type', type: 'select', options: ['asset', 'liability', 'income', 'expense', 'equity'].map(v => ({ value: v, label: v })) }
    ],
    submitLabel: 'Create account',
    onSubmit: async v => { await Core.post('/finance/accounts', v); toast('Created', 'Account added', 'success'); Core.render(); }
  });
};

/* ================= FINANCE - JOURNALS ================= */
Core.route('finance/journals', async () => {
  const d = await Core.get('/finance/journals');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Journal Entries', 'Auto-posted from invoices, receipts, GRNs and expenses - plus manual entries',
      Core.can('finance', 'create') ? '<button class="btn btn-gold" onclick="Pages.openJournalForm()">+ Manual Journal</button>' : '')}
    ${Core.table([
      { label: 'Entry', render: j => `<b>${Core.esc(j.number)}</b><br><small class="muted">${Core.esc(j.narration)}</small>` },
      { label: 'Date', render: j => Core.fmtDate(j.date) },
      { label: 'Source', render: j => Core.badge(j.refType || 'manual') },
      { label: 'Lines', render: j => j.lines.map(l =>
          `${Core.esc(l.accountName)} <b style="float:right">${l.debit ? 'Dr ' + Core.money(l.debit) : 'Cr ' + Core.money(l.credit)}</b>`).join('<br>') }
    ], d.journals.slice(0, 40), { emptyTitle: 'No journals yet' })}`;
});

Pages.openJournalForm = async () => {
  const ad = await Core.get('/finance/accounts');
  const m = Core.openModal({
    title: 'Manual journal entry (must balance)',
    wide: true,
    body: `<form id="jr-form">
      <label class="field"><span>Narration *</span><input name="narration" required></label>
      <div id="jr-lines">
        <div class="grid-2 jr-line" style="margin-bottom:8px;grid-template-columns:2fr 1fr 1fr auto">
          <select name="acc">${ad.accounts.map(a => `<option value="${a.id}">${Core.esc(a.code)} - ${Core.esc(a.name)}</option>`).join('')}</select>
          <input type="number" step="any" name="debit" placeholder="debit">
          <input type="number" step="any" name="credit" placeholder="credit">
          <button type="button" class="rm" onclick="this.closest('.jr-line').remove()">&times;</button>
        </div>
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="Pages.addJrLine()">+ Add line</button>
    </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="jr-form">Post journal</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#jr-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = [...m.el.querySelectorAll('.jr-line')].map(row => ({
      accountId: row.querySelector('select').value,
      debit: Number(row.querySelector('[name="debit"]').value) || 0,
      credit: Number(row.querySelector('[name="credit"]').value) || 0
    })).filter(l => l.debit > 0 || l.credit > 0);
    try {
      await Core.post('/finance/journals', { narration: fd.get('narration'), lines });
      toast('Posted', 'Balanced journal posted', 'success');
      m.close(); Core.render();
    } catch (err) { toast('Rejected', err.message, 'error'); }
  });
};
Pages.addJrLine = () => {
  const wrap = document.getElementById('jr-lines');
  if (!wrap) return;
  const clone = wrap.querySelector('.jr-line').cloneNode(true);
  clone.querySelectorAll('input').forEach(i => i.value = '');
  wrap.appendChild(clone);
};

/* ================= FINANCE - EXPENSES ================= */
Core.route('finance/expenses', async () => {
  const [expD, accD] = await Promise.all([Core.get('/finance/expenses'), Core.get('/finance/accounts')]);
  const canApprove = Core.can('finance', 'approve');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Expenses', 'Claims with approval flow; approval posts the accounting journal',
      '<button class="btn btn-gold" onclick="Pages.openExpenseForm()">+ New Expense</button>')}
    ${Core.table([
      { label: 'Expense', render: e => `<b>${Core.esc(e.number)}</b><br><small class="muted">${Core.esc(e.category)} &rarr; ${Core.esc(e.accountName)}</small>` },
      { label: 'Date', render: e => Core.fmtDate(e.date) },
      { label: 'Paid to', key: 'paidTo' },
      { label: 'Amount', num: true, render: e => Core.money(e.amount) },
      { label: 'Mode', render: e => Core.badge(e.paymentMode === 'bank' ? 'confirmed' : e.paymentMode) },
      { label: 'Requested by', key: 'requestedByName' },
      { label: 'Status', render: e => Core.badge(e.status) },
      { label: '', render: e => canApprove && e.status === 'pending' ? `<div class="actions-cell">
          <button class="btn btn-outline btn-sm" onclick="Pages.approveExpense('${e.id}',true)">Approve</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.approveExpense('${e.id}',false)">Reject</button></div>` : '' }
    ], expD.expenses, { emptyTitle: 'No expenses' })}`;
});

Pages.approveExpense = async (id, approve) => {
  try {
    await Core.post(`/finance/expenses/${id}/approve`, { decision: approve ? 'approved' : 'rejected' });
    toast(approve ? 'Approved' : 'Rejected', approve ? 'Journal posted automatically' : 'Expense rejected', approve ? 'success' : 'warning');
    Core.render();
  } catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.openExpenseForm = function () {
  Core.get('/finance/accounts').then(ad => {
    Core.formModal({
      title: 'New expense claim',
      fields: [
        { name: 'accountHeadId', label: 'Expense head *', type: 'select', required: true,
          options: ad.accounts.filter(a => a.type === 'expense').map(a => ({ value: a.id, label: `${a.code} - ${a.name}` })) },
        { name: 'amount', label: 'Amount *', type: 'number', step: '0.01', required: true, half: true },
        { name: 'paymentMode', label: 'Paid via', type: 'select', half: true, options: ['cash', 'bank', 'upi', 'card'].map(v => ({ value: v, label: v.toUpperCase() })) },
        { name: 'paidTo', label: 'Paid to', half: true },
        { name: 'date', label: 'Date', type: 'date', half: true },
        { name: 'note', label: 'Note' }
      ],
      submitLabel: 'Submit expense',
      onSubmit: async v => { await Core.post('/finance/expenses', v); toast('Submitted', 'Expense pending approval', 'success'); Core.render(); }
    });
  });
};

/* ================= FINANCE - P&L ================= */
Core.route('finance/pnl', async () => {
  const d = await Core.get('/finance/pnl');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Profit & Loss', 'Derived from posted journal lines')}
    <div class="grid-kpi">
      ${Core.kpi('Total Income', Core.moneyShort(d.totals.income), '', 'k-success')}
      ${Core.kpi('Total Expense', Core.moneyShort(d.totals.expense), '', 'k-danger')}
      ${Core.kpi(d.totals.profit >= 0 ? 'Net Profit' : 'Net Loss', Core.moneyShort(Math.abs(d.totals.profit)), '', d.totals.profit >= 0 ? 'k-gold' : 'k-danger')}
    </div>
    <div class="grid-even">
      <div class="card"><div class="card-head"><h3>Income</h3></div>
        ${Core.table([{ label: 'Account', key: 'name' }, { label: 'Amount', num: true, render: r => Core.money(r.amount) }], d.income, { emptyTitle: 'No income posted' })}
      </div>
      <div class="card"><div class="card-head"><h3>Expenses</h3></div>
        ${Core.table([{ label: 'Account', key: 'name' }, { label: 'Amount', num: true, render: r => Core.money(r.amount) }], d.expense, { emptyTitle: 'No expenses posted' })}
      </div>
    </div>`;
});

/* ================= HR ================= */
Core.route('hr/employees', async () => {
  const d = await Core.get('/admin/employees');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Employees', 'Team directory',
      Core.can('hr', 'create') ? '<button class="btn btn-gold" onclick="Pages.openEmployeeForm()">+ New Employee</button>' : '')}
    ${Core.table([
      { label: 'Emp code', render: e => `<b>${Core.esc(e.empCode)}</b>` },
      { label: 'Name', key: 'name' },
      { label: 'Department', key: 'department' },
      { label: 'Designation', key: 'designation' },
      { label: 'Contact', render: e => `${Core.esc(e.email || '-')}<br><small class="muted">${Core.esc(e.phone || '')}</small>` },
      { label: 'Joined', render: e => Core.fmtDate(e.joinDate) },
      { label: 'Status', render: e => Core.badge(e.status) }
    ], d.employees, { emptyTitle: 'No employees' })}`;
});

Pages.openEmployeeForm = function () {
  Core.formModal({
    title: 'New employee',
    fields: [
      { name: 'name', label: 'Full name *', required: true, half: true },
      { name: 'empCode', label: 'Employee code', half: true },
      { name: 'department', label: 'Department', half: true },
      { name: 'designation', label: 'Designation', half: true },
      { name: 'email', label: 'Email', type: 'email', half: true },
      { name: 'phone', label: 'Phone', half: true },
      { name: 'joinDate', label: 'Join date', type: 'date', half: true }
    ],
    submitLabel: 'Add employee',
    onSubmit: async v => { await Core.post('/admin/employees', v); toast('Added', 'Employee created', 'success'); Core.render(); }
  });
};

Core.route('hr/leaves', async () => {
  const d = await Core.get('/admin/leaves');
  const canApprove = Core.can('hr', 'approve');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Leave Requests', 'Approvals update instantly')}
    ${Core.table([
      { label: 'Employee', key: 'employeeName' },
      { label: 'Type', render: l => Core.badge(l.type === 'sick' ? 'urgent' : 'info') + ' ' + l.type },
      { label: 'From', render: l => Core.fmtDate(l.fromDate) },
      { label: 'To', render: l => Core.fmtDate(l.toDate) },
      { label: 'Days', num: true, key: 'days' },
      { label: 'Reason', key: 'reason' },
      { label: 'Status', render: l => Core.badge(l.status) },
      { label: '', render: l => canApprove && l.status === 'pending' ? `<div class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="Pages.decideLeave('${l.id}',true)">Approve</button>
        <button class="btn btn-ghost btn-sm" onclick="Pages.decideLeave('${l.id}',false)">Reject</button></div>` : '' }
    ], d.leaves, { emptyTitle: 'No leave requests' })}`;
});

Pages.decideLeave = async (id, approve) => {
  try {
    await Core.post(`/admin/leaves/${id}/approve`, { decision: approve ? 'approved' : 'rejected' });
    toast(approve ? 'Approved' : 'Rejected', 'Leave updated', approve ? 'success' : 'warning');
    Core.render();
  } catch (e) { toast('Failed', e.message, 'error'); }
};

/* ================= REPORTS ================= */
Core.route('reports/sales', async () => {
  const d = await Core.get('/reports/sales-by-month');
  const rows = d.rows.map(r => ({ ...r, fmt: Core.moneyShort(r.invoiced) }));
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Sales Report', 'Invoiced vs collected - last 12 months')}
    <div class="card"><div class="card-head"><h3>Monthly invoicing & collection</h3>
      <div class="legend"><span><i style="background:linear-gradient(180deg,var(--gold),#9c7c1e)"></i>Invoiced</span>
      <span><i style="background:#0a0a0a"></i>Collected</span></div></div>
      <div class="card-pad">${Core.barChart(rows, 'invoiced', 'month')}</div>
    </div>
    <div style="margin-top:16px">
    ${Core.table([
      { label: 'Month', key: 'month' },
      { label: 'Invoiced', num: true, render: r => Core.money(r.invoiced) },
      { label: 'Collected', num: true, render: r => Core.money(r.collected) },
      { label: 'Gap', num: true, render: r => Core.money(Math.round((r.invoiced - r.collected) * 100) / 100) }
    ], d.rows)}
    </div>`;
});

Core.route('reports/receivables', async () => {
  const d = await Core.get('/reports/receivable-aging');
  const total = Object.values(d.buckets).reduce((s, v) => s + v, 0);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Receivable Aging', 'Outstanding customer balances by bucket')}
    <div class="grid-kpi">
      ${Core.kpi('Current', Core.moneyShort(d.buckets.current))}
      ${Core.kpi('1-30 days', Core.moneyShort(d.buckets.d30), '', d.buckets.d30 ? 'k-warning' : '')}
      ${Core.kpi('31-60 days', Core.moneyShort(d.buckets.d60), '', d.buckets.d60 ? 'k-warning' : '')}
      ${Core.kpi('61-90 days', Core.moneyShort(d.buckets.d90), '', d.buckets.d90 ? 'k-danger' : '')}
      ${Core.kpi('90+ days', Core.moneyShort(d.buckets.d90plus), '', d.buckets.d90plus ? 'k-danger' : '')}
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="funnel-row"><span>Total outstanding</span>
        <div class="funnel-track"><div class="funnel-fill" style="width:100%"></div></div>
        <b>${Core.moneyShort(total)}</b></div>
    </div>
    ${Core.table([
      { label: 'Invoice', key: 'number' },
      { label: 'Customer', key: 'customerName' },
      { label: 'Due date', render: r => Core.fmtDate(r.dueDate) },
      { label: 'Days late', num: true, key: 'daysLate' },
      { label: 'Balance', num: true, render: r => Core.money(r.balance) }
    ], d.overdueDetails, { emptyTitle: 'Nothing overdue', emptyIcon: '&#9989;', emptyText: 'All invoices are within terms.' })}`;
});

Core.route('reports/stock', async () => {
  const d = await Core.get('/reports/stock-valuation');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Stock Valuation', 'Closing stock valued at purchase cost')}
    <div class="grid-kpi">${Core.kpi('Total Inventory Value', Core.moneyShort(d.totalValue), d.rows.length + ' stocked items', 'k-gold')}</div>
    ${Core.table([
      { label: 'SKU', key: 'sku' },
      { label: 'Product', key: 'name' },
      { label: 'Qty', num: true, render: r => `${r.qty} ${Core.esc(r.uom)}` },
      { label: 'Unit cost', num: true, render: r => Core.money(r.unitCost) },
      { label: 'Value', num: true, render: r => Core.money(r.value) }
    ], d.rows, { emptyTitle: 'No stock on hand' })}`;
});

Core.route('reports/funnel', async () => {
  const d = await Core.get('/reports/lead-funnel');
  const max = Math.max(...Object.values(d.counts), 1);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Lead Funnel & Conversion', 'Where enquiries come from and how they convert')}
    <div class="grid-kpi">
      ${Core.kpi('Conversion Rate', d.conversionRate + '%', 'of closed leads won', 'k-gold')}
      ${Core.kpi('Converted', d.counts.converted)}
      ${Core.kpi('Lost', d.counts.lost)}
    </div>
    <div class="grid-even">
      <div class="card"><div class="card-head"><h3>By stage</h3></div><div class="card-pad">
        ${Object.entries(d.counts).map(([s, n]) => `
          <div class="funnel-row"><span style="text-transform:capitalize">${s}</span>
            <div class="funnel-track"><div class="funnel-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
            <b>${n}</b></div>`).join('')}
      </div></div>
      <div class="card"><div class="card-head"><h3>By source</h3></div>
        ${Core.table([{ label: 'Source', key: '0' }, { label: 'Leads', num: true, key: '1' }],
          Object.entries(d.bySource), { emptyTitle: 'No leads' })}
      </div>
    </div>`;
});

Core.route('reports/service', async () => {
  const d = await Core.get('/reports/ticket-summary');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Service Summary', 'Ticket load and SLA performance')}
    <div class="grid-kpi">
      ${Core.kpi('Total Tickets', d.total)}
      ${Core.kpi('Open / Active', (d.byStatus.open || 0) + (d.byStatus.assigned || 0) + (d.byStatus.in_progress || 0))}
      ${Core.kpi('SLA Breached (live)', d.breached, '', d.breached ? 'k-danger' : 'k-success')}
      ${Core.kpi('SLA Compliance', d.slaCompliance == null ? '-' : d.slaCompliance + '%', 'resolved within SLA', 'k-gold')}
    </div>
    ${Core.table([
      { label: 'Status', render: r => Core.badge(r[0]) },
      { label: 'Count', num: true, key: '1' }
    ], Object.entries(d.byStatus), { emptyTitle: 'No tickets yet' })}`;
});

/* ================= ADMIN - USERS ================= */
Core.route('admin/platform', async () => {
  if (Core.state.user.role !== 'super_admin') throw new Error('Super Admin access required');
  const [data, global] = await Promise.all([
    Core.get('/admin/organizations'),
    Core.get('/admin/global/users')
  ]);
  Core.state.organizations = data.organizations || [];
  Pages._globalControl = global;
  const totals = data.organizations.reduce((sum, org) => {
    for (const [key, value] of Object.entries(org.counts || {})) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Platform Control', 'Every organization, every account and every user dashboard in one live control centre',
      '<div class="actions-cell"><button class="btn btn-outline" onclick="Core.openOrganizationSwitcher()">Switch Organization</button><button class="btn btn-gold" onclick="Pages.openGlobalUserForm()">+ Add Account</button></div>')}
    <div class="super-admin-banner">
      <img src="/assets/tech-defenders-logo.webp" alt="Tech Defenders logo">
      <div><span class="eyebrow">PLATFORM OWNER ACCESS</span><h2>All organizations. One protected control plane.</h2>
      <p>You are currently managing <b>${Core.esc(Core.state.org.name)}</b>. Open another organization to view and manage its complete business data.</p></div>
      <span class="super-shield">&#9733;</span>
    </div>
    <div class="grid-kpi">
      ${Core.kpi('Organizations', data.organizations.length, 'available workspaces', 'k-gold')}
      ${Core.kpi('Active Accounts', global.users.filter(user => user.active).length, global.users.length + ' total accounts')}
      ${Core.kpi('Customers', totals.customers || 0, 'all organizations')}
      ${Core.kpi('Invoices', totals.invoices || 0, 'all organizations')}
      ${Core.kpi('Products', totals.products || 0, 'all organizations')}
      ${Core.kpi('Service Tickets', totals.tickets || 0, 'all organizations')}
    </div>
    <div class="section-title"><div><h2>Organizations</h2><p>Open a workspace to see its complete CRM/ERP data.</p></div></div>
    <div class="org-grid">
      ${data.organizations.map(org => `<article class="card org-card ${org.id === data.activeOrgId ? 'active' : ''}">
        <div class="org-card-head"><div><span class="eyebrow">ORGANIZATION</span><h3>${Core.esc(org.name)}</h3></div>
          <span class="badge ${org.id === data.activeOrgId ? 'b-gold' : 'b-neutral'}">${org.id === data.activeOrgId ? 'Active' : 'Available'}</span></div>
        <p>${Core.esc(org.legalName || '')}</p>
        <div class="org-stats"><span><b>${org.counts.users}</b> users</span><span><b>${org.counts.customers}</b> customers</span><span><b>${org.counts.invoices}</b> invoices</span></div>
        <button class="btn ${org.id === data.activeOrgId ? 'btn-outline' : 'btn-dark'} btn-block" onclick="Pages.openOrganization('${org.id}')" ${org.id === data.activeOrgId ? 'disabled' : ''}>
          ${org.id === data.activeOrgId ? 'Currently Open' : 'Open Complete Data'}
        </button>
      </article>`).join('')}
    </div>
    <div class="section-title platform-account-head"><div><h2>All Accounts</h2><p>New registrations appear here automatically, even when they belong to another organization.</p></div><span class="badge b-gold" id="global-account-count">${global.users.length} live accounts</span></div>
    <div class="filter-bar platform-filters">
      <input id="global-account-q" placeholder="Search name, email or organization..." oninput="Pages.filterGlobalAccounts()">
      <select id="global-account-org" onchange="Pages.filterGlobalAccounts()"><option value="">All organizations</option>${global.organizations.map(org => `<option value="${org.id}">${Core.esc(org.name)}</option>`).join('')}</select>
      <select id="global-account-status" onchange="Pages.filterGlobalAccounts()"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      <button class="btn btn-outline btn-sm" onclick="Pages.refreshGlobalAccounts(false)">Refresh Now</button>
    </div>
    <div id="global-account-table">${Pages.globalAccountsTable(global.users)}</div>`;
  Pages.startGlobalControlPolling();
});

Pages.openOrganization = async orgId => {
  try {
    await Core.post('/admin/switch-organization', { orgId });
    location.hash = '#/dashboard';
    location.reload();
  } catch (error) { toast('Organization not opened', error.message, 'error'); }
};

Pages.globalAccountsTable = users => Core.table([
  { label: 'Account', render: user => `<b>${Core.esc(user.name)}</b><br><small class="muted">${Core.esc(user.email)}</small>` },
  { label: 'Organization', render: user => `<b>${Core.esc(user.organization?.name || 'Unknown')}</b><br><small class="muted">${Core.esc(user.organization?.legalName || '')}</small>` },
  { label: 'Role', render: user => `<span class="role-pill ${user.role === 'super_admin' ? 'role-super' : user.role === 'admin' ? 'role-admin' : ''}">${Core.esc(Core.roleLabel(user.role))}</span>` },
  { label: 'Access', render: user => {
    const modulesOn = Object.values(user.effectiveAccess || {}).filter(Boolean).length;
    const widgetsOn = Object.values(user.effectiveDashboardWidgets || {}).filter(Boolean).length;
    return `<span class="access-summary"><b>${modulesOn}</b> modules<br><small>${widgetsOn} dashboard widgets</small></span>`;
  } },
  { label: 'Status', render: user => user.active ? '<span class="badge b-success">Active</span>' : '<span class="badge b-danger">Inactive</span>' },
  { label: 'Last login', render: user => user.lastLoginAt ? Core.fmtDate(user.lastLoginAt) : 'never' },
  { label: '', render: user => user.role === 'super_admin' ? '<span class="protected-label">Platform protected</span>' : `<div class="actions-cell global-actions">
      <button class="btn btn-outline btn-sm" onclick="Pages.openOrganization('${user.orgId}')">Open Data</button>
      <button class="btn btn-dark btn-sm" onclick="Pages.manageGlobalDashboard('${user.id}')">Dashboard</button>
      <button class="btn btn-ghost btn-sm" onclick="Pages.editGlobalUser('${user.id}')">Role</button>
      <button class="btn btn-ghost btn-sm" onclick="Pages.changeGlobalPassword('${user.id}')">Password</button>
      <button class="btn btn-ghost btn-sm" onclick="Pages.toggleGlobalUser('${user.id}',${!user.active})">${user.active ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-ghost btn-sm danger-text" onclick="Pages.deleteGlobalUser('${user.id}')">Delete</button>
    </div>` }
], users, { emptyTitle: 'No accounts match these filters', emptyText: 'Try another search or organization.' });

Pages.filterGlobalAccounts = () => {
  const data = Pages._globalControl;
  if (!data) return;
  const query = String(document.getElementById('global-account-q')?.value || '').trim().toLowerCase();
  const orgId = document.getElementById('global-account-org')?.value || '';
  const status = document.getElementById('global-account-status')?.value || '';
  const filtered = data.users.filter(user => {
    const haystack = [user.name, user.email, user.role, user.organization?.name].join(' ').toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (orgId && user.orgId !== orgId) return false;
    if (status === 'active' && !user.active) return false;
    if (status === 'inactive' && user.active) return false;
    return true;
  });
  const host = document.getElementById('global-account-table');
  if (host) host.innerHTML = Pages.globalAccountsTable(filtered);
};

Pages.refreshGlobalAccounts = async silent => {
  try {
    const latest = await Core.get('/admin/global/users');
    Pages._globalControl = latest;
    Core.state.organizations = latest.organizations;
    const count = document.getElementById('global-account-count');
    if (count) count.textContent = latest.users.length + ' live accounts';
    const orgSelect = document.getElementById('global-account-org');
    if (orgSelect) {
      const selected = orgSelect.value;
      orgSelect.innerHTML = '<option value="">All organizations</option>' + latest.organizations.map(org => `<option value="${org.id}">${Core.esc(org.name)}</option>`).join('');
      if (latest.organizations.some(org => org.id === selected)) orgSelect.value = selected;
    }
    Pages.filterGlobalAccounts();
    if (!silent) toast('Accounts refreshed', 'Latest registrations and access policies are now visible', 'success');
  } catch (error) { if (!silent) toast('Refresh failed', error.message, 'error'); }
};

Pages.startGlobalControlPolling = () => {
  if (Pages._globalControlTimer) clearInterval(Pages._globalControlTimer);
  Pages._globalControlTimer = setInterval(() => {
    if (location.hash !== '#/admin/platform') { clearInterval(Pages._globalControlTimer); Pages._globalControlTimer = null; return; }
    Pages.refreshGlobalAccounts(true);
  }, 8000);
};

Pages.openGlobalUserForm = () => {
  const data = Pages._globalControl;
  if (!data) return;
  Core.formModal({
    title: 'Create account in any organization',
    fields: [
      { name: 'orgId', label: 'Organization *', type: 'select', required: true, options: data.organizations.map(org => ({ value: org.id, label: org.name })) },
      { name: 'name', label: 'Full name *', required: true, half: true },
      { name: 'email', label: 'Work email *', type: 'email', required: true, half: true },
      { name: 'role', label: 'Role *', type: 'select', required: true, options: data.roles.map(role => ({ value: role, label: Core.roleLabel(role) })) },
      { name: 'phone', label: 'Phone', half: true }
    ],
    submitLabel: 'Create account',
    onSubmit: async values => {
      const result = await Core.post('/admin/global/users', values);
      Core.openModal({
        title: 'Account created',
        body: `<p>Temporary password for <b>${Core.esc(values.email)}</b>:</p><code class="credential-code">${Core.esc(result.tempPassword)}</code><p class="fine muted" style="margin-top:10px">It is shown once. The user must change it after signing in.</p>`,
        footer: '<button class="btn btn-gold" data-cancel>Done</button>'
      });
      Core.render();
    }
  });
};

Pages.editGlobalUser = id => {
  const user = Pages._globalControl?.users.find(item => item.id === id);
  if (!user) return;
  Core.formModal({
    title: 'Edit global account',
    fields: [
      { name: 'name', label: 'Full name *', required: true, half: true, value: user.name },
      { name: 'phone', label: 'Phone', half: true, value: user.phone || '' },
      { name: 'role', label: 'Role *', type: 'select', required: true, value: user.role, options: Pages._globalControl.roles.map(role => ({ value: role, label: Core.roleLabel(role) })) }
    ],
    submitLabel: 'Save account',
    onSubmit: async values => {
      await Core.patch('/admin/global/users/' + id, values);
      toast('Account updated', user.name + ' was updated', 'success');
      Core.render();
    }
  });
};

Pages.toggleGlobalUser = async (id, activate) => {
  try {
    await Core.patch('/admin/global/users/' + id, { active: activate });
    toast('Account updated', activate ? 'Access enabled' : 'Access disabled and sessions revoked', activate ? 'success' : 'warning');
    Core.render();
  } catch (error) { toast('Account not updated', error.message, 'error'); }
};

Pages.changeGlobalPassword = id => {
  const user = Pages._globalControl?.users.find(item => item.id === id);
  if (!user) return;
  const modal = Core.openModal({
    title: 'Change password · ' + user.name,
    body: `<p class="muted" style="margin-bottom:14px">This works across organizations. Existing sessions will be revoked.</p>
      <form id="global-password-form" class="grid-2">
        <label class="field"><span>New password</span><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="field"><span>Confirm password</span><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="check" style="grid-column:1/-1"><input name="mustChangePassword" type="checkbox" checked> Require password change after next login</label>
      </form>`,
    footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="global-password-form">Change Password</button>'
  });
  modal.el.querySelector('#global-password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    if (values.get('newPassword') !== values.get('confirmPassword')) return toast('Check password', 'Passwords do not match', 'error');
    try {
      await Core.patch('/admin/global/users/' + id + '/password', { newPassword: values.get('newPassword'), mustChangePassword: values.get('mustChangePassword') === 'on' });
      modal.close();
      toast('Password changed', 'All older sessions were revoked', 'success');
    } catch (error) { toast('Password not changed', error.message, 'error'); }
  });
};

Pages.deleteGlobalUser = async id => {
  const user = Pages._globalControl?.users.find(item => item.id === id);
  if (!user) return;
  const ok = await Core.confirm(`Delete ${user.name} from ${user.organization?.name || 'this organization'}? The account will be anonymized and all sessions revoked.`, 'Delete global account');
  if (!ok) return;
  try {
    await Core.del('/admin/global/users/' + id);
    toast('Account deleted', 'The account was anonymized and access was revoked', 'success');
    Core.render();
  } catch (error) { toast('Delete failed', error.message, 'error'); }
};

Pages.manageGlobalDashboard = async id => {
  try {
    const preview = await Core.get('/admin/global/users/' + id + '/dashboard-preview');
    Pages._globalDashboard = { id, preview };
    const user = preview.user;
    const modal = Core.openModal({
      title: 'Dashboard Control · ' + user.name,
      wide: true,
      className: 'dashboard-control-modal',
      body: `<div class="dashboard-user-strip">
          <div class="avatar">${Core.esc(user.name.split(' ').map(word => word[0]).slice(0, 2).join('').toUpperCase())}</div>
          <div><b>${Core.esc(user.name)}</b><small>${Core.esc(user.email)} · ${Core.esc(preview.organization?.name || '')}</small></div>
          <span class="role-pill ${user.role === 'admin' ? 'role-admin' : ''}">${Core.esc(Core.roleLabel(user.role))}</span>
        </div>
        <div class="dashboard-control-grid">
          <section><div class="policy-head"><div><h3>Module & Menu Access</h3><p>Controls sidebar, pages, search and API access.</p></div><span class="badge b-gold">11 sections</span></div><div id="global-module-policies" class="policy-list"></div>
          <div class="policy-head widget-head"><div><h3>Dashboard Widgets</h3><p>Controls the cards, charts and lists on this user's dashboard.</p></div><span class="badge b-info">10 widgets</span></div><div id="global-widget-policies" class="policy-list"></div></section>
          <aside><div class="policy-head"><div><h3>Live User Preview</h3><p>Exactly what this account can see after refresh.</p></div><span class="live-dot">LIVE</span></div><div id="global-dashboard-preview" class="dashboard-preview"></div></aside>
        </div>`,
      footer: `<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-dark" id="open-controlled-org">Open ${Core.esc(preview.organization?.name || 'Organization')} Data</button>`
    });
    Pages._globalDashboard.modal = modal;
    modal.el.querySelector('#open-controlled-org').onclick = () => Pages.openOrganization(user.orgId);
    Pages.renderGlobalDashboardControl();
  } catch (error) { toast('Dashboard control unavailable', error.message, 'error'); }
};

Pages.renderGlobalDashboardControl = () => {
  const state = Pages._globalDashboard;
  if (!state?.modal?.el) return;
  const user = state.preview.user;
  const data = Pages._globalControl;
  const moduleHost = state.modal.el.querySelector('#global-module-policies');
  const widgetHost = state.modal.el.querySelector('#global-widget-policies');
  const previewHost = state.modal.el.querySelector('#global-dashboard-preview');
  moduleHost.innerHTML = data.modules.map(module => {
    const checked = user.effectiveAccess[module.key] === true;
    return `<div class="policy-row"><div><b>${Core.esc(module.label)}</b><small>${Core.esc(module.description)}</small></div><span class="access-state">${checked ? 'On' : 'Off'}</span><label class="ios-switch"><input type="checkbox" data-global-module="${module.key}" ${checked ? 'checked' : ''} aria-label="${Core.esc(module.label)} for ${Core.esc(user.name)}"><span class="ios-track"></span></label></div>`;
  }).join('');
  widgetHost.innerHTML = data.dashboardWidgets.map(widget => {
    const checked = user.effectiveDashboardWidgets[widget.key] === true;
    const prerequisite = user.effectiveAccess.dashboard === true && user.effectiveAccess[widget.requiredModule] === true;
    return `<div class="policy-row ${prerequisite ? '' : 'policy-disabled'}"><div><b>${Core.esc(widget.label)}</b><small>${Core.esc(widget.description)}${prerequisite ? '' : ' · enable ' + Core.roleLabel(widget.requiredModule) + ' first'}</small></div><span class="access-state">${checked ? 'On' : 'Off'}</span><label class="ios-switch"><input type="checkbox" data-global-widget="${widget.key}" ${checked ? 'checked' : ''} ${prerequisite ? '' : 'disabled'} aria-label="${Core.esc(widget.label)} for ${Core.esc(user.name)}"><span class="ios-track"></span></label></div>`;
  }).join('');
  previewHost.innerHTML = `<div class="preview-shell"><div class="preview-top"><span>Dashboard</span><b>${Core.esc(user.name.split(' ')[0])}</b></div><div class="preview-grid">${state.preview.widgets.map(widget => `<div class="preview-widget ${widget.enabled ? '' : 'preview-off'}"><span>${Core.esc(widget.label)}</span><b>${widget.format === 'money' ? Core.moneyShort(widget.primary) : Core.esc(widget.primary)}</b><small>${Core.esc(widget.enabled ? widget.secondary : 'Hidden by Super Admin')}</small></div>`).join('')}</div></div>`;
  moduleHost.querySelectorAll('[data-global-module]').forEach(input => input.addEventListener('change', () => Pages.setGlobalPolicy(input, 'module')));
  widgetHost.querySelectorAll('[data-global-widget]').forEach(input => input.addEventListener('change', () => Pages.setGlobalPolicy(input, 'widget')));
};

Pages.setGlobalPolicy = async (input, type) => {
  const state = Pages._globalDashboard;
  const user = state.preview.user;
  const desired = input.checked;
  input.disabled = true;
  try {
    const body = type === 'module'
      ? { moduleAccess: { ...(user.moduleAccess || {}), [input.dataset.globalModule]: desired } }
      : { dashboardWidgets: { ...(user.dashboardWidgets || {}), [input.dataset.globalWidget]: desired } };
    await Core.patch('/admin/global/users/' + state.id + '/access', body);
    state.preview = await Core.get('/admin/global/users/' + state.id + '/dashboard-preview');
    const cachedIndex = Pages._globalControl.users.findIndex(item => item.id === state.id);
    if (cachedIndex >= 0) Pages._globalControl.users[cachedIndex] = state.preview.user;
    Pages.filterGlobalAccounts();
    Pages.renderGlobalDashboardControl();
    toast('Dashboard updated', (type === 'module' ? 'Module' : 'Widget') + ' is now ' + (desired ? 'visible' : 'hidden'), 'success');
  } catch (error) {
    input.checked = !desired;
    input.disabled = false;
    toast('Dashboard not updated', error.message, 'error');
  }
};

Core.route('admin/users', async () => {
  const d = await Core.get('/admin/users');
  Pages._adminUsers = d.users;
  Pages._adminRoles = d.roles;
  const canEdit = Core.can('admin', 'edit');
  const canDelete = Core.can('admin', 'delete');
  const actorIsSuperAdmin = Core.state.user.role === 'super_admin';
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Users & Roles', `${Core.esc(Core.state.org.name)} · role and password controls are enforced on every API call`,
      Core.can('admin', 'create') ? '<button class="btn btn-gold" onclick="Pages.openUserForm()">+ Add User</button>' : '')}
    ${Core.table([
      { label: 'User', render: u => `<b>${Core.esc(u.name)}</b><br><small class="muted">${Core.esc(u.email)}</small>` },
      { label: 'Role', render: u => `<span class="role-pill ${u.role === 'super_admin' ? 'role-super' : u.role === 'admin' ? 'role-admin' : ''}">${Core.esc(Core.roleLabel(u.role))}</span>` },
      { label: 'Active', render: u => u.active ? '<span class="badge b-success">yes</span>' : '<span class="badge b-danger">no</span>' },
      { label: 'Last login', render: u => u.lastLoginAt ? Core.fmtDate(u.lastLoginAt) : 'never' },
      { label: '', render: u => {
        const protectedTarget = u.role === 'super_admin' || (u.role === 'admin' && !actorIsSuperAdmin);
        return canEdit && u.id !== Core.state.user.id && !protectedTarget ? `<div class="actions-cell">
          <button class="btn btn-outline btn-sm" onclick="Pages.editUser('${u.id}')">Edit Role</button>
          <button class="btn btn-outline btn-sm" onclick="Pages.toggleUser('${u.id}',${!u.active})">${u.active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.changeUserPassword('${u.id}')">Change PW</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.resetUserPw('${u.id}')">Temp PW</button>
          ${canDelete ? `<button class="btn btn-ghost btn-sm" onclick="Pages.deleteUser('${u.id}')">Delete</button>` : ''}
        </div>` : `<span class="protected-label">${u.id === Core.state.user.id ? 'Current account' : 'Protected'}</span>`;
      } }
    ], d.users, { emptyTitle: 'No users' })}`;
});

Pages.openUserForm = function () {
  Core.get('/admin/users').then(d => {
    Core.formModal({
      title: 'Add team member',
      fields: [
        { name: 'name', label: 'Full name *', required: true, half: true },
        { name: 'email', label: 'Work email *', type: 'email', required: true, half: true },
        { name: 'role', label: 'Role *', type: 'select', required: true,
          options: d.roles.map(r => ({ value: r, label: r.replace('_', ' ') })) },
        { name: 'phone', label: 'Phone', half: true }
      ],
      submitLabel: 'Create user',
      onSubmit: async v => {
        const r = await Core.post('/admin/users', v);
        Core.openModal({
          title: 'User created - share temp password',
          body: `<p style="font-size:14px">One-time temporary password for <b>${Core.esc(v.email)}</b>:</p>
            <code style="display:block;background:#faf7ec;padding:12px;border-radius:8px;font-size:16px;font-weight:700;margin-top:10px">${Core.esc(r.tempPassword)}</code>
            <p class="fine muted" style="margin-top:10px">Share it securely. The user should change it after first sign-in.</p>`,
          footer: '<button class="btn btn-gold" data-cancel>Done</button>'
        });
        Core.render();
      }
    });
  });
};

Pages.toggleUser = async (id, activate) => {
  try {
    await Core.patch('/admin/users/' + id, { active: activate });
    toast('Updated', 'User ' + (activate ? 'activated' : 'deactivated'), activate ? 'success' : 'warning');
    Core.render();
  } catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.resetUserPw = async id => {
  const ok = await Core.confirm('Generate a new temporary password? All existing sessions will be revoked.', 'Reset password');
  if (!ok) return;
  try {
    const r = await Core.patch('/admin/users/' + id, { resetPassword: true });
    Core.openModal({
      title: 'New temporary password',
      body: `<code style="display:block;background:#faf7ec;padding:12px;border-radius:8px;font-size:16px;font-weight:700">${Core.esc(r.tempPassword)}</code>
        <p class="fine muted" style="margin-top:10px">Share securely - it will not be shown again.</p>`,
      footer: '<button class="btn btn-gold" data-cancel>Done</button>'
    });
  } catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.editUser = id => {
  const user = Pages._adminUsers?.find(item => item.id === id);
  if (!user) return;
  Core.formModal({
    title: 'Edit user and role',
    fields: [
      { name: 'name', label: 'Full name *', required: true, half: true, value: user.name },
      { name: 'phone', label: 'Phone', half: true, value: user.phone || '' },
      { name: 'role', label: 'Role *', type: 'select', required: true, value: user.role,
        options: Pages._adminRoles.map(role => ({ value: role, label: Core.roleLabel(role) })) }
    ],
    submitLabel: 'Save user',
    onSubmit: async values => {
      await Core.patch('/admin/users/' + id, values);
      toast('User updated', `${user.name}'s role and profile were updated`, 'success');
      Core.render();
    }
  });
};

Pages.changeUserPassword = id => {
  const user = Pages._adminUsers?.find(item => item.id === id);
  if (!user) return;
  const modal = Core.openModal({
    title: `Change password · ${Core.esc(user.name)}`,
    body: `<p class="muted" style="margin-bottom:14px">The new password is never displayed or stored as plain text. All existing sessions will be revoked.</p>
      <form id="admin-password-form" class="grid-2">
        <label class="field"><span>New password</span><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="field"><span>Confirm password</span><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="check" style="grid-column:1/-1"><input name="mustChangePassword" type="checkbox" checked> Require password change after next login</label>
      </form>`,
    footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="admin-password-form">Change Password</button>'
  });
  modal.el.querySelector('#admin-password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    if (values.get('newPassword') !== values.get('confirmPassword')) return toast('Check password', 'Passwords do not match', 'error');
    try {
      await Core.patch('/admin/users/' + id + '/password', {
        newPassword: values.get('newPassword'),
        mustChangePassword: values.get('mustChangePassword') === 'on'
      });
      modal.close();
      toast('Password changed', 'Existing sessions were revoked', 'success');
    } catch (error) { toast('Password not changed', error.message, 'error'); }
  });
};

Pages.deleteUser = async id => {
  const name = Pages._adminUsers?.find(user => user.id === id)?.name || 'this user';
  const ok = await Core.confirm(`Delete ${name}? The account will be anonymized and all sessions revoked.`, 'Delete user');
  if (!ok) return;
  try {
    await Core.del('/admin/users/' + id);
    toast('User deleted', 'The account was anonymized and access revoked', 'success');
    Core.render();
  } catch (error) { toast('Delete failed', error.message, 'error'); }
};

/* ================= ADMIN - SETTINGS ================= */
Core.route('admin/settings', async () => {
  const org = Core.state.org;
  const accessData = await Core.get('/admin/access-control');
  Pages._accessData = accessData;
  Pages._accessUserId = Pages._accessUserId && accessData.users.some(user => user.id === Pages._accessUserId)
    ? Pages._accessUserId : accessData.users[0]?.id;
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Company Settings', 'Organization profile, security and per-user section visibility')}
    <div class="card card-pad" style="max-width:760px">
      <form id="settings-form">
        <div class="grid-2">
          <label class="field"><span>Company name</span><input name="name" value="${Core.esc(org.name)}"></label>
          <label class="field"><span>Legal name</span><input name="legalName" value="${Core.esc(org.legalName || '')}"></label>
          <label class="field"><span>GSTIN</span><input name="gstin" value="${Core.esc(org.gstin || '')}"></label>
          <label class="field"><span>PAN</span><input name="pan" value="${Core.esc(org.pan || '')}"></label>
          <label class="field"><span>Email</span><input name="email" value="${Core.esc(org.email || '')}"></label>
          <label class="field"><span>Phone</span><input name="phone" value="${Core.esc(org.phone || '')}"></label>
          <label class="field"><span>State code (GST)</span><input name="stateCode" value="${Core.esc(org.stateCode)}"></label>
          <label class="field"><span>Financial year start</span><input type="date" name="financialYearStart" value="${Core.esc(org.financialYearStart)}"></label>
          <label class="field"><span>Address line</span><input name="line1" value="${Core.esc(org.address?.line1 || '')}"></label>
          <label class="field"><span>City</span><input name="city" value="${Core.esc(org.address?.city || '')}"></label>
          <label class="field"><span>State</span><input name="state" value="${Core.esc(org.address?.state || '')}"></label>
          <label class="field"><span>PIN code</span><input name="pincode" value="${Core.esc(org.address?.pincode || '')}"></label>
        </div>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" name="allowNegativeStock" ${org.allowNegativeStock ? 'checked' : ''}> Allow negative stock (disable stock blocking)</label>
        <button class="btn btn-gold">Save Settings</button>
      </form>
    </div>

    <div class="page-head" style="margin-top:28px;margin-bottom:12px">
      <div><h1 style="font-size:18px">Account Access Control</h1>
      <p>Choose a team member, then switch each section on or off. Hidden sections are blocked in navigation, dashboard, search and the API.</p></div>
    </div>
    <div class="access-layout">
      <div class="card access-users" id="access-users">
        ${accessData.users.map(user => `<button class="access-user ${user.id === Pages._accessUserId ? 'active' : ''}" data-user-id="${user.id}">
          <b>${Core.esc(user.name)}</b><small>${Core.esc(user.email)} · ${Core.esc(user.role.replace(/_/g, ' '))}</small>
        </button>`).join('')}
      </div>
      <div class="card">
        <div class="card-head"><div><h3 id="access-title">Section access</h3><small class="muted" id="access-role"></small></div><span class="badge b-gold">Live enforcement</span></div>
        <div class="access-modules" id="access-modules"></div>
      </div>
    </div>`;
  document.querySelectorAll('.access-user').forEach(button => {
    button.addEventListener('click', () => Pages.selectAccessUser(button.dataset.userId));
  });
  Pages.renderAccessModules();
  document.getElementById('settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await Core.patch('/admin/settings', {
        name: fd.get('name'), legalName: fd.get('legalName'),
        gstin: fd.get('gstin'), pan: fd.get('pan'),
        email: fd.get('email'), phone: fd.get('phone'),
        stateCode: fd.get('stateCode'), financialYearStart: fd.get('financialYearStart'),
        allowNegativeStock: fd.get('allowNegativeStock') === 'on',
        address: { line1: fd.get('line1'), city: fd.get('city'), state: fd.get('state'), pincode: fd.get('pincode') }
      });
      toast('Saved', 'Company settings updated', 'success');
      const me = await Core.get('/auth/me');
      Core.state.org = me.org;
    } catch (err) { toast('Save failed', err.message, 'error'); }
  });
});

/* ================= ADMIN - SEQUENCES ================= */
Core.route('admin/sequences', async () => {
  const d = await Core.get('/admin/sequences');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Numbering Series', 'Document numbers follow PREFIX-FY-NNNN per financial year')}
    ${Core.table([
      { label: 'Document type', render: s => `<b>${Core.esc(s.type)}</b>` },
      { label: 'Next number', render: s => `<code>${s.prefix}-${String(s.nextNumber).padStart(4, '0')}</code>` },
      { label: '', render: s => Core.can('admin', 'edit')
        ? `<button class="btn btn-outline btn-sm" onclick="Pages.editSequence('${s.id}',${s.nextNumber})">Set next</button>` : '' }
    ], d.sequences, { emptyTitle: 'No sequences' })}`;
});

Pages.editSequence = (id, current) => {
  Core.formModal({
    title: 'Set next number',
    fields: [{ name: 'nextNumber', label: 'Next number', type: 'number', value: current, required: true }],
    submitLabel: 'Update',
    onSubmit: async v => {
      await Core.patch('/admin/sequences/' + id, v);
      toast('Updated', 'Numbering series changed', 'success');
      Core.render();
    }
  });
};

/* ================= ADMIN - AUDIT ================= */
Core.route('admin/audit', async () => {
  const d = await Core.get('/admin/audit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Audit Log', 'Append-only trail of important actions')}
    ${Core.table([
      { label: 'When', render: a => new Date(a.createdAt).toLocaleString('en-IN') },
      { label: 'Actor', key: 'actorName' },
      { label: 'Action', render: a => Core.badge(['delete', 'cancel', 'rejected'].includes(a.action) ? 'lost' : 'info') + ' ' + Core.esc(a.action) },
      { label: 'Entity', render: a => `${Core.esc(a.entity)}<br><small class="muted">${Core.esc(String(a.entityId || '').slice(0, 8))}</small>` },
      { label: 'Details', render: a => `<small>${Core.esc(a.meta || '-')}</small>` }
    ], d.events, { emptyTitle: 'No audit events' })}`;
});

/* ================= PRINT DOCUMENTS ================= */
Core.route('print/invoice/:id', async p => {
  const d = await Core.get('/sales/invoices/' + p.id);
  const inv = d.invoice, cust = d.customer, org = d.org;
  const t = inv.totals;
  document.getElementById('content').innerHTML = `
    <div class="no-print" style="max-width:820px;margin:0 auto 14px;display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-outline" onclick="location.hash='#/sales/invoices'">Back</button>
      <button class="btn btn-gold" onclick="window.print()">Print / Save PDF</button>
    </div>
    <div class="print-doc">
      <div class="pd-top">
        <div class="pd-org">
          <b>${Core.esc(org.legalName || org.name)}</b>
          <div>${Core.esc(org.address?.line1 || '')}, ${Core.esc(org.address?.city || '')}, ${Core.esc(org.address?.state || '')} - ${Core.esc(org.address?.pincode || '')}</div>
          <div>GSTIN: <b>${Core.esc(org.gstin || '-')}</b> &middot; PAN: ${Core.esc(org.pan || '-')}</div>
          <div>${Core.esc(org.email || '')} &middot; ${Core.esc(org.phone || '')}</div>
        </div>
        <div class="pd-title">
          <h2>TAX INVOICE</h2>
          <div><b>${Core.esc(inv.number)}</b></div>
          <div>Date: ${Core.fmtDate(inv.date)}</div>
          <div>Due: ${Core.fmtDate(inv.dueDate)}</div>
          <div>Place of supply: state ${Core.esc(inv.placeOfSupply)}</div>
        </div>
      </div>
      <div class="meta-grid" style="margin-bottom:6px">
        <div class="meta-item"><span>Bill to</span><b>${Core.esc(cust?.name || '-')}</b></div>
        <div class="meta-item"><span>Address</span><b>${Core.esc([cust?.billingAddress?.line1, cust?.billingAddress?.city].filter(Boolean).join(', ') || '-')}</b></div>
        <div class="meta-item"><span>Customer GSTIN</span><b>${Core.esc(cust?.gstin || '-')}</b></div>
        <div class="meta-item"><span>Status</span><b>${inv.status.toUpperCase()} &middot; paid ${Core.money(inv.paidAmount)}</b></div>
        ${inv.gstEinvoice?.irn ? `<div class="meta-item"><span>Invoice Reference Number (IRN)</span><b class="break-code">${Core.esc(inv.gstEinvoice.irn)}</b></div>` : ''}
        ${inv.gstEinvoice?.ackNo ? `<div class="meta-item"><span>IRP acknowledgement</span><b>${Core.esc(inv.gstEinvoice.ackNo)} · ${Core.esc(inv.gstEinvoice.ackDate || '')}</b></div>` : ''}
        ${inv.gstEwayBill?.ewayBillNo || inv.gstEinvoice?.ewayBillNo ? `<div class="meta-item"><span>E-Way Bill</span><b>${Core.esc(inv.gstEwayBill?.ewayBillNo || inv.gstEinvoice?.ewayBillNo)} · valid till ${Core.esc(inv.gstEwayBill?.ewayBillValidTill || inv.gstEinvoice?.ewayBillValidTill || '-')}</b></div>` : ''}
      </div>
      <table class="pd-table">
        <thead><tr><th>#</th><th>Description</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Disc%</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${inv.lines.map((l, i) => `<tr>
            <td>${i + 1}</td><td>${Core.esc(l.name)}</td><td>${Core.esc(l.hsn || '-')}</td>
            <td>${l.qty} ${Core.esc(l.uom || '')}</td><td>${Core.money(l.rate)}</td><td>${l.discountPct || 0}%</td>
            <td class="num">${Core.money(l.taxableValue)}</td>
            <td class="num">${l.cgst ? `C+S ${Core.money(l.cgst + l.sgst)}` : `IGST ${Core.money(l.igst)}`}</td>
            <td class="num">${Core.money(l.lineTotal)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="totals-box">
        <div class="tr"><span>Taxable value</span><span>${Core.money(t.taxable)}</span></div>
        ${t.cgst ? `<div class="tr"><span>CGST</span><span>${Core.money(t.cgst)}</span></div><div class="tr"><span>SGST</span><span>${Core.money(t.sgst)}</span></div>` : ''}
        ${t.igst ? `<div class="tr"><span>IGST</span><span>${Core.money(t.igst)}</span></div>` : ''}
        <div class="tr grand"><span>Grand Total</span><span>${Core.money(t.grandTotal)}</span></div>
      </div>
      <div class="pd-sign"><div>For ${Core.esc(org.name)}<br><br><br>Authorised Signatory</div><div>Customer acceptance<br><br><br>&nbsp;</div></div>
      <p class="fine muted" style="margin-top:18px">This is a computer-generated invoice. Subject to ${Core.esc(org.address?.state || '')} jurisdiction.</p>
    </div>`;
});

Pages.selectAccessUser = id => {
  Pages._accessUserId = id;
  document.querySelectorAll('.access-user').forEach(button => button.classList.toggle('active', button.dataset.userId === id));
  Pages.renderAccessModules();
};

Pages.renderAccessModules = () => {
  const data = Pages._accessData;
  const user = data?.users.find(item => item.id === Pages._accessUserId);
  const host = document.getElementById('access-modules');
  if (!user || !host) return;
  document.getElementById('access-title').textContent = user.name;
  const protectedTarget = user.role === 'super_admin' || (user.role === 'admin' && Core.state.user.role !== 'super_admin');
  document.getElementById('access-role').textContent = protectedTarget
    ? Core.roleLabel(user.role) + ' · protected by role hierarchy'
    : Core.roleLabel(user.role) + ' · changes apply at the next request';
  host.innerHTML = data.modules.map(module => {
    const checked = user.effectiveAccess[module.key] === true;
    const protectSelfAdmin = user.id === Core.state.user.id && module.key === 'admin';
    return `<div class="access-row">
      <div class="access-copy"><b>${Core.esc(module.label)}</b><small>${Core.esc(module.description)}</small></div>
      <span class="access-state">${checked ? 'On' : 'Off'}</span>
      <label class="ios-switch" title="${checked ? 'Turn off' : 'Turn on'} ${Core.esc(module.label)}">
        <input type="checkbox" data-module="${Core.esc(module.key)}" ${checked ? 'checked' : ''} ${(protectSelfAdmin || protectedTarget) ? 'disabled' : ''} aria-label="${Core.esc(module.label)} access for ${Core.esc(user.name)}">
        <span class="ios-track"></span>
      </label>
    </div>`;
  }).join('');
  host.querySelectorAll('input[data-module]').forEach(input => input.addEventListener('change', () => Pages.setModuleAccess(input)));
};

Pages.setModuleAccess = async input => {
  const user = Pages._accessData.users.find(item => item.id === Pages._accessUserId);
  if (!user) return;
  const desired = input.checked;
  input.disabled = true;
  try {
    const response = await Core.patch('/admin/users/' + user.id + '/access', {
      moduleAccess: { ...(user.moduleAccess || {}), [input.dataset.module]: desired }
    });
    user.moduleAccess = response.user.moduleAccess || {};
    user.effectiveAccess = response.effectiveAccess;
    if (user.id === Core.state.user.id) {
      Core.state.moduleAccess = response.effectiveAccess;
      Core.buildSidebar();
    }
    toast('Access updated', `${input.dataset.module} is now ${desired ? 'on' : 'off'} for ${user.name}`, 'success');
    Pages.renderAccessModules();
  } catch (error) {
    input.checked = !desired;
    input.disabled = false;
    toast('Access not changed', error.message, 'error');
  }
};

'use strict';

(() => {
  const query = new URLSearchParams(location.search);
  const suppliedToken = query.get('access') || query.get('token') || query.get('access_token');
  if (suppliedToken) sessionStorage.setItem('tdosPortalToken', suppliedToken);
  const token = suppliedToken || sessionStorage.getItem('tdosPortalToken') || '';
  if (suppliedToken) history.replaceState({}, '', location.pathname);

  const loading = document.getElementById('loading');
  const errorBox = document.getElementById('error');
  const errorText = document.getElementById('error-text');
  const portal = document.getElementById('portal');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
  const date = value => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
  const status = value => `<span class="badge">${esc(String(value || 'pending').replaceAll('_', ' '))}</span>`;

  async function api(path, options = {}) {
    const response = await fetch(`/api/portal${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    return response;
  }

  async function refresh() {
    const response = await api('/session');
    render(await response.json());
  }

  function empty(label) { return `<p class="muted empty">No ${esc(label)} available.</p>`; }
  function activityList(rows = []) {
    return rows.length ? `<div class="timeline">${rows.map(row => `<div><b>${esc(row.action)}</b><span>${esc(row.entityType)}${row.detail ? ` · ${esc(row.detail)}` : ''}</span><small>${date(row.createdAt)}</small></div>`).join('')}</div>` : empty('activity yet');
  }

  function customerView(data) {
    const quotes = data.quotations?.length ? data.quotations.map(item => `<div class="item stack"><div class="item-head"><div><b>${esc(item.number)}</b><small>${date(item.date)} · ${money(item.totals?.grandTotal)}</small></div>${status(item.status)}</div><div class="action-row"><button class="btn outline download" data-path="/quotations/${item.id}/pdf" data-name="${esc(item.number)}.pdf">Download PDF</button>${['draft', 'sent'].includes(item.status) ? `<button class="btn gold quote-decision" data-id="${item.id}" data-decision="accepted">Accept</button><button class="btn outline quote-decision" data-id="${item.id}" data-decision="rejected">Reject</button>` : ''}</div></div>`).join('') : empty('quotations');
    const invoices = data.invoices?.length ? data.invoices.map(item => `<div class="item"><div><b>${esc(item.number)}</b><small>${date(item.date)} · ${money(item.totals?.grandTotal)}</small></div><div class="action-row">${status(item.status)}<button class="btn outline download" data-path="/invoices/${item.id}/pdf" data-name="${esc(item.number)}.pdf">PDF</button></div></div>`).join('') : empty('invoices');
    const projects = data.projects?.length ? data.projects.map(project => `<div class="item stack"><div class="item-head"><div><b>${esc(project.name || project.number)}</b><small>${esc(project.number || '')} · ${date(project.startDate)}</small></div>${status(project.status)}</div><div class="subgrid"><div><strong>Milestones</strong>${project.milestones?.length ? project.milestones.map(row => `<p>◆ ${esc(row.title || row.name)} <small>${date(row.dueDate)} · ${esc(row.status || 'planned')}</small></p>`).join('') : empty('milestones')}</div><div><strong>Tasks</strong>${project.tasks?.length ? project.tasks.map(row => `<p>✓ ${esc(row.title || row.name || row.number)} <small>${esc(row.status || 'open')}</small></p>`).join('') : empty('tasks')}</div></div></div>`).join('') : empty('projects');
    const tickets = data.tickets?.length ? data.tickets.map(ticket => `<div class="item stack"><div class="item-head"><div><b>${esc(ticket.number)} · ${esc(ticket.subject)}</b><small>${esc(ticket.priority)} priority</small></div>${status(ticket.status)}</div><div class="conversation">${(ticket.workLog || []).map(log => `<div class="message ${log.portal ? 'mine' : ''}"><b>${esc(log.by || 'Support')}</b><p>${esc(log.text)}</p><small>${date(log.at)}</small></div>`).join('')}</div>${ticket.status !== 'closed' ? `<form class="reply-form" data-id="${ticket.id}"><textarea name="message" required maxlength="2000" placeholder="Write a reply…"></textarea><button class="btn gold">Send reply</button></form>` : ''}</div>`).join('') : empty('support tickets');
    const documents = data.documents?.length ? data.documents.map(item => `<div class="item"><div><b>${esc(item.title)}</b><small>${esc(item.type || 'document')} · ${date(item.createdAt)}</small></div><button class="btn outline download" data-path="/documents/${item.id}/download" data-name="${esc(item.title)}">Download</button></div>`).join('') : empty('documents');
    return `${hero(data)}<section class="grid cols"><article class="card"><h2>Quotations</h2>${quotes}</article><article class="card"><h2>Invoices</h2>${invoices}</article><article class="card wide"><h2>Projects, milestones & tasks</h2>${projects}</article><article class="card wide"><h2>Support conversations</h2>${tickets}<form id="ticket-form" class="panel-form"><h3>Open a new ticket</h3><input name="subject" required maxlength="160" placeholder="Subject"><select name="priority"><option>medium</option><option>high</option><option>low</option></select><textarea name="message" required maxlength="2000" placeholder="How can we help?"></textarea><button class="btn gold">Create ticket</button></form></article><article class="card"><h2>Documents</h2>${documents}</article><article class="card"><h2>Activity history</h2>${activityList(data.activity)}</article></section>`;
  }

  function supplierView(data) {
    const rfqs = data.rfqs?.length ? data.rfqs.map(rfq => { const existing = (rfq.quotes || []).find(row => row.vendorId === data.party.id); return `<div class="item stack"><div class="item-head"><div><b>${esc(rfq.number)}</b><small>${date(rfq.date)}${existing ? ` · submitted ${date(existing.submittedAt)}` : ''}</small></div>${status(rfq.status)}</div>${rfq.status === 'open' ? `<form class="rfq-form" data-id="${rfq.id}"><div class="line-grid">${(rfq.lines || []).map((line, index) => `<label><span>${esc(line.name || line.description || `Item ${index + 1}`)} · Qty ${esc(line.qty)}</span><input name="rate-${index}" type="number" min="0" step="0.01" required value="${esc(existing?.lines?.[index]?.rate || '')}" placeholder="Rate"><input name="tax-${index}" type="number" min="0" step="0.01" value="${esc(existing?.lines?.[index]?.taxPct || 18)}" placeholder="Tax %"></label>`).join('')}</div><div class="form-row"><input name="freight" type="number" min="0" step="0.01" value="${esc(existing?.freight || 0)}" placeholder="Freight"><input name="leadTimeDays" type="number" min="0" value="${esc(existing?.leadTimeDays || '')}" placeholder="Lead time (days)"></div><input name="paymentTerms" maxlength="300" value="${esc(existing?.paymentTerms || '')}" placeholder="Payment terms"><button class="btn gold">${existing ? 'Update quote' : 'Submit quote'}</button></form>` : ''}</div>`; }).join('') : empty('RFQs');
    const orders = data.orders?.length ? data.orders.map(item => `<div class="item stack"><div class="item-head"><div><b>${esc(item.number)}</b><small>${date(item.date)} · ${money(item.totals?.grandTotal || item.total)}</small></div>${status(item.status)}</div>${['sent', 'supplier_accepted', 'supplier_rejected'].includes(item.status) ? `<div class="action-row"><button class="btn gold po-decision" data-id="${item.id}" data-decision="accepted">Accept PO</button><button class="btn outline po-decision" data-id="${item.id}" data-decision="rejected">Reject PO</button></div>` : ''}</div>`).join('') : empty('purchase orders');
    const docs = data.documents?.length ? data.documents.map(item => `<div class="item"><div><b>${esc(item.title)}</b><small>${esc(item.type)} · ${date(item.createdAt)}</small></div><div class="action-row">${status(item.status)}<button class="btn outline download" data-path="/supplier-documents/${item.id}/download" data-name="${esc(item.title)}">Download</button></div></div>`).join('') : empty('uploaded documents');
    return `${hero(data)}<section class="grid cols"><article class="card wide"><h2>Requests for quotation</h2>${rfqs}</article><article class="card"><h2>Purchase orders</h2>${orders}</article><article class="card"><h2>Invoices & documents</h2>${docs}<form id="supplier-document-form" class="panel-form"><h3>Upload document</h3><input name="title" required maxlength="120" placeholder="Document title"><select name="type"><option value="invoice">Invoice</option><option value="quotation">Quotation</option><option value="certificate">Certificate</option><option value="other">Other</option></select><input name="reference" maxlength="100" placeholder="Reference number"><input name="file" type="file" required accept="application/pdf,image/png,image/jpeg,image/webp"><small class="muted">PDF, PNG, JPG or WEBP · maximum 1.5 MB</small><button class="btn gold">Upload securely</button></form></article><article class="card wide"><h2>Activity history</h2>${activityList(data.activity)}</article></section>`;
  }

  function hero(data) {
    return `<section class="hero"><span class="eyebrow">${esc(data.portal.partyType)} workspace</span><h1>Welcome, ${esc(data.party.contactPerson || data.party.name)}</h1><p class="muted">Live records shared securely by Tech Defenders.</p><div class="grid kpis"><div class="kpi"><span>Billed</span><b>${money(data.summary.billed)}</b></div><div class="kpi"><span>Paid</span><b>${money(data.summary.paid)}</b></div><div class="kpi"><span>Outstanding</span><b>${money(data.summary.outstanding)}</b></div><div class="kpi"><span>${data.portal.partyType === 'customer' ? 'Open tickets' : 'Portal status'}</span><b>${data.portal.partyType === 'customer' ? data.summary.openTickets : 'Active'}</b></div></div></section>`;
  }

  function render(data) {
    loading.classList.add('hidden'); errorBox.classList.add('hidden'); portal.classList.remove('hidden');
    portal.innerHTML = data.portal.partyType === 'supplier' ? supplierView(data) : customerView(data);
    bind(data);
  }

  async function download(path, name) {
    const response = await api(path);
    const blob = await response.blob();
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name || 'download'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function busy(form, active) { const button = form.querySelector('button[type="submit"],button'); if (button) { button.disabled = active; button.dataset.label ||= button.textContent; button.textContent = active ? 'Working…' : button.dataset.label; } }
  async function run(form, task) { try { busy(form, true); await task(); await refresh(); } catch (error) { alert(error.message); } finally { busy(form, false); } }

  function bind(data) {
    portal.querySelectorAll('.download').forEach(button => button.addEventListener('click', () => download(button.dataset.path, button.dataset.name).catch(error => alert(error.message))));
    portal.querySelectorAll('.quote-decision').forEach(button => button.addEventListener('click', () => run(button.parentElement, () => api(`/quotations/${button.dataset.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) }))));
    portal.querySelectorAll('.po-decision').forEach(button => button.addEventListener('click', () => run(button.parentElement, () => api(`/purchase-orders/${button.dataset.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) }))));
    portal.querySelectorAll('.reply-form').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); run(form, () => api(`/tickets/${form.dataset.id}/replies`, { method: 'POST', body: JSON.stringify({ message: new FormData(form).get('message') }) })); }));
    document.getElementById('ticket-form')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form)); run(form, () => api('/tickets', { method: 'POST', body: JSON.stringify(values) })); });
    portal.querySelectorAll('.rfq-form').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); const values = new FormData(form); const rfq = data.rfqs.find(row => row.id === form.dataset.id); const lines = (rfq.lines || []).map((_, index) => ({ rate: values.get(`rate-${index}`), taxPct: values.get(`tax-${index}`) })); run(form, () => api(`/rfqs/${form.dataset.id}/quote`, { method: 'POST', body: JSON.stringify({ lines, freight: values.get('freight'), leadTimeDays: values.get('leadTimeDays'), paymentTerms: values.get('paymentTerms') }) })); }));
    document.getElementById('supplier-document-form')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form), file = values.get('file'); run(form, async () => { if (!file || file.size > 1.5 * 1024 * 1024) throw new Error('Choose a supported file smaller than 1.5 MB'); const contentData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); await api('/supplier-documents', { method: 'POST', body: JSON.stringify({ title: values.get('title'), type: values.get('type'), reference: values.get('reference'), contentData }) }); }); });
  }

  if (!token) {
    loading.classList.add('hidden'); errorBox.classList.remove('hidden'); errorText.textContent = 'This portal link has no access token.';
  } else refresh().catch(error => { loading.classList.add('hidden'); errorBox.classList.remove('hidden'); errorText.textContent = error.message; sessionStorage.removeItem('tdosPortalToken'); });
})();

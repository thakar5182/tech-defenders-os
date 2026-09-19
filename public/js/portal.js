'use strict';
(() => {
  const token = new URLSearchParams(location.search).get('access') || sessionStorage.getItem('td_portal_token') || '';
  const loading = document.getElementById('loading'), errorBox = document.getElementById('error'), portal = document.getElementById('portal');
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 }).format(Number(value) || 0);
  const api = async (path, options = {}) => {
    const response = await fetch('/api/portal' + path, { ...options, headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const rows = (items, renderer, empty = 'No records yet.') => items?.length ? items.map(renderer).join('') : '<p class="muted">' + esc(empty) + '</p>';
  const item = (title, sub, status, actions = '') => '<div class="item"><span><b>' + esc(title) + '</b><small class="muted" style="display:block">' + esc(sub || '') + '</small></span><span>' + (status ? '<i class="badge">' + esc(status) + '</i>' : '') + actions + '</span></div>';

  function customer(data) {
    return '<section class="hero"><p class="muted">CUSTOMER WORKSPACE</p><h1>Welcome, ' + esc(data.party.name) + '</h1><p class="muted">Track business, approve quotations and get support without waiting for email updates.</p></section>' +
      '<section class="grid kpis"><div class="kpi"><b>' + money(data.summary.billed) + '</b><span>Total billed</span></div><div class="kpi"><b>' + money(data.summary.paid) + '</b><span>Paid</span></div><div class="kpi"><b>' + money(data.summary.outstanding) + '</b><span>Outstanding</span></div><div class="kpi"><b>' + esc(data.summary.openTickets) + '</b><span>Open tickets</span></div></section>' +
      '<section class="grid cols"><article class="card"><h2>Quotations</h2>' + rows(data.quotations, q => item(q.number, q.validUntil ? 'Valid until ' + q.validUntil : q.date, q.status, ['draft','sent'].includes(q.status) ? '<button class="btn gold" data-quote="' + esc(q.id) + '" data-decision="accepted">Accept</button> <button class="btn outline" data-quote="' + esc(q.id) + '" data-decision="rejected">Reject</button>' : '')) + '</article>' +
      '<article class="card"><h2>Invoices & payments</h2>' + rows(data.invoices, i => item(i.number, i.dueDate ? 'Due ' + i.dueDate + ' · ' + money(i.totals?.grandTotal) : money(i.totals?.grandTotal), i.status)) + '</article>' +
      '<article class="card"><h2>Projects</h2>' + rows(data.projects, p => item(p.name || p.number, p.description || p.startDate, p.status)) + '</article>' +
      '<article class="card"><h2>Documents</h2>' + rows(data.documents, d => item(d.title, d.mimeType, '', '<button class="btn outline" data-document="' + esc(d.id) + '">Download</button>')) + '</article>' +
      '<article class="card"><h2>Support tickets</h2>' + rows(data.tickets, t => item(t.number + ' · ' + t.subject, t.priority, t.status)) + '</article>' +
      '<article class="card"><h2>Create support ticket</h2><form id="ticket-form"><input name="subject" maxlength="160" required placeholder="Issue subject"><select name="priority"><option>medium</option><option>low</option><option>high</option></select><textarea name="message" maxlength="2000" required placeholder="Explain the issue"></textarea><button class="btn gold">Submit ticket</button></form></article></section>';
  }

  function supplier(data) {
    return '<section class="hero"><p class="muted">SUPPLIER WORKSPACE</p><h1>Welcome, ' + esc(data.party.name) + '</h1><p class="muted">Review RFQs, purchase orders, receipts and payment status.</p></section>' +
      '<section class="grid kpis"><div class="kpi"><b>' + money(data.summary.billed) + '</b><span>Invoiced</span></div><div class="kpi"><b>' + money(data.summary.paid) + '</b><span>Paid</span></div><div class="kpi"><b>' + money(data.summary.outstanding) + '</b><span>Outstanding</span></div><div class="kpi"><b>' + esc(data.orders.length) + '</b><span>Purchase orders</span></div></section>' +
      '<section class="grid cols"><article class="card"><h2>RFQs</h2>' + rows(data.rfqs, r => item(r.number, r.dueDate || r.date, r.status)) + '</article><article class="card"><h2>Purchase orders</h2>' + rows(data.orders, o => item(o.number, o.expectedDate || o.date, o.status)) + '</article><article class="card"><h2>Goods received</h2>' + rows(data.grns, g => item(g.number, g.date, g.status || 'received')) + '</article><article class="card"><h2>Invoices & payments</h2>' + rows(data.invoices, i => item(i.supplierInvoiceNo || i.number, money(i.total || i.totals?.grandTotal), i.status)) + '</article></section>';
  }

  async function render() {
    try {
      if (!token) throw new Error('This portal link is missing its secure access code.');
      sessionStorage.setItem('td_portal_token', token);
      const data = await api('/session');
      history.replaceState({}, '', '/portal');
      portal.innerHTML = data.portal.partyType === 'supplier' ? supplier(data) : customer(data);
      loading.classList.add('hidden'); portal.classList.remove('hidden');
      portal.querySelectorAll('[data-quote]').forEach(button => button.onclick = async () => {
        button.disabled = true;
        try { await api('/quotations/' + encodeURIComponent(button.dataset.quote) + '/decision', { method:'POST', body:JSON.stringify({ decision:button.dataset.decision }) }); await render(); }
        catch (error) { alert(error.message); button.disabled = false; }
      });
      portal.querySelectorAll('[data-document]').forEach(button => button.onclick = async () => {
        const response = await fetch('/api/portal/documents/' + encodeURIComponent(button.dataset.document) + '/download', { headers:{ Authorization:'Bearer ' + token } });
        if (!response.ok) return alert('Document download failed');
        const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'document'; link.click(); URL.revokeObjectURL(url);
      });
      const form = document.getElementById('ticket-form');
      if (form) form.onsubmit = async event => {
        event.preventDefault(); const value = Object.fromEntries(new FormData(form));
        try { await api('/tickets', { method:'POST', body:JSON.stringify(value) }); await render(); }
        catch (error) { alert(error.message); }
      };
    } catch (error) {
      loading.classList.add('hidden'); errorBox.classList.remove('hidden'); document.getElementById('error-text').textContent = error.message;
      sessionStorage.removeItem('td_portal_token');
    }
  }
  render();
})();

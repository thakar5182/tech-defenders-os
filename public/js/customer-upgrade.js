(function () {
  'use strict';
  function esc(v) { return Core.esc(String(v || '')); }
  function addressOptions(customer, value) {
    const list = (customer && customer.addressBook) || [];
    return '<option value="">Default customer address</option>' + list.map(function (a) { return '<option value="' + a.id + '">' + esc(a.label) + (a.city ? ' — ' + esc(a.city) : '') + '</option>'; }).join('');
  }
  async function addressBook(id) {
    const result = await Core.get('/customer-tools/customers/' + id + '/address-book');
    const rows = result.addresses.length ? result.addresses.map(function (a) { return '<div class="address-book-row"><span><b>' + esc(a.label) + '</b><small>' + esc([a.type, a.contactName, a.phone, a.line1, a.city, a.state, a.pincode].filter(Boolean).join(' · ')) + '</small></span><button class="btn btn-outline btn-sm" data-address-delete="' + a.id + '">Delete</button></div>'; }).join('') : '<div class="empty-state">No branch, godown or contact address added.</div>';
    const m = Core.openModal({ title: 'Customer address book', wide: true, body: '<div id="customer-address-list">' + rows + '</div><form id="customer-address-form" class="grid-2" style="margin-top:16px"><label class="field"><span>Label *</span><input name="label" placeholder="Ahmedabad Branch" required></label><label class="field"><span>Type</span><select name="type"><option value="branch">Branch</option><option value="godown">Godown</option><option value="billing">Billing office</option><option value="contact">Contact</option></select></label><label class="field"><span>Contact person</span><input name="contactName"></label><label class="field"><span>Phone</span><input name="phone"></label><label class="field"><span>Address</span><input name="line1"></label><label class="field"><span>City</span><input name="city"></label><label class="field"><span>State</span><input name="state"></label><label class="field"><span>PIN code</span><input name="pincode"></label><button class="btn btn-gold" type="submit">Add address</button></form>', footer: '<button class="btn btn-outline" data-cancel>Close</button>' });
    m.el.querySelector('[data-cancel]').onclick = m.close;
    m.el.querySelector('#customer-address-form').onsubmit = async function (e) { e.preventDefault(); try { await Core.post('/customer-tools/customers/' + id + '/address-book', Object.fromEntries(new FormData(e.target))); m.close(); toast('Address added', 'Invoice me select kar sakte ho', 'success'); } catch (x) { toast('Failed', x.message, 'error'); } };
    m.el.querySelectorAll('[data-address-delete]').forEach(function (b) { b.onclick = async function () { if (!confirm('Delete this address?')) return; await Core.del('/customer-tools/customers/' + id + '/address-book/' + b.dataset.addressDelete); m.close(); addressBook(id); }; });
  }
  async function intelligence(id) {
    try { const d = await Core.get('/customer-tools/customers/' + id + '/sales-intelligence'); const products = d.topProducts.length ? d.topProducts.map(function (x) { return '<div><span>' + esc(x.name) + '</span><b>' + Core.money(x.value) + '</b></div>'; }).join('') : '<p class="muted">No sales history yet.</p>'; Core.openModal({ title: 'Sales intelligence', wide: true, body: '<div class="grid-kpi compact-kpis">' + Core.kpi('Total sales', Core.money(d.totalSales)) + Core.kpi('Last purchase', d.lastPurchase ? Core.fmtDate(d.lastPurchase.date) : '-') + Core.kpi('Average payment delay', d.averagePaymentDelay + ' days') + Core.kpi('Invoices', d.invoiceCount) + '</div><div class="card"><h3>Top products / services</h3><div class="intelligence-list">' + products + '</div></div>', footer: '<button class="btn btn-outline" data-cancel>Close</button>' }); } catch (e) { toast('Failed', e.message, 'error'); }
  }
  function customerActions() {
    const match = location.hash.match(/^#\/crm\/customers\/([^/]+)/); if (!match) return;
    const bar = document.querySelector('.customer-actionbar'); if (!bar || bar.querySelector('[data-address-book]')) return;
    const a = document.createElement('button'); a.className = 'btn btn-outline btn-sm'; a.textContent = 'Address book'; a.dataset.addressBook = '1'; a.onclick = function () { addressBook(match[1]); };
    const i = document.createElement('button'); i.className = 'btn btn-outline btn-sm'; i.textContent = 'Sales intelligence'; i.onclick = function () { intelligence(match[1]); };
    bar.append(a, i);
    const tabs = document.createElement('div'); tabs.className = 'customer-mobile-tabs'; tabs.innerHTML = '<button data-tab="overview">Overview</button><button data-tab="billing">Billing</button><button data-tab="support">Support</button><button data-tab="documents">Documents</button>';
    bar.after(tabs); const sections = document.querySelectorAll('#content .grid-kpi,#content .customer-health,#content .meta-grid,#content .grid-even,#content .card');
    tabs.querySelectorAll('button').forEach(function (b) { b.onclick = function () { tabs.dataset.active = b.dataset.tab; tabs.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); }); sections.forEach(function (s, idx) { s.classList.toggle('mobile-tab-hidden', b.dataset.tab !== 'overview' && ((b.dataset.tab === 'billing' && idx < 3) || (b.dataset.tab === 'support' && idx < 3) || (b.dataset.tab === 'documents' && idx < 3))); }); }; });
  }
  function invoiceAddress() {
    const customerSelect = document.getElementById('inv-cust'); if (!customerSelect || document.getElementById('inv-address')) return;
    const label = document.createElement('label'); label.className = 'field'; label.innerHTML = '<span>Invoice branch / godown</span><select id="inv-address"></select>';
    customerSelect.closest('label').after(label); const select = label.querySelector('select');
    function refresh() { const c = (Pages._invCust || []).find(function (x) { return x.id === customerSelect.value; }); select.innerHTML = addressOptions(c, select.value); }
    refresh(); customerSelect.addEventListener('change', refresh);
  }
  const originalPost = Core.post.bind(Core); Core.post = function (path, body) { if (path === '/sales/invoices' && document.getElementById('inv-address')) body.addressBookId = document.getElementById('inv-address').value || null; return originalPost(path, body); };
  const observer = new MutationObserver(function () { customerActions(); invoiceAddress(); }); observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', function () { setTimeout(function () { customerActions(); invoiceAddress(); }, 80); });
})();

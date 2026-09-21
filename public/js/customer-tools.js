'use strict';
/* Customer 360 enhancement UI. This only activates on a customer detail route. */
(() => {
  const routeId = () => {
    const match = String(location.hash || '').match(/^#\/crm\/customers\/([^/?]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const esc = value => Core.esc(String(value == null ? '' : value));
  const money = value => Core.money(Number(value) || 0);

  async function loadCustomerTools() {
    const id = routeId();
    if (!id) return;
    const actionbar = document.querySelector('.customer-actionbar');
    if (!actionbar || actionbar.dataset.customerTools === id) return;
    actionbar.dataset.customerTools = id;
    try {
      const [addressData, intelligenceData, workspaceData] = await Promise.all([
        Core.get('/customer-tools/customers/' + encodeURIComponent(id) + '/addresses'),
        Core.get('/customer-tools/customers/' + encodeURIComponent(id) + '/intelligence'),
        Core.get('/customer-tools/customers/' + encodeURIComponent(id) + '/workspace')
      ]);
      if (routeId() !== id) return;
      if (Core.can('crm', 'edit')) {
        actionbar.insertAdjacentHTML('beforeend', '<button class="btn btn-outline btn-sm" data-customer-address-book>Address book</button>');
        actionbar.querySelector('[data-customer-address-book]').onclick = () => openAddressBook(id, addressData.addresses || []);
        actionbar.insertAdjacentHTML('beforeend', '<button class="btn btn-outline btn-sm" data-customer-contact>+ Contact</button>');
        actionbar.querySelector('[data-customer-contact]').onclick = () => openContactForm(id);
      }
      actionbar.insertAdjacentHTML('beforeend', '<button class="btn btn-outline btn-sm" data-customer-intelligence>Sales intelligence</button>');
      actionbar.querySelector('[data-customer-intelligence]').onclick = () => showIntelligence(intelligenceData.intelligence);
      renderSummary(intelligenceData.intelligence);
      renderWorkspace(workspaceData, intelligenceData.intelligence);
    } catch (error) {
      console.warn('Customer tools unavailable:', error.message);
    }
  }

  function renderWorkspace(data, intelligence) {
    if (!data || document.querySelector('[data-customer-workspace]')) return;
    const anchor = document.querySelector('.meta-grid');
    if (!anchor) return;
    const contacts = data.contacts || [], projects = data.projects || [], timeline = data.timeline || [];
    const contactRows = contacts.length ? contacts.map(row => '<div class="customer-contact-row"><span><b>' + esc(row.name) + (row.primary ? ' <em>Primary</em>' : '') + '</b><small>' + esc(row.designation || 'Contact') + '</small></span><span>' + (row.phone ? '<a href="tel:' + esc(row.phone.replace(/[^+\d]/g, '')) + '">' + esc(row.phone) + '</a>' : '') + (row.email ? '<a href="mailto:' + encodeURIComponent(row.email) + '">' + esc(row.email) + '</a>' : '') + (row.whatsapp || row.phone ? '<a target="_blank" rel="noopener" href="https://wa.me/' + esc(String(row.whatsapp || row.phone).replace(/\D/g, '')) + '">WhatsApp</a>' : '') + '</span></div>').join('') : '<div class="empty-state">No additional contacts yet.</div>';
    const timelineRows = timeline.length ? timeline.map(row => '<li><span class="customer-event-type">' + esc(row.type) + '</span><div><b>' + esc(row.title || row.type) + '</b><small>' + Core.fmtDate(row.date) + ' · ' + esc(row.status || 'recorded') + (row.amount == null ? '' : ' · ' + money(row.amount)) + '</small></div></li>').join('') : '<li class="empty-state">No customer activity yet.</li>';
    anchor.insertAdjacentHTML('afterend', '<section class="customer-workspace" data-customer-workspace><div class="customer-workspace-head"><div><span class="eyebrow">CUSTOMER COMMAND VIEW</span><h3>Relationship workspace</h3></div><span class="risk-chip risk-' + (intelligence.credit?.exceeded || intelligence.overdueInvoices > 1 ? 'high' : intelligence.overdueInvoices ? 'medium' : 'low') + '">' + (intelligence.credit?.exceeded || intelligence.overdueInvoices > 1 ? 'High' : intelligence.overdueInvoices ? 'Medium' : 'Low') + ' risk</span></div><div class="customer-tabs" role="tablist"><button class="active" data-customer-tab="overview">Overview</button><button data-customer-tab="billing">Billing</button><button data-customer-tab="support">Support</button><button data-customer-tab="projects">Projects (' + projects.length + ')</button><button data-customer-tab="documents">Documents</button></div><div class="customer-workspace-grid"><div><h4>Contacts</h4>' + contactRows + '</div><div><h4>Unified timeline</h4><ul class="customer-event-list">' + timelineRows + '</ul></div></div></section>');
    document.querySelectorAll('[data-customer-tab]').forEach(button => button.onclick = () => { document.querySelectorAll('[data-customer-tab]').forEach(item => item.classList.toggle('active', item === button)); const target = { billing: '.grid-even .card:first-child', support: '.grid-even .card:last-child', projects: '[data-customer-workspace]', documents: '.customer-documents', overview: '[data-customer-workspace]' }[button.dataset.customerTab]; document.querySelector(target)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); });
  }

  function openContactForm(customerId) {
    Core.formModal({ title: 'Add customer contact', fields: [
      { name: 'name', label: 'Contact name *', required: true }, { name: 'designation', label: 'Designation', half: true },
      { name: 'phone', label: 'Phone', half: true }, { name: 'whatsapp', label: 'WhatsApp number', half: true },
      { name: 'email', label: 'Email', type: 'email', half: true }, { name: 'primary', label: 'Primary contact', type: 'checkbox' }
    ], submitLabel: 'Save contact', onSubmit: async value => { await Core.post('/customer-tools/customers/' + encodeURIComponent(customerId) + '/contacts', value); toast('Contact saved', 'Customer contact added', 'success'); Core.render(); } });
  }

  function renderSummary(data) {
    if (!data || document.querySelector('[data-customer-insights]')) return;
    const health = document.querySelector('.customer-health');
    const mount = health?.parentElement;
    if (!mount) return;
    mount.insertAdjacentHTML('beforeend', '<div class="customer-insight-strip" data-customer-insights><span><b>' + money(data.totalSales) + '</b><small>Total sales</small></span><span><b>' + money(data.outstanding) + '</b><small>Outstanding</small></span><span><b>' + (data.averagePaymentDelayDays == null ? '—' : esc(data.averagePaymentDelayDays) + ' days') + '</b><small>Avg. payment delay</small></span><span><b>' + (data.credit?.exceeded ? 'Credit limit exceeded' : data.overdueInvoices ? esc(data.overdueInvoices) + ' overdue' : 'Account healthy') + '</b><small>Account status</small></span></div>');
  }

  function showIntelligence(data) {
    const top = (data.topProducts || []).length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Product / service</th><th>Quantity</th><th>Sales</th></tr></thead><tbody>' + data.topProducts.map(row => '<tr><td>' + esc(row.name) + '</td><td class="num">' + esc(row.quantity) + '</td><td class="num">' + money(row.sales) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<div class="empty-state">No product/service history yet.</div>';
    Core.openModal({ title: 'Sales intelligence', wide: true, body:
      '<div class="grid-kpi"><div class="kpi"><span>Total sales</span><b>' + money(data.totalSales) + '</b></div><div class="kpi"><span>Received</span><b>' + money(data.totalReceived) + '</b></div><div class="kpi"><span>Outstanding</span><b>' + money(data.outstanding) + '</b></div><div class="kpi"><span>Average payment delay</span><b>' + (data.averagePaymentDelayDays == null ? '—' : esc(data.averagePaymentDelayDays) + ' days') + '</b></div></div>' +
      '<div class="customer-health ' + (data.credit?.exceeded || data.overdueInvoices ? 'customer-health-attention' : 'customer-health-healthy') + '"><b>' + (data.credit?.exceeded ? 'Credit warning' : 'Collection status') + '</b><span>' + (data.credit?.exceeded ? 'Outstanding is above the credit limit.' : data.overdueInvoices ? esc(data.overdueInvoices) + ' overdue invoice(s), ' + money(data.overdueAmount) + ' pending.' : 'No credit warning.') + '</span></div>' +
      '<h3 style="margin-top:18px">Top products / services</h3>' + top +
      '<p class="muted" style="margin-top:14px">Last purchase: ' + (data.lastPurchase ? esc(data.lastPurchase.number) + ' on ' + Core.fmtDate(data.lastPurchase.date) + ' · ' + money(data.lastPurchase.amount) : 'No invoice yet') + '</p>',
      footer: '<button class="btn btn-outline" data-cancel>Close</button>' });
  }

  function openAddressBook(customerId, addresses) {
    const rows = addresses.length ? '<div class="document-list">' + addresses.map(a => '<div class="document-item"><span><b>' + esc(a.label) + '</b><small>' + esc(a.type) + ' · ' + esc([a.line1, a.city, a.state, a.pincode].filter(Boolean).join(', ')) + (a.contactName ? ' · ' + esc(a.contactName) : '') + '</small></span><span>' + (a.isDefault ? '<span class="badge b-gold">default</span>' : '') + '<button class="btn btn-ghost btn-sm" data-remove-address="' + esc(a.id) + '">Remove</button></span></div>').join('') + '</div>' : '<div class="empty-state">No saved branch or godown address.</div>';
    const modal = Core.openModal({ title: 'Address book', wide: true, body: rows + '<form id="customer-address-form" class="form-grid" style="margin-top:18px"><label class="field"><span>Address name *</span><input name="label" required placeholder="Ahmedabad Godown"></label><label class="field"><span>Type</span><select name="type"><option value="branch">Branch</option><option value="godown">Godown</option><option value="billing">Billing</option><option value="delivery">Delivery</option><option value="other">Other</option></select></label><label class="field"><span>Contact person</span><input name="contactName"></label><label class="field"><span>Phone</span><input name="phone"></label><label class="field field-full"><span>Address *</span><textarea name="line1" required></textarea></label><label class="field"><span>City</span><input name="city"></label><label class="field"><span>State</span><input name="state"></label><label class="field"><span>PIN code</span><input name="pincode"></label><label class="field"><span><input type="checkbox" name="isDefault"> Make default address</span></label></form>', footer: '<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-gold" type="submit" form="customer-address-form">Save address</button>' });
    modal.el.querySelector('[data-cancel]').onclick = modal.close;
    modal.el.querySelectorAll('[data-remove-address]').forEach(button => button.onclick = async () => {
      if (!await Core.confirm('Remove this saved address?', 'Remove address')) return;
      try { await Core.del('/customer-tools/customers/' + encodeURIComponent(customerId) + '/addresses/' + encodeURIComponent(button.dataset.removeAddress)); toast('Removed', 'Address removed', 'success'); modal.close(); Core.render(); }
      catch (error) { toast('Remove failed', error.message, 'error'); }
    });
    modal.el.querySelector('#customer-address-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const value = Object.fromEntries(new FormData(form).entries());
      value.isDefault = form.isDefault.checked;
      try { await Core.post('/customer-tools/customers/' + encodeURIComponent(customerId) + '/addresses', value); toast('Saved', 'Address added to address book', 'success'); modal.close(); Core.render(); }
      catch (error) { toast('Save failed', error.message, 'error'); }
    });
  }

  window.addEventListener('hashchange', () => setTimeout(loadCustomerTools, 120));
  document.addEventListener('DOMContentLoaded', () => setTimeout(loadCustomerTools, 300));
  const originalRender = Core.render;
  if (typeof originalRender === 'function') {
    Core.render = function () {
      const result = originalRender.apply(this, arguments);
      Promise.resolve(result).finally(() => setTimeout(loadCustomerTools, 150));
      return result;
    };
  }
})();

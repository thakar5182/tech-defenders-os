/* ============================================================
   Tech Defenders Business OS - Frontend core
   API client, hash router, app shell, shared UI components.
   ============================================================ */
'use strict';

const Core = {
  state: { user: null, org: null, perms: {}, moduleAccess: {}, organizations: [], openNavGroup: null, lastNavHash: null, openDashboardApp: null },
  routes: [],

  /* ---------------- API ---------------- */
  async api(method, url, body) {
    const res = await fetch('/api' + url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) { location.href = '/'; throw new Error('Session expired'); }
    if (!res.ok) {
      const error = new Error(data.error || ('Request failed (' + res.status + ')'));
      error.code = data.code;
      error.status = res.status;
      error.details = data.details;
      throw error;
    }
    return data;
  },
  get(u) { return this.api('GET', u); },
  post(u, b) { return this.api('POST', u, b); },
  patch(u, b) { return this.api('PATCH', u, b); },
  del(u) { return this.api('DELETE', u); },

  /* ---------------- permissions ---------------- */
  can(mod, action) {
    const access = this.state.moduleAccess || {};
    if (access[mod] === false) return false;
    if (mod === 'dashboard') return access.dashboard !== false;
    if (access[mod] === true && action === 'view') return true;
    const p = this.state.perms || {};
    if (p['*'] && (p['*'].includes('*') || p['*'].includes(action))) return true;
    const acts = p[mod];
    return !!acts && (acts.includes('*') || acts.includes(action));
  },

  /* ---------------- boot ---------------- */
  async boot() {
    try {
      const me = await this.get('/auth/me');
      this.state.user = me.user;
      this.state.org = me.org;
      this.state.perms = me.permissions || {};
      this.state.moduleAccess = me.moduleAccess || {};
      if (me.isSuperAdmin) {
        const platform = await this.get('/admin/organizations');
        this.state.organizations = platform.organizations || [];
      }
    } catch (e) { location.href = '/'; return; }

    this.buildSidebar();
    this.buildTopbar();
    window.addEventListener('hashchange', () => this.render());
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('global-search').focus(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); this.toggleCollapse(); }
    });
    if (!location.hash || !this.can(this.moduleForHash(location.hash), 'view')) location.hash = this.defaultRoute();
    this.render();
    if (this.state.user.mustChangePassword) this.forcePasswordChange();
  },

  /* ---------------- navigation model ---------------- */
  NAV: [
    { group: 'Overview', items: [
      { path: '#/dashboard', label: 'Dashboard', icon: '&#9636;', mod: 'dashboard' }
    ]},
    { group: 'CRM', items: [
      { path: '#/crm/leads', label: 'Leads', icon: '&#9737;', mod: 'crm' },
      { path: '#/crm/intelligence', label: 'Lead Intelligence', icon: '&#10024;', mod: 'crm' },
      { path: '#/crm/customers', label: 'Customers', icon: '&#9823;', mod: 'crm' },
      { path: '#/crm/deals', label: 'Deals Pipeline', icon: '&#9670;', mod: 'crm' },
      { path: '#/crm/tasks', label: 'Tasks & Follow-ups', icon: '&#10003;', mod: 'crm' }
    ]},
    { group: 'Sales', items: [
      { path: '#/sales/quotations', label: 'Quotations', icon: '&#9998;', mod: 'sales' },
      { path: '#/sales/ai-quote', label: 'AI Quote Draft', icon: '&#10022;', mod: 'sales' },
      { path: '#/sales/documents', label: 'Sales Documents', icon: '&#9636;', mod: 'sales' },
      { path: '#/sales/orders', label: 'Sales Orders', icon: '&#8865;', mod: 'sales' },
      { path: '#/sales/invoices', label: 'GST Invoices', icon: '&#8377;', mod: 'sales' },
      { path: '#/sales/receipts', label: 'Receipts', icon: '&#9986;', mod: 'sales' },
      { path: '#/sales/credit-notes', label: 'Credit Notes', icon: '&#8634;', mod: 'sales' }
    ]},
    { group: 'Purchase', items: [
      { path: '#/purchase/requisitions', label: 'Requisitions', icon: '&#9997;', mod: 'purchase' },
      { path: '#/purchase/rfqs', label: 'RFQs & Quotes', icon: '&#9878;', mod: 'purchase' },
      { path: '#/purchase/orders', label: 'Purchase Orders', icon: '&#9644;', mod: 'purchase' },
      { path: '#/purchase/grns', label: 'GRN / Receipts', icon: '&#10515;', mod: 'purchase' },
      { path: '#/purchase/suppliers', label: 'Suppliers', icon: '&#9881;', mod: 'purchase' }
      ,{ path: '#/purchase/billing', label: 'Vendor Billing', icon: '&#8377;', mod: 'purchase' }
    ]},
    { group: 'Inventory', items: [
      { path: '#/inventory/products', label: 'Products', icon: '&#9635;', mod: 'inventory' },
      { path: '#/inventory/summary', label: 'Stock Summary', icon: '&#9638;', mod: 'inventory' },
      { path: '#/inventory/ledger', label: 'Stock Ledger', icon: '&#8801;', mod: 'inventory' },
      { path: '#/inventory/reservations', label: 'Reservations', icon: '&#9673;', mod: 'inventory' }
    ]},
    { group: 'Manufacturing', items: [
      { path: '#/manufacturing/boms', label: 'BOMs', icon: '&#8981;', mod: 'manufacturing' },
      { path: '#/manufacturing/jobs', label: 'Job Orders', icon: '&#9883;', mod: 'manufacturing' }
    ]},
    { group: 'Service', items: [
      { path: '#/service/amc', label: 'AMC Contracts', icon: '&#9742;', mod: 'service' },
      { path: '#/service/tickets', label: 'Service Tickets', icon: '&#9873;', mod: 'service' }
    ]},
    { group: 'Accounts', items: [
      { path: '#/finance/accounts', label: 'Chart of Accounts', icon: '&#8721;', mod: 'finance' },
      { path: '#/finance/journals', label: 'Journal Entries', icon: '&#8776;', mod: 'finance' },
      { path: '#/finance/expenses', label: 'Expenses', icon: '&#8364;', mod: 'finance' },
      { path: '#/finance/pnl', label: 'Profit & Loss', icon: '&#8593;', mod: 'finance' },
      { path: '#/finance/ledgers', label: 'Ledgers & Statements', icon: '&#9776;', mod: 'finance' }
    ]},
    { group: 'HR', items: [
      { path: '#/hr/employees', label: 'Employees', icon: '&#9786;', mod: 'hr' },
      { path: '#/hr/leaves', label: 'Leave Requests', icon: '&#9203;', mod: 'hr' }
    ]},
    { group: 'Reports', items: [
      { path: '#/reports/sales', label: 'Sales Report', icon: '&#8613;', mod: 'reports' },
      { path: '#/reports/receivables', label: 'Receivable Aging', icon: '&#8987;', mod: 'reports' },
      { path: '#/reports/stock', label: 'Stock Valuation', icon: '&#9639;', mod: 'reports' },
      { path: '#/reports/funnel', label: 'Lead Funnel', icon: '&#9711;', mod: 'reports' },
      { path: '#/reports/service', label: 'Service Summary', icon: '&#9889;', mod: 'reports' }
    ]},
    { group: 'Administration', items: [
      { path: '#/admin/platform', label: 'Platform Control', icon: '&#9733;', mod: 'admin', superOnly: true },
      { path: '#/admin/users', label: 'Users & Roles', icon: '&#9820;', mod: 'admin' },
      { path: '#/admin/approvals', label: 'Approval Center', icon: '&#10003;', mod: 'admin' },
      { path: '#/admin/automation', label: 'Automation', icon: '&#8635;', mod: 'admin' },
      { path: '#/admin/integrations', label: 'Live Integrations', icon: '&#9881;', mod: 'admin' },
      { path: '#/admin/branches', label: 'Branches', icon: '&#8962;', mod: 'admin' },
      { path: '#/admin/settings', label: 'Company Settings', icon: '&#9881;', mod: 'admin' },
      { path: '#/admin/sequences', label: 'Numbering Series', icon: '&#8477;', mod: 'admin' },
      { path: '#/admin/audit', label: 'Audit Log', icon: '&#9000;', mod: 'admin' }
    ]}
  ],

  /* ---------------- sidebar ---------------- */
  buildSidebar() {
    const sb = document.getElementById('sidebar');
    const cur = location.hash || '#/dashboard';
    let html = `
      <div class="side-brand">
        <img class="side-logo" src="/assets/tech-defenders-logo.webp" alt="Tech Defenders logo">
        <div class="side-brand-text"><b>TECH DEFENDERS</b><span>BUSINESS OS</span></div>
      </div>`;
    const groups = this.visibleNavGroups();
    const activeGroup = groups.find(group => group.items.some(item => cur.startsWith(item.path)));
    const activeKey = activeGroup ? this.navGroupKey(activeGroup.group) : null;
    if (this.state.lastNavHash !== cur) {
      this.state.openNavGroup = activeKey;
      this.state.lastNavHash = cur;
    }
    for (const g of groups) {
      const visible = g.items.filter(it =>
        (!it.superOnly || this.state.user.role === 'super_admin') &&
        (!it.mod || this.can(it.mod, 'view'))
      );
      if (!visible.length) continue;
      const key = this.navGroupKey(g.group);
      if (g.group === 'Overview') {
        const item = visible[0];
        html += `<div class="nav-group nav-overview"><a href="${item.path}" class="nav-item nav-overview-link ${cur.startsWith(item.path) ? 'active' : ''}" data-path="${item.path}">
          <span class="nav-ico">${item.icon}</span><span class="lbl">${item.label}</span></a></div>`;
        continue;
      }
      const open = this.state.openNavGroup === key;
      html += `<section class="nav-group nav-accordion ${open ? 'open' : ''}" data-nav-group="${key}">
        <button type="button" class="nav-group-toggle" aria-expanded="${open}" aria-controls="nav-panel-${key}" onclick="Core.toggleNavGroup('${key}')">
          <span class="nav-ico">${visible[0].icon}</span><span class="nav-group-name">${this.esc(g.group)}</span><span class="nav-group-count">${visible.length}</span><span class="nav-chevron" aria-hidden="true">&#8964;</span>
        </button><div class="nav-group-items" id="nav-panel-${key}">`;
      for (const it of visible) {
        html += `<a href="${it.path}" class="nav-item ${cur.startsWith(it.path) ? 'active' : ''}" data-path="${it.path}">
          <span class="nav-ico">${it.icon}</span><span class="lbl">${it.label}</span></a>`;
      }
      html += `</div></section>`;
    }
    const u = this.state.user;
    html += `
      <div class="side-foot">
        <div class="side-user">
          <div class="avatar">${this.esc((u.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase())}</div>
          <div class="side-user-meta"><b>${this.esc(u.name)}</b><span>${this.esc(this.roleLabel(u.role))}</span></div>
        </div>
      </div>`;
    sb.innerHTML = html;
  },

  navGroupKey(label) {
    return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  },

  visibleNavGroups() {
    return this.NAV.map(group => ({ ...group, items: group.items.filter(item =>
      (!item.superOnly || this.state.user.role === 'super_admin') &&
      (!item.mod || this.can(item.mod, 'view'))
    ) })).filter(group => group.items.length);
  },

  toggleNavGroup(key) {
    const shell = document.getElementById('app-shell');
    if (shell.classList.contains('collapsed') && !window.matchMedia('(max-width: 900px)').matches) shell.classList.remove('collapsed');
    this.state.openNavGroup = this.state.openNavGroup === key ? null : key;
    document.querySelectorAll('[data-nav-group]').forEach(group => {
      const open = group.dataset.navGroup === this.state.openNavGroup;
      group.classList.toggle('open', open);
      const toggle = group.querySelector('.nav-group-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', String(open));
    });
  },

  appLauncher() {
    const groups = this.visibleNavGroups().filter(group => group.group !== 'Overview');
    if (!groups.length) return '';
    return `<section class="app-launcher" aria-labelledby="app-launcher-title">
      <div class="app-launcher-head"><div><span class="eyebrow">YOUR WORKSPACE</span><h2 id="app-launcher-title">Business apps</h2><p>Tap a module to open the apps you are allowed to use.</p></div><span class="app-launcher-count">${groups.length} modules</span></div>
      <div class="app-module-grid">${groups.map(group => {
        const key = this.navGroupKey(group.group);
        const open = this.state.openDashboardApp === key;
        return `<article class="app-module ${open ? 'open' : ''}" data-dashboard-app="${key}">
          <button type="button" class="app-module-toggle" aria-expanded="${open}" aria-controls="dashboard-apps-${key}" onclick="Core.toggleDashboardApp('${key}')">
            <span class="app-module-icon">${group.items[0].icon}</span><span><b>${this.esc(group.group)}</b><small>${group.items.length} app${group.items.length === 1 ? '' : 's'}</small></span><span class="app-module-arrow">&#8594;</span>
          </button>
          <div class="app-module-items" id="dashboard-apps-${key}">${group.items.map(item => `<a href="${item.path}"><span class="nav-ico">${item.icon}</span><span>${this.esc(item.label)}</span><b>&#8594;</b></a>`).join('')}</div>
        </article>`;
      }).join('')}</div>
    </section>`;
  },

  toggleDashboardApp(key) {
    this.state.openDashboardApp = this.state.openDashboardApp === key ? null : key;
    document.querySelectorAll('[data-dashboard-app]').forEach(module => {
      const open = module.dataset.dashboardApp === this.state.openDashboardApp;
      module.classList.toggle('open', open);
      const toggle = module.querySelector('.app-module-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', String(open));
    });
  },

  toggleCollapse() {
    const shell = document.getElementById('app-shell');
    if (window.matchMedia('(max-width: 900px)').matches) shell.classList.toggle('mobile-nav-open');
    else shell.classList.toggle('collapsed');
  },

  /* ---------------- topbar ---------------- */
  buildTopbar() {
    const u = this.state.user;
    document.getElementById('org-chip').textContent = this.state.org.name;
    document.getElementById('org-chip').title = u.role === 'super_admin'
      ? 'Switch active organization'
      : 'Current organization';
    document.getElementById('org-chip').onclick = () => {
      if (u.role === 'super_admin') this.openOrganizationSwitcher();
    };
    document.getElementById('user-avatar').textContent = (u.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    document.getElementById('btn-collapse').onclick = () => this.toggleCollapse();
    document.getElementById('nav-overlay').onclick = () => document.getElementById('app-shell').classList.remove('mobile-nav-open');
    document.getElementById('sidebar').addEventListener('click', e => {
      if (e.target.closest('.nav-item') && window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('app-shell').classList.remove('mobile-nav-open');
      }
    });

    /* global search */
    const gs = document.getElementById('global-search');
    const pop = document.getElementById('search-pop');
    let searchTimer = null;
    gs.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = gs.value.trim();
      if (!q) { pop.classList.add('hidden'); return; }
      searchTimer = setTimeout(async () => {
        try {
          const d = await this.get('/dashboard/search?q=' + encodeURIComponent(q));
          pop.innerHTML = d.results.length
            ? d.results.map(r => `<a href="${r.link}"><span>${this.esc(r.label)}</span><span class="st">${r.type}</span></a>`).join('')
            : '<div class="dd-empty">No matches found</div>';
          pop.classList.remove('hidden');
        } catch (_) {}
      }, 220);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.global-search')) pop.classList.add('hidden');
      if (!e.target.closest('.notif-wrap')) document.getElementById('notif-dd').classList.add('hidden');
      if (!e.target.closest('.user-wrap')) document.getElementById('user-dd').classList.add('hidden');
    });
    pop.addEventListener('click', e => { if (e.target.closest('a')) pop.classList.add('hidden'); });

    /* notifications */
    document.getElementById('btn-notif').onclick = () => this.toggleNotif();

    /* user menu */
    document.getElementById('btn-user').onclick = () => {
      const dd = document.getElementById('user-dd');
      dd.innerHTML = `
        <div class="dd-head"><div>${this.esc(u.name)}<br><small class="muted" style="font-weight:400">${this.esc(u.email)}</small></div></div>
        <button class="user-menu-item" id="um-signout">Sign out</button>`;
      dd.classList.remove('hidden');
      dd.querySelector('#um-signout').onclick = async () => {
        try { await this.post('/auth/logout'); } catch (_) {}
        location.href = '/';
      };
    };

    /* quick create */
    document.getElementById('btn-quickcreate').onclick = e => {
      e.stopPropagation();
      const dd = document.getElementById('user-dd');
      const items = [];
      if (this.can('crm', 'create')) items.push(['New Lead', "Pages.openLeadForm()"]);
      if (this.can('crm', 'create')) items.push(['New Customer', "Pages.openCustomerForm()"]);
      if (this.can('sales', 'create')) items.push(['New Quotation', "location.hash='#/sales/quotations/new'"]);
      if (this.can('sales', 'create')) items.push(['New GST Invoice', "location.hash='#/sales/invoices/new'"]);
      if (this.can('service', 'create')) items.push(['New Ticket', "Pages.openTicketForm()"]);
      if (this.can('inventory', 'create')) items.push(['New Product', "location.hash='#/inventory/products/new'"]);
      dd.className = 'dropdown';
      dd.style.width = '220px';
      dd.innerHTML = '<div class="dd-head">Quick create</div>' +
        items.map(([l, c]) => `<button class="user-menu-item" onclick="${c};document.getElementById('user-dd').classList.add('hidden')">${l}</button>`).join('');
      dd.classList.remove('hidden');
    };
  },

  async toggleNotif() {
    const dd = document.getElementById('notif-dd');
    if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
    try {
      const d = await this.get('/dashboard/notifications');
      document.getElementById('notif-dot').classList.toggle('hidden', d.unread === 0);
      dd.innerHTML = `
        <div class="dd-head">Notifications ${d.unread ? `<button class="btn btn-ghost btn-sm" id="mark-read">Mark all read</button>` : ''}</div>
        <div class="dd-list">${d.notifications.length
          ? d.notifications.map(n => {
              const tag = n.link && /^#\/[a-z0-9/_-]+$/i.test(n.link) ? 'a' : 'div';
              const href = tag === 'a' ? ` href="${this.esc(n.link)}"` : '';
              return `<${tag}${href} class="dd-item"><b>${this.esc(n.title)}</b><small>${this.esc(n.body)}</small></${tag}>`;
            }).join('')
          : '<div class="dd-empty">You are all caught up.</div>'}</div>`;
      dd.classList.remove('hidden');
      const mr = dd.querySelector('#mark-read');
      if (mr) mr.onclick = async () => { await this.post('/dashboard/notifications/read'); dd.classList.add('hidden'); this.refreshNotifDot(); };
    } catch (_) {}
  },

  async refreshNotifDot() {
    try {
      const d = await this.get('/dashboard/notifications');
      document.getElementById('notif-dot').classList.toggle('hidden', d.unread === 0);
    } catch (_) {}
  },

  /* ---------------- router ---------------- */
  route(pattern, handler) {
    this.routes.push({ pattern, handler });
  },

  async render() {
    const hash = location.hash || '#/dashboard';
    const module = this.moduleForHash(hash);
    if (!this.can(module, 'view')) {
      const fallback = this.defaultRoute();
      if (hash !== fallback) { location.hash = fallback; return; }
    }
    this.buildSidebar(); // refresh active state
    const content = document.getElementById('content');

    for (const r of this.routes) {
      const patParts = r.pattern.split('/').filter(Boolean);   // e.g. ['crm','leads']
      const hashParts = hash.replace(/^#\//, '').split('/').filter(Boolean);
      if (patParts.length !== hashParts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < patParts.length; i++) {
        if (patParts[i].startsWith(':')) params[patParts[i].slice(1)] = decodeURIComponent(hashParts[i]);
        else if (patParts[i] !== hashParts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      content.innerHTML = '<div class="skel" style="width:30%"></div><div class="skel"></div><div class="skel" style="width:70%"></div>';
      try { await r.handler(params); }
      catch (e) {
        content.innerHTML = `<div class="card card-pad"><div class="empty-state">
          <div class="big">&#9888;</div><h3>Could not load this page</h3>
          <p>${this.esc(e.message)}</p>
          <button class="btn btn-outline" style="margin-top:12px" onclick="Core.render()">Retry</button></div></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
    content.innerHTML = `<div class="card card-pad"><div class="empty-state">
      <div class="big">&#128379;</div><h3>Page not found</h3><p>The route <code>${this.esc(hash)}</code> does not exist.</p></div></div>`;
  },

  openOrganizationSwitcher() {
    const orgs = this.state.organizations || [];
    const m = this.openModal({
      title: 'Switch organization',
      body: `<p class="muted" style="margin-bottom:14px">Choose the workspace whose complete business data you want to view and manage.</p>
        <div class="org-switch-list">
          ${orgs.map(org => `<button class="org-switch-item ${org.id === this.state.org.id ? 'active' : ''}" data-org-id="${this.esc(org.id)}">
            <span><b>${this.esc(org.name)}</b><small>${this.esc(org.legalName || org.email || '')}</small></span>
            <span class="badge ${org.id === this.state.org.id ? 'b-gold' : 'b-neutral'}">${org.id === this.state.org.id ? 'Active' : 'Open'}</span>
          </button>`).join('')}
        </div>`,
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button>'
    });
    m.el.querySelectorAll('[data-org-id]').forEach(button => {
      button.addEventListener('click', async () => {
        if (button.dataset.orgId === this.state.org.id) return m.close();
        button.disabled = true;
        try {
          await this.post('/admin/switch-organization', { orgId: button.dataset.orgId });
          location.hash = '#/dashboard';
          location.reload();
        } catch (error) {
          button.disabled = false;
          toast('Workspace not changed', error.message, 'error');
        }
      });
    });
  },

  moduleForHash(hash) {
    const first = String(hash || '').replace(/^#\//, '').split('/')[0] || 'dashboard';
    if (first === 'print') return 'sales';
    return first;
  },

  defaultRoute() {
    for (const group of this.NAV) {
      const item = group.items.find(candidate =>
        (!candidate.superOnly || this.state.user.role === 'super_admin') &&
        (!candidate.mod || this.can(candidate.mod, 'view'))
      );
      if (item) return item.path;
    }
    return '#/dashboard';
  },

  roleLabel(role) {
    if (role === 'super_admin') return 'Super Admin';
    return String(role || '').split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  },

  forcePasswordChange() {
    const m = this.openModal({
      title: 'Change temporary password', closable: false,
      body: `<p class="muted" style="margin-bottom:14px">Your administrator issued a temporary password. Choose a private password before continuing.</p>
        <form id="forced-password-form" class="grid-2">
          <label class="field" style="grid-column:1/-1"><span>Current temporary password</span><input name="currentPassword" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
          <label class="field"><span>Confirm password</span><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        </form>`,
      footer: '<button class="btn btn-gold" type="submit" form="forced-password-form">Save new password</button>'
    });
    m.el.querySelector('#forced-password-form').addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(event.target);
      if (values.get('newPassword') !== values.get('confirmPassword')) return toast('Check password', 'New passwords do not match', 'error');
      try {
        const result = await this.post('/auth/change-password', {
          currentPassword: values.get('currentPassword'), newPassword: values.get('newPassword')
        });
        this.state.user = result.user;
        m.close();
        toast('Password changed', 'Your account is ready to use', 'success');
        this.render();
      } catch (error) { toast('Password not changed', error.message, 'error'); }
    });
  },

  /* ---------------- shared UI helpers ---------------- */
  esc(s) {
    const MAP = { '&': '&' + 'amp;', '<': '&' + 'lt;', '>': '&' + 'gt;', '"': '&' + 'quot;', "'": '&' + '#39;' };
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => MAP[ch]);
  },

  money(n) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n) || 0);
  },
  moneyShort(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e7) return '\u20B9' + (n / 1e7).toFixed(2) + ' Cr';
    if (Math.abs(n) >= 1e5) return '\u20B9' + (n / 1e5).toFixed(2) + ' L';
    if (Math.abs(n) >= 1e3) return '\u20B9' + (n / 1e3).toFixed(1) + 'K';
    return this.money(n);
  },
  fmtDate(d) {
    if (!d) return '-';
    const dt = new Date(d);
    if (isNaN(dt)) return '-';
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  STATUS_CLASS: {
    // greens
    won: 'b-success', paid: 'b-success', approved: 'b-success', accepted: 'b-success',
    converted: 'b-success', completed: 'b-success', resolved: 'b-success', active: 'b-success',
    received: 'b-success', pass: 'b-success', closed: 'b-neutral', done: 'b-success',
    // reds
    lost: 'b-danger', rejected: 'b-danger', cancelled: 'b-danger', expired: 'b-danger',
    overdue: 'b-danger', breached: 'b-danger', out_of_stock: 'b-danger', fail: 'b-danger',
    unpaid: 'b-danger', urgent: 'b-danger',
    // ambers
    pending: 'b-warning', pending_approval: 'b-warning', partial: 'b-warning',
    expiring_soon: 'b-warning', low: 'b-warning', waiting_parts: 'b-warning',
    waiting_customer: 'b-warning', high: 'b-warning', medium: 'b-info',
    // blues / neutrals
    draft: 'b-neutral', sent: 'b-info', confirmed: 'b-info', in_progress: 'b-info',
    assigned: 'b-info', open: 'b-gold', new: 'b-gold', contacted: 'b-info',
    qualified: 'b-gold', proposal: 'b-info', negotiation: 'b-warning',
    released: 'b-info', planned: 'b-neutral', awarded: 'b-success'
  },
  badge(status) {
    const cls = this.STATUS_CLASS[String(status)] || 'b-neutral';
    return `<span class="badge ${cls}">${this.esc(String(status).replace(/_/g, ' '))}</span>`;
  },

  pageHead(title, sub, actionsHtml) {
    return `<div class="page-head">
      <div><div class="crumbs">Tech Defenders OS / <b>${this.esc(title)}</b></div>
      <h1>${this.esc(title)}</h1>${sub ? `<p>${this.esc(sub)}</p>` : ''}</div>
      <div class="page-actions">${actionsHtml || ''}</div>
    </div>`;
  },

  kpi(label, value, sub, tone, link) {
    const tag = link ? 'a' : 'div';
    const href = link ? ` href="${this.esc(link)}"` : '';
    return `<${tag}${href} class="kpi ${tone || ''} ${link ? 'kpi-link' : ''}">
      <div class="k-label">${this.esc(label)}</div>
      <div class="k-value">${value}</div>
      ${sub ? `<div class="k-sub">${this.esc(sub)}</div>` : ''}
    </${tag}>`;
  },

  table(columns, rows, opts) {
    opts = opts || {};
    if (!rows.length) {
      return `<div class="card"><div class="empty-state"><div class="big">${opts.emptyIcon || '&#128230;'}</div>
        <h3>${opts.emptyTitle || 'Nothing here yet'}</h3><p>${opts.emptyText || 'Records you create will appear here.'}</p></div></div>`;
    }
    const head = columns.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('');
    const body = rows.map((row, i) => '<tr>' + columns.map(c =>
      `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(row, i) : this.esc(row[c.key] != null ? row[c.key] : '-')}</td>`
    ).join('') + '</tr>').join('');
    return `<div class="card"><div class="table-wrap"><table class="tbl">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  },

  /* ---------------- modal ---------------- */
  openModal(opts) {
    const host = document.getElementById('modal-host');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${opts.wide ? 'wide' : ''} ${this.esc(opts.className || '')}" role="dialog" aria-modal="true" aria-label="${this.esc(opts.title)}">
        <div class="modal-head"><h3>${this.esc(opts.title)}</h3>
          ${opts.closable === false ? '' : '<button class="modal-x" aria-label="Close">&times;</button>'}</div>
        <div class="modal-body">${opts.body || ''}</div>
        ${opts.footer ? `<div class="modal-foot">${opts.footer}</div>` : ''}
      </div>`;
    host.appendChild(backdrop);
    const previousFocus = document.activeElement;
    let keyHandler;
    const close = () => {
      backdrop.remove();
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      if (previousFocus?.focus) previousFocus.focus();
    };
    backdrop.addEventListener('click', e => {
      if (opts.closable !== false && (e.target === backdrop || e.target.classList.contains('modal-x'))) close();
    });
    keyHandler = e => {
      if (e.key === 'Escape' && opts.closable !== false) { close(); document.removeEventListener('keydown', keyHandler); }
      if (e.key === 'Tab') {
        const focusable = [...backdrop.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyHandler);
    setTimeout(() => backdrop.querySelector('input, select, textarea, button')?.focus(), 0);
    return { close, el: backdrop };
  },

  confirm(message, title) {
    return new Promise(resolve => {
      const m = this.openModal({
        title: title || 'Please confirm',
        body: `<p style="font-size:14px">${this.esc(message)}</p>`,
        footer: `<button class="btn btn-outline" data-no>Cancel</button>
                 <button class="btn btn-dark" data-yes>Confirm</button>`
      });
      m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(false); };
      m.el.querySelector('[data-yes]').onclick = () => { m.close(); resolve(true); };
    });
  },

  /* generic form modal. fields: [{name,label,type,options,value,required,placeholder,half}] */
  formModal(opts) {
    const fieldsHtml = opts.fields.map(f => {
      const val = f.value != null ? f.value : '';
      const req = f.required ? 'required' : '';
      let input;
      if (f.type === 'select') {
        input = `<select name="${f.name}" ${req}>${(f.options || [])
          .map(o => `<option value="${this.esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${this.esc(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea name="${f.name}" rows="3" ${req} placeholder="${f.placeholder || ''}">${this.esc(val)}</textarea>`;
      } else if (f.type === 'checkbox') {
        return `<label class="check" style="grid-column:1/-1;margin-bottom:13px"><input type="checkbox" name="${f.name}" ${val ? 'checked' : ''}> ${this.esc(f.label)}</label>`;
      } else {
        input = `<input type="${f.type || 'text'}" name="${f.name}" value="${this.esc(val)}" ${req} placeholder="${f.placeholder || ''}" ${f.step ? `step="${f.step}"` : ''}>`;
      }
      return `<label class="field" ${f.half ? '' : 'style="grid-column:1/-1"'}>
        <span>${this.esc(f.label)}</span>${input}</label>`;
    }).join('');

    const m = this.openModal({
      title: opts.title,
      wide: true,
      body: `<form id="fm-form"><div class="grid-2">${fieldsHtml}</div></form>`,
      footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
               <button class="btn btn-gold" type="submit" form="fm-form">${opts.submitLabel || 'Save'}</button>`
    });
    m.el.querySelector('[data-cancel]').onclick = m.close;
    m.el.querySelector('#fm-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const values = {};
      for (const f of opts.fields) {
        if (f.type === 'checkbox') { values[f.name] = fd.get(f.name) === 'on'; continue; }
        let v = fd.get(f.name);
        if (f.type === 'number') v = v === '' || v == null ? null : Number(v);
        values[f.name] = v;
      }
      const btn = m.el.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await opts.onSubmit(values);
        m.close();
      } catch (err) {
        toast('Action failed', err.message, 'error');
        btn.disabled = false;
      }
    });
    return m;
  },

  /* bar chart renderer (pure CSS) */
  barChart(rows, valueKey, labelKey, altKey) {
    const max = Math.max(...rows.map(r => Number(r[valueKey]) || 0), 1);
    return `<div class="chart-bars">${rows.map(r => {
      const pct = Math.round((Number(r[valueKey]) || 0) / max * 100);
      return `<div class="chart-bar ${altKey && r[altKey] ? 'alt' : ''}">
        <em>${this.esc(r.fmt || '')}</em><i style="height:${Math.max(pct, 2)}%" title="${this.esc(String(r[labelKey]))}: ${this.money(r[valueKey])}"></i>
        <span>${this.esc(String(r[labelKey]).slice(5))}</span></div>`;
    }).join('')}</div>`;
  }
};

window.Core = Core;
window.toast = window.toast || function (title, msg, kind) {
  const host = document.getElementById('toast-host');
  const t = document.createElement('div');
  t.className = 'toast t-' + (kind || 'info');
  const heading = document.createElement('b');
  heading.textContent = String(title || 'Notice');
  t.append(heading, document.createTextNode(String(msg || '')));
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3800);
};

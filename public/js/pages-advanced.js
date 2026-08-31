/* Tech Defenders OS v3 pages: intelligence, documents, ledgers and controls. */
'use strict';

const Adv = {
  lineRow(values) {
    const line = values || {};
    return `<tr>
      <td data-label="Description"><input data-line="name" value="${Core.esc(line.name || line.description || '')}" required placeholder="Item or service"></td>
      <td data-label="Qty"><input data-line="qty" type="number" min="0.001" step="any" value="${Core.esc(line.qty || 1)}" required></td>
      <td data-label="UOM"><input data-line="uom" value="${Core.esc(line.uom || 'Nos')}"></td>
      <td data-label="HSN/SAC"><input data-line="hsn" value="${Core.esc(line.hsn || '')}"></td>
      <td data-label="Rate"><input data-line="rate" type="number" min="0" step="0.01" value="${Core.esc(line.rate || 0)}" required></td>
      <td data-label="Discount %"><input data-line="discountPct" type="number" min="0" max="100" step="0.01" value="${Core.esc(line.discountPct || 0)}"></td>
      <td data-label="GST %"><input data-line="gstRate" type="number" min="0" max="100" step="0.01" value="${Core.esc(line.gstRate == null ? 18 : line.gstRate)}"></td>
      <td class="line-remove"><button class="rm" type="button" data-remove-line aria-label="Remove line">&times;</button></td>
    </tr>`;
  },

  editor(lines) {
    const rows = (lines && lines.length ? lines : [{}]).map(item => this.lineRow(item)).join('');
    return `<div class="lines-editor"><table class="manual-lines-table"><thead><tr>
      <th>Description</th><th>Qty</th><th>UOM</th><th>HSN/SAC</th><th>Rate</th><th>Discount</th><th>GST</th><th></th>
      </tr></thead><tbody data-line-host>${rows}</tbody></table></div>
      <button class="btn btn-outline btn-sm add-line-btn" type="button" data-add-line>+ Add line</button>`;
  },

  bindEditor(modal) {
    const host = modal.el.querySelector('[data-line-host]');
    modal.el.querySelector('[data-add-line]').onclick = () => host.insertAdjacentHTML('beforeend', this.lineRow());
    host.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-line]');
      if (!button) return;
      if (host.children.length === 1) return toast('Line required', 'A document needs at least one line', 'error');
      button.closest('tr').remove();
    });
  },

  collectLines(modal, purchase) {
    return [...modal.el.querySelectorAll('[data-line-host] tr')].map(row => {
      const get = key => row.querySelector(`[data-line="${key}"]`).value;
      if (purchase) return { description: get('name'), qty: Number(get('qty')), rate: Number(get('rate')), taxPct: Number(get('gstRate')) };
      return {
        name: get('name'), qty: Number(get('qty')), uom: get('uom'), hsn: get('hsn'),
        rate: Number(get('rate')), discountPct: Number(get('discountPct')), gstRate: Number(get('gstRate'))
      };
    });
  },

  async openSalesDocument(kind, initialLines) {
    const customers = (await Core.get('/crm/customers')).customers;
    if (!customers.length) return toast('Customer required', 'Create a customer before making a document', 'error');
    const labels = { proforma: 'Proforma Invoice', delivery: 'Delivery Challan', debit: 'Debit Note' };
    const endpoints = { proforma: '/v3/sales/proformas', delivery: '/v3/sales/delivery-challans', debit: '/v3/sales/debit-notes' };
    const modal = Core.openModal({
      title: 'New ' + labels[kind], wide: true,
      body: `<form id="advanced-sales-form">
        <div class="manual-entry-callout"><b>Manual item entry</b><span>Type every description, quantity, rate and GST value. Review before posting.</span></div>
        <div class="grid-2 document-meta">
          <label class="field"><span>Customer</span><select name="customerId" required>${customers.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Date</span><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
          ${kind === 'delivery' ? '<label class="field"><span>Vehicle no.</span><input name="vehicleNo"></label><label class="field"><span>Transporter</span><input name="transporter"></label>' : ''}
          ${kind === 'debit' ? '<label class="field" style="grid-column:1/-1"><span>Reason</span><input name="reason" required></label>' : ''}
        </div>${this.editor(initialLines)}
        <label class="field" style="margin-top:14px"><span>Notes</span><textarea name="notes" rows="3"></textarea></label>
      </form>`,
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="advanced-sales-form">Create document</button>'
    });
    modal.el.querySelector('[data-cancel]').onclick = modal.close;
    this.bindEditor(modal);
    modal.el.querySelector('#advanced-sales-form').addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(event.target);
      const button = modal.el.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await Core.post(endpoints[kind], {
          customerId: data.get('customerId'), date: data.get('date'), notes: data.get('notes'),
          reason: data.get('reason'), vehicleNo: data.get('vehicleNo'), transporter: data.get('transporter'),
          lines: this.collectLines(modal, false)
        });
        modal.close();
        toast('Document created', labels[kind] + ' is ready', 'success');
        Core.render();
      } catch (error) { button.disabled = false; toast('Not created', error.message, 'error'); }
    });
  },

  async openPurchaseInvoice() {
    const suppliers = (await Core.get('/purchase/suppliers')).suppliers;
    if (!suppliers.length) return toast('Supplier required', 'Create a supplier first', 'error');
    const modal = Core.openModal({
      title: 'New Purchase Invoice', wide: true,
      body: `<form id="purchase-invoice-form"><div class="grid-2 document-meta">
        <label class="field"><span>Supplier</span><select name="supplierId" required>${suppliers.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Supplier invoice no.</span><input name="supplierInvoiceNo" required></label>
        <label class="field"><span>Invoice date</span><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        <label class="field"><span>Due date</span><input name="dueDate" type="date"></label>
      </div>${this.editor()}</form>`,
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="purchase-invoice-form">Post invoice</button>'
    });
    modal.el.querySelector('[data-cancel]').onclick = modal.close;
    this.bindEditor(modal);
    modal.el.querySelector('#purchase-invoice-form').addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        await Core.post('/v3/purchase/invoices', {
          supplierId: data.get('supplierId'), supplierInvoiceNo: data.get('supplierInvoiceNo'),
          date: data.get('date'), dueDate: data.get('dueDate') || null,
          lines: this.collectLines(modal, true)
        });
        modal.close(); toast('Purchase invoice posted', 'Vendor payable and journal were updated', 'success'); Core.render();
      } catch (error) { toast('Not posted', error.message, 'error'); }
    });
  }
};

/* ================= CRM INTELLIGENCE ================= */
Core.route('crm/intelligence', async () => {
  const data = await Core.get('/v3/crm/lead-insights?limit=200');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Lead Intelligence', 'Transparent scoring, duplicate detection and controlled import/export', `
      <button class="btn btn-outline" id="lead-export">Export CSV</button>
      <button class="btn btn-outline" id="lead-dedupe">Scan duplicates</button>
      ${Core.can('crm', 'create') ? '<button class="btn btn-gold" id="lead-import">Import leads</button>' : ''}`)}
    <div class="audit-note"><b>Explainable scoring</b><span>Scores use contact completeness, opportunity value, stage and recorded activity—no hidden model or automated decision.</span></div>
    ${Core.table([
      { label: 'Lead', render: item => `<b>${Core.esc(item.name)}</b><br><small class="muted">${Core.esc(item.company || '')}</small>` },
      { label: 'Contact', render: item => `${Core.esc(item.email || '-')}<br><small>${Core.esc(item.phone || '')}</small>` },
      { label: 'Stage', render: item => Core.badge(item.status) },
      { label: 'Value', num: true, render: item => Core.money(item.value) },
      { label: 'Score', render: item => `<div class="score-cell"><b>${item.intelligence.score}</b><span><i style="width:${item.intelligence.score}%"></i></span><small>${Core.esc(item.intelligence.reasons.join(', ') || 'basic profile')}</small></div>` }
    ], data.leads, { emptyTitle: 'No leads to score', emptyText: 'Create or import leads to see intelligence.' })}`;
  document.getElementById('lead-export').onclick = () => { location.href = '/api/v3/crm/leads-export'; };
  document.getElementById('lead-dedupe').onclick = async () => {
    const result = await Core.post('/v3/crm/lead-deduplicate', { merge: false });
    if (!result.duplicateGroups) return toast('Duplicate scan', 'No duplicate email or phone found', 'success');
    const confirmed = await Core.confirm(`${result.duplicateGroups} duplicate group(s) found. Merge each group into its oldest record?`, 'Merge duplicate leads');
    if (confirmed) {
      const merged = await Core.post('/v3/crm/lead-deduplicate', { merge: true });
      toast('Duplicates merged', `${merged.removed} duplicate record(s) removed`, 'success'); Core.render();
    }
  };
  const importButton = document.getElementById('lead-import');
  if (importButton) importButton.onclick = () => {
    const modal = Core.openModal({
      title: 'Import leads from JSON', wide: true,
      body: `<form id="lead-import-form"><p class="muted" style="margin-bottom:12px">Paste a JSON array with name, company, email, phone, source, value and notes. Duplicate email/phone records are skipped.</p>
        <label class="field"><span>JSON records</span><textarea name="records" rows="12" required placeholder='[{"name":"New Lead","email":"lead@example.com"}]'></textarea></label></form>`,
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="lead-import-form">Validate & import</button>'
    });
    modal.el.querySelector('[data-cancel]').onclick = modal.close;
    modal.el.querySelector('#lead-import-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const records = JSON.parse(new FormData(event.target).get('records'));
        const result = await Core.post('/v3/crm/leads-import', { records });
        modal.close(); toast('Import complete', `${result.imported} added, ${result.skipped} duplicates skipped`, 'success'); Core.render();
      } catch (error) { toast('Import failed', error.message, 'error'); }
    };
  };
});

/* ================= SALES DOCUMENTS ================= */
Core.route('sales/documents', async () => {
  const [proformaData, deliveryData, debitData] = await Promise.all([
    Core.get('/v3/sales/proformas'), Core.get('/v3/sales/delivery-challans'), Core.get('/v3/sales/debit-notes')
  ]);
  const rows = [
    ...proformaData.proformas.map(item => ({ ...item, docType: 'Proforma' })),
    ...deliveryData.deliveryChallans.map(item => ({ ...item, docType: 'Delivery Challan' })),
    ...debitData.debitNotes.map(item => ({ ...item, docType: 'Debit Note' }))
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Sales Documents', 'Proforma invoices, delivery challans and customer debit notes', Core.can('sales', 'create') ? `
      <button class="btn btn-outline" data-new-doc="delivery">+ Delivery Challan</button>
      <button class="btn btn-outline" data-new-doc="debit">+ Debit Note</button>
      <button class="btn btn-gold" data-new-doc="proforma">+ Proforma</button>` : '')}
    <div class="kpi-grid compact-kpis">
      ${Core.kpi('Proformas', proformaData.proformas.length, 'Draft and converted', 'gold')}
      ${Core.kpi('Delivery Challans', deliveryData.deliveryChallans.length, 'Issued goods documents')}
      ${Core.kpi('Debit Notes', debitData.debitNotes.length, 'Customer adjustments')}
    </div>
    ${Core.table([
      { label: 'Document', render: item => `<b>${Core.esc(item.number)}</b><br><small>${Core.esc(item.docType)}</small>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: item => Core.fmtDate(item.date) },
      { label: 'Amount', num: true, render: item => item.totals ? Core.money(item.totals.grandTotal) : '-' },
      { label: 'Status', render: item => Core.badge(item.status) },
      { label: '', render: item => item.docType === 'Proforma' && !item.convertedToId && Core.can('sales', 'edit') ? `<button class="btn btn-outline btn-sm" data-convert-proforma="${Core.esc(item.id)}">Convert to invoice</button>` : '' }
    ], rows, { emptyTitle: 'No advanced sales documents', emptyText: 'Create a proforma, delivery challan or debit note.' })}`;
  document.querySelectorAll('[data-new-doc]').forEach(button => button.onclick = () => Adv.openSalesDocument(button.dataset.newDoc));
  document.querySelectorAll('[data-convert-proforma]').forEach(button => button.onclick = async () => {
    const confirmed = await Core.confirm('Create a GST invoice from this proforma? Stock is not changed because proforma lines are manual.', 'Convert proforma');
    if (!confirmed) return;
    const result = await Core.post('/v3/sales/proformas/' + button.dataset.convertProforma + '/convert-invoice');
    toast('Invoice created', result.invoice.number, 'success'); location.hash = '#/sales/invoices';
  });
});

/* ================= AI QUOTE ================= */
Core.route('sales/ai-quote', async () => {
  const [status, customers] = await Promise.all([Core.get('/v3/ai/status'), Core.get('/crm/customers')]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('AI Quote Draft', 'Local Ollama assistant with mandatory human review')}
    <div class="ai-layout">
      <section class="card card-pad">
        <div class="integration-head"><div><span class="provider-mark">AI</span><div><h3>Local quotation assistant</h3><p>${Core.esc(status.model)} · data stays on this computer</p></div></div>${Core.badge(status.configured ? 'configured' : 'disabled')}</div>
        <div class="audit-note"><b>Human-in-the-loop</b><span>The assistant never sends or posts a quotation. You must review customer, quantities, rates and GST before saving.</span></div>
        <form id="ai-request-form">
          <label class="field"><span>Customer request / RFQ text</span><textarea name="requestText" rows="12" required placeholder="Paste the customer's requirement, quantities and technical notes..."></textarea></label>
          <button class="btn btn-gold" type="submit" ${status.configured ? '' : 'disabled'}>Generate review draft</button>
        </form>
        ${status.configured ? '' : `<div class="provider-help"><b>AI is not configured</b><p>${Core.esc(status.message)}</p><code>node scripts\\configure-ollama.js<br>OLLAMA_MODEL=qwen3:4b</code></div>`}
      </section>
      <aside class="card card-pad" id="ai-review"><div class="empty-state"><div class="big">&#10022;</div><h3>No draft yet</h3><p>Generated items will appear here for review.</p></div></aside>
    </div>`;
  const form = document.getElementById('ai-request-form');
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button'); button.disabled = true; button.textContent = 'Generating...';
    try {
      const result = await Core.post('/v3/ai/quotation-draft', { requestText: new FormData(form).get('requestText') });
      const output = result.draft.output;
      const review = document.getElementById('ai-review');
      review.innerHTML = `<div class="section-title"><div><h3>Review required</h3><p>${Core.esc(output.summary || '')}</p></div><span class="badge b-warning">Not saved</span></div>
        <label class="field"><span>Customer</span><select id="ai-customer"><option value="">Select customer</option>${customers.customers.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.name)}</option>`).join('')}</select></label>
        <div id="ai-lines">${Adv.editor(output.lines || [])}</div>
        <div class="ai-assumptions"><b>Assumptions</b><ul>${(output.assumptions || []).map(item => `<li>${Core.esc(item)}</li>`).join('') || '<li>None supplied</li>'}</ul></div>
        <button class="btn btn-gold" id="save-ai-quote">Save reviewed quotation</button>`;
      Adv.bindEditor({ el: review });
      review.querySelector('#save-ai-quote').onclick = async () => {
        const customerId = review.querySelector('#ai-customer').value;
        if (!customerId) return toast('Customer required', 'Select a customer before saving', 'error');
        const lines = Adv.collectLines({ el: review }, false);
        const saved = await Core.post('/sales/quotations', { customerId, lines, notes: 'Drafted locally with AI and reviewed by ' + Core.state.user.name });
        toast('Quotation saved', saved.quotation.number, 'success'); location.hash = '#/sales/quotations';
      };
    } catch (error) { toast('Draft unavailable', error.message, 'error'); }
    finally { button.disabled = !status.configured; button.textContent = 'Generate review draft'; }
  };
});

/* ================= VENDOR BILLING ================= */
Core.route('purchase/billing', async () => {
  const [invoiceData, returnData, paymentData] = await Promise.all([
    Core.get('/v3/purchase/invoices?limit=200'), Core.get('/v3/purchase/returns'),
    Core.can('finance', 'view') ? Core.get('/v3/purchase/payments') : Promise.resolve({ supplierPayments: [] })
  ]);
  const rows = [
    ...invoiceData.purchaseInvoices.map(item => ({ ...item, kind: 'Purchase Invoice', amount: item.totals.grandTotal })),
    ...returnData.purchaseReturns.map(item => ({ ...item, kind: 'Purchase Return', amount: -item.totals.grandTotal })),
    ...paymentData.supplierPayments.map(item => ({ ...item, kind: 'Supplier Payment', amount: -item.amount }))
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Vendor Billing', 'Purchase invoices, purchase returns and supplier payments', `
      ${Core.can('finance', 'create') ? '<button class="btn btn-outline" id="new-supplier-payment">+ Payment</button>' : ''}
      ${Core.can('purchase', 'edit') ? '<button class="btn btn-outline" id="new-purchase-return">+ Return</button>' : ''}
      ${Core.can('purchase', 'create') ? '<button class="btn btn-gold" id="new-purchase-invoice">+ Purchase Invoice</button>' : ''}`)}
    ${Core.table([
      { label: 'Record', render: item => `<b>${Core.esc(item.number)}</b><br><small>${Core.esc(item.kind)}</small>` },
      { label: 'Supplier', key: 'supplierName' },
      { label: 'Date', render: item => Core.fmtDate(item.date) },
      { label: 'Reference', render: item => Core.esc(item.supplierInvoiceNo || item.reference || '-') },
      { label: 'Amount', num: true, render: item => Core.money(item.amount) },
      { label: 'Status', render: item => Core.badge(item.status || 'posted') }
    ], rows, { emptyTitle: 'No vendor billing records', emptyText: 'Post the first purchase invoice.' })}`;
  const invoiceButton = document.getElementById('new-purchase-invoice');
  if (invoiceButton) invoiceButton.onclick = () => Adv.openPurchaseInvoice();
  const payButton = document.getElementById('new-supplier-payment');
  if (payButton) payButton.onclick = async () => {
    const suppliers = (await Core.get('/purchase/suppliers')).suppliers;
    Core.formModal({
      title: 'Record Supplier Payment', fields: [
        { name: 'supplierId', label: 'Supplier', type: 'select', options: suppliers.map(item => ({ value: item.id, label: item.name })), required: true },
        { name: 'date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10), half: true, required: true },
        { name: 'amount', label: 'Amount', type: 'number', step: '0.01', half: true, required: true },
        { name: 'mode', label: 'Mode', type: 'select', options: [{ value: 'bank', label: 'Bank' }, { value: 'cash', label: 'Cash' }], half: true },
        { name: 'reference', label: 'Reference', half: true }
      ], onSubmit: async values => { await Core.post('/v3/purchase/payments', values); toast('Payment recorded', 'Vendor ledger updated', 'success'); Core.render(); }
    });
  };
  const returnButton = document.getElementById('new-purchase-return');
  if (returnButton) returnButton.onclick = async () => {
    const warehouses = (await Core.get('/inventory/warehouses')).warehouses;
    Core.formModal({
      title: 'Post Purchase Return (single line)', fields: [
        { name: 'purchaseInvoiceId', label: 'Purchase invoice', type: 'select', options: invoiceData.purchaseInvoices.map(item => ({ value: item.id, label: item.number + ' · ' + item.supplierName })), required: true },
        { name: 'warehouseId', label: 'Warehouse', type: 'select', options: [{ value: '', label: 'No stock item' }, ...warehouses.map(item => ({ value: item.id, label: item.name }))] },
        { name: 'index', label: 'Line number (first = 0)', type: 'number', value: 0, half: true, required: true },
        { name: 'qty', label: 'Return quantity', type: 'number', step: 'any', half: true, required: true },
        { name: 'reason', label: 'Reason', required: true }
      ], onSubmit: async values => {
        await Core.post('/v3/purchase/returns', { purchaseInvoiceId: values.purchaseInvoiceId, warehouseId: values.warehouseId || null, reason: values.reason, lines: [{ index: values.index, qty: values.qty }] });
        toast('Purchase return posted', 'Stock and payable were adjusted', 'success'); Core.render();
      }
    });
  };
});

/* ================= INVENTORY RESERVATIONS ================= */
Core.route('inventory/reservations', async () => {
  const [reservationData, products, warehouses, categories] = await Promise.all([
    Core.get('/v3/inventory/reservations'), Core.get('/inventory/products'),
    Core.get('/inventory/warehouses'), Core.get('/v3/inventory/categories')
  ]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Stock Reservations', 'Protect committed stock and see true available quantity', `
      ${Core.can('inventory', 'create') ? '<button class="btn btn-outline" id="new-category">+ Category</button>' : ''}
      ${Core.can('inventory', 'edit') ? '<button class="btn btn-gold" id="new-reservation">+ Reservation</button>' : ''}`)}
    <div class="filter-bar"><span class="badge b-neutral">${categories.categories.length} categories</span><span class="badge b-gold">${reservationData.reservations.filter(item => item.status === 'active').length} active reservations</span></div>
    ${Core.table([
      { label: 'Reservation', render: item => `<b>${Core.esc(item.number)}</b><br><small>${Core.esc(item.sourceType)}</small>` },
      { label: 'Product', key: 'productName' }, { label: 'Warehouse', key: 'warehouseName' },
      { label: 'Qty', num: true, key: 'qty' }, { label: 'Expires', render: item => Core.fmtDate(item.expiresOn) },
      { label: 'Status', render: item => Core.badge(item.status) },
      { label: '', render: item => item.status === 'active' && Core.can('inventory', 'edit') ? `<button class="btn btn-outline btn-sm" data-release="${Core.esc(item.id)}">Release</button>` : '' }
    ], reservationData.reservations, { emptyTitle: 'No stock reservations', emptyText: 'Reserve stock against a customer commitment.' })}`;
  const categoryButton = document.getElementById('new-category');
  if (categoryButton) categoryButton.onclick = () => Core.formModal({
    title: 'New Product Category', fields: [{ name: 'name', label: 'Category name', required: true }, { name: 'code', label: 'Code' }],
    onSubmit: async values => { await Core.post('/v3/inventory/categories', values); toast('Category created', values.name, 'success'); Core.render(); }
  });
  const reserveButton = document.getElementById('new-reservation');
  if (reserveButton) reserveButton.onclick = () => Core.formModal({
    title: 'Reserve Stock', fields: [
      { name: 'productId', label: 'Product', type: 'select', options: products.products.filter(item => item.type !== 'service').map(item => ({ value: item.id, label: item.name })), required: true },
      { name: 'warehouseId', label: 'Warehouse', type: 'select', options: warehouses.warehouses.map(item => ({ value: item.id, label: item.name })), required: true },
      { name: 'qty', label: 'Quantity', type: 'number', step: 'any', half: true, required: true },
      { name: 'expiresOn', label: 'Expires on', type: 'date', half: true },
      { name: 'note', label: 'Commitment / note' }
    ], onSubmit: async values => { await Core.post('/v3/inventory/reservations', values); toast('Stock reserved', 'Available quantity recalculated', 'success'); Core.render(); }
  });
  document.querySelectorAll('[data-release]').forEach(button => button.onclick = async () => {
    await Core.patch('/v3/inventory/reservations/' + button.dataset.release + '/release', {}); toast('Reservation released', 'Stock is available again', 'success'); Core.render();
  });
});

/* ================= LEDGERS & STATEMENTS ================= */
Core.route('finance/ledgers', async () => {
  const [balance, cash, accounts, customers, suppliers] = await Promise.all([
    Core.get('/v3/finance/balance-sheet'), Core.get('/v3/finance/cash-flow'),
    Core.get('/finance/accounts'), Core.get('/crm/customers'), Core.get('/purchase/suppliers')
  ]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Ledgers & Statements', 'General ledger, customer/vendor statements, balance sheet and cash flow')}
    <div class="kpi-grid compact-kpis">
      ${Core.kpi('Total assets', Core.money(balance.totals.assets), 'Balance sheet')}
      ${Core.kpi('Liabilities', Core.money(balance.totals.liabilities), 'Balance sheet')}
      ${Core.kpi('Equity + profit', Core.money(balance.totals.equity), 'Balance sheet')}
      ${Core.kpi('Net cash flow', Core.money(cash.totals.net), `${Core.money(cash.totals.inflow)} inflow`, cash.totals.net < 0 ? 'red' : 'green')}
    </div>
    <div class="statement-grid">
      <section class="card card-pad"><div class="section-title"><div><h3>Balance sheet</h3><p>Derived from posted journals</p></div></div>
        ${Core.table([{ label: 'Account', render: item => `${Core.esc(item.code)} · <b>${Core.esc(item.name)}</b>` }, { label: 'Type', key: 'type' }, { label: 'Balance', num: true, render: item => Core.money(item.statementBalance) }], [...balance.assets, ...balance.liabilities, ...balance.equity], { emptyTitle: 'No balances' })}</section>
      <section class="card card-pad"><div class="section-title"><div><h3>Cash flow</h3><p>Cash and bank journal movements</p></div></div>
        ${Core.table([{ label: 'Date', render: item => Core.fmtDate(item.date) }, { label: 'Narration', key: 'narration' }, { label: 'Inflow', num: true, render: item => Core.money(item.inflow) }, { label: 'Outflow', num: true, render: item => Core.money(item.outflow) }], cash.rows.slice(-20).reverse(), { emptyTitle: 'No cash movements' })}</section>
    </div>
    <div class="card card-pad ledger-explorer"><div class="section-title"><div><h3>Ledger explorer</h3><p>Select an account, customer or supplier</p></div></div>
      <div class="ledger-selectors">
        <label class="field"><span>General ledger</span><select id="ledger-account"><option value="">All accounts</option>${accounts.accounts.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.code + ' · ' + item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Customer statement</span><select id="ledger-customer"><option value="">Select customer</option>${customers.customers.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Vendor statement</span><select id="ledger-supplier"><option value="">Select supplier</option>${suppliers.suppliers.map(item => `<option value="${Core.esc(item.id)}">${Core.esc(item.name)}</option>`).join('')}</select></label>
      </div><div id="ledger-results"></div></div>`;
  const resultHost = document.getElementById('ledger-results');
  document.getElementById('ledger-account').onchange = async event => {
    const data = await Core.get('/v3/finance/general-ledger?limit=200' + (event.target.value ? '&accountId=' + encodeURIComponent(event.target.value) : ''));
    resultHost.innerHTML = Core.table([
      { label: 'Date', render: item => Core.fmtDate(item.date) }, { label: 'Journal', key: 'journalNumber' },
      { label: 'Account', render: item => `${Core.esc(item.accountCode)} · ${Core.esc(item.accountName)}` },
      { label: 'Narration', key: 'narration' }, { label: 'Debit', num: true, render: item => Core.money(item.debit) },
      { label: 'Credit', num: true, render: item => Core.money(item.credit) }, { label: 'Balance', num: true, render: item => Core.money(item.runningBalance) }
    ], data.rows, { emptyTitle: 'No ledger entries' });
  };
  document.getElementById('ledger-customer').onchange = async event => {
    if (!event.target.value) return;
    const data = await Core.get('/v3/finance/customer-ledger/' + encodeURIComponent(event.target.value));
    resultHost.innerHTML = `<div class="statement-title"><b>${Core.esc(data.customer.name)}</b><span>Closing ${Core.money(data.closingBalance)}</span></div>` + Core.table([
      { label: 'Date', render: item => Core.fmtDate(item.date) }, { label: 'Type', key: 'type' }, { label: 'Number', key: 'number' },
      { label: 'Debit', num: true, render: item => Core.money(item.debit) }, { label: 'Credit', num: true, render: item => Core.money(item.credit) }, { label: 'Balance', num: true, render: item => Core.money(item.balance) }
    ], data.rows, { emptyTitle: 'No customer entries' });
  };
  document.getElementById('ledger-supplier').onchange = async event => {
    if (!event.target.value) return;
    const data = await Core.get('/v3/purchase/vendor-ledger/' + encodeURIComponent(event.target.value));
    resultHost.innerHTML = `<div class="statement-title"><b>${Core.esc(data.supplier.name)}</b><span>Payable ${Core.money(data.closingBalance)}</span></div>` + Core.table([
      { label: 'Date', render: item => Core.fmtDate(item.date) }, { label: 'Type', key: 'type' }, { label: 'Number', key: 'number' },
      { label: 'Debit', num: true, render: item => Core.money(item.debit) }, { label: 'Credit', num: true, render: item => Core.money(item.credit) }, { label: 'Balance', num: true, render: item => Core.money(item.balance) }
    ], data.rows, { emptyTitle: 'No vendor entries' });
  };
});

/* ================= APPROVAL CENTER ================= */
Core.route('admin/approvals', async () => {
  const [workflows, requests] = await Promise.all([Core.get('/v3/approvals/workflows'), Core.get('/v3/approvals/requests')]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Approval Center', 'Configurable amount thresholds and role-based approval inbox', `
      ${workflows.workflows.length ? '<button class="btn btn-outline" id="new-approval-request">+ Request approval</button>' : ''}
      ${Core.can('admin', 'create') ? '<button class="btn btn-gold" id="new-workflow">+ Workflow</button>' : ''}`)}
    <div class="statement-grid">
      <section><div class="section-title"><div><h3>Pending requests</h3><p>${requests.approvalRequests.filter(item => item.status === 'pending').length} awaiting a decision</p></div></div>
        ${Core.table([
          { label: 'Request', render: item => `<b>${Core.esc(item.number)}</b><br><small>${Core.esc(item.entityType)}</small>` },
          { label: 'Record', key: 'entityNumber' }, { label: 'Amount', num: true, render: item => Core.money(item.amount) },
          { label: 'Role', key: 'approverRole' }, { label: 'Status', render: item => Core.badge(item.status) },
          { label: '', render: item => item.status === 'pending' ? `<div class="actions-cell"><button class="btn btn-outline btn-sm" data-decision="rejected" data-request="${Core.esc(item.id)}">Reject</button><button class="btn btn-gold btn-sm" data-decision="approved" data-request="${Core.esc(item.id)}">Approve</button></div>` : '' }
        ], requests.approvalRequests, { emptyTitle: 'No approval requests' })}</section>
      <aside><div class="section-title"><div><h3>Workflows</h3><p>Rules that route new requests</p></div></div>
        <div class="policy-list">${workflows.workflows.map(item => `<div class="policy-row"><div><b>${Core.esc(item.name)}</b><small>${Core.esc(item.entityType)} · ${Core.money(item.minimumAmount)}+ → ${Core.esc(item.approverRole)}</small></div>${Core.badge(item.active ? 'active' : 'disabled')}</div>`).join('') || '<div class="empty-state"><p>No workflows configured.</p></div>'}</div></aside>
    </div>`;
  const createButton = document.getElementById('new-workflow');
  if (createButton) createButton.onclick = () => Core.formModal({
    title: 'New Approval Workflow', fields: [
      { name: 'name', label: 'Workflow name', required: true },
      { name: 'entityType', label: 'Entity type', type: 'select', options: ['purchase_order', 'expense', 'quotation', 'credit_note'].map(value => ({ value, label: value.replace(/_/g, ' ') })), required: true },
      { name: 'minimumAmount', label: 'Minimum amount', type: 'number', value: 0, half: true },
      { name: 'approverRole', label: 'Approver role', type: 'select', options: ['admin', 'accountant', 'sales_manager', 'purchase_manager'].map(value => ({ value, label: value.replace(/_/g, ' ') })), half: true, required: true }
    ], onSubmit: async values => { await Core.post('/v3/approvals/workflows', values); toast('Workflow created', values.name, 'success'); Core.render(); }
  });
  const requestButton = document.getElementById('new-approval-request');
  if (requestButton) requestButton.onclick = () => Core.formModal({
    title: 'Request Approval', fields: [
      { name: 'workflowId', label: 'Workflow', type: 'select', options: workflows.workflows.filter(item => item.active).map(item => ({ value: item.id, label: item.name })), required: true },
      { name: 'entityType', label: 'Record type', type: 'select', options: ['purchase_order', 'expense', 'quotation', 'credit_note'].map(value => ({ value, label: value.replace(/_/g, ' ') })), half: true, required: true },
      { name: 'entityNumber', label: 'Record number', half: true, required: true },
      { name: 'entityId', label: 'Record ID', required: true, placeholder: 'Copy the record ID from its detail/API' },
      { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true }
    ], onSubmit: async values => { await Core.post('/v3/approvals/requests', values); toast('Approval requested', values.entityNumber, 'success'); Core.render(); }
  });
  document.querySelectorAll('[data-request]').forEach(button => button.onclick = async () => {
    const result = await Core.post('/v3/approvals/requests/' + button.dataset.request + '/decision', { decision: button.dataset.decision });
    toast('Approval updated', result.approvalRequest.status, result.approvalRequest.status === 'approved' ? 'success' : 'error'); Core.render();
  });
});

/* ================= AUTOMATION ================= */
Core.route('admin/automation', async () => {
  const [rules, jobs] = await Promise.all([Core.get('/v3/automation/rules'), Core.get('/v3/automation/jobs?limit=20')]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Automation', 'Idempotent operational rules with visible job history', Core.can('admin', 'create') ? '<button class="btn btn-gold" id="new-rule">+ Automation Rule</button>' : '')}
    <div class="audit-note"><b>Safe execution</b><span>Running the same rule twice on one day reuses the completed job and avoids duplicate notifications.</span></div>
    <div class="automation-grid"><section><div class="policy-list">${rules.automationRules.map(item => `<div class="automation-row">
      <div><b>${Core.esc(item.name)}</b><small>${Core.esc(item.type.replace(/_/g, ' '))} · ${Core.esc(item.schedule)}</small></div>
      <span>${item.lastRunAt ? Core.fmtDate(item.lastRunAt) : 'Never run'}</span>
      <label class="ios-switch"><input type="checkbox" data-rule-toggle="${Core.esc(item.id)}" ${item.active ? 'checked' : ''}><span class="ios-track"></span></label>
      <button class="btn btn-outline btn-sm" data-run-rule="${Core.esc(item.id)}" ${item.active ? '' : 'disabled'}>Run now</button>
    </div>`).join('') || '<div class="empty-state"><p>No automation rules.</p></div>'}</div></section>
    <aside class="card card-pad"><div class="section-title"><div><h3>Recent jobs</h3><p>Execution audit</p></div></div>${Core.table([
      { label: 'Rule', key: 'type' }, { label: 'Status', render: item => Core.badge(item.status) },
      { label: 'Matched', num: true, render: item => item.result ? item.result.matched : '-' }, { label: 'Started', render: item => Core.fmtDate(item.startedAt) }
    ], jobs.backgroundJobs, { emptyTitle: 'No jobs run yet' })}</aside></div>`;
  const newButton = document.getElementById('new-rule');
  if (newButton) newButton.onclick = () => Core.formModal({
    title: 'New Automation Rule', fields: [
      { name: 'name', label: 'Rule name', required: true },
      { name: 'type', label: 'Rule type', type: 'select', options: [
        { value: 'low_stock_alert', label: 'Low stock alert' }, { value: 'overdue_invoice_alert', label: 'Overdue invoice alert' }, { value: 'followup_reminder', label: 'Follow-up reminder' }
      ], required: true },
      { name: 'schedule', label: 'Schedule label', type: 'select', options: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] }
    ], onSubmit: async values => { await Core.post('/v3/automation/rules', values); toast('Rule created', values.name, 'success'); Core.render(); }
  });
  document.querySelectorAll('[data-rule-toggle]').forEach(input => input.onchange = async () => {
    await Core.patch('/v3/automation/rules/' + input.dataset.ruleToggle, { active: input.checked }); toast('Rule updated', input.checked ? 'Enabled' : 'Disabled', 'success'); Core.render();
  });
  document.querySelectorAll('[data-run-rule]').forEach(button => button.onclick = async () => {
    const result = await Core.post('/v3/automation/rules/' + button.dataset.runRule + '/run');
    toast(result.duplicate ? 'Already completed today' : 'Rule completed', `${result.job.result.matched} record(s) matched`, 'success'); Core.render();
  });
});

/* ================= INTEGRATIONS ================= */
Core.route('admin/integrations', async () => {
  const [data, deliveryData, gstData] = await Promise.all([
    Core.get('/integrations/status'),
    Core.get('/integrations/deliveries?limit=30'),
    Core.get('/integrations/gst/submissions?limit=30')
  ]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Live Integrations', 'Brevo, MSG91, Meta WhatsApp and Sandbox GST provider control')}
    <div class="integration-hero">
      <div><span class="eyebrow">PRODUCTION BOUNDARY</span><h2>Send, submit and trace every provider request</h2><p>Secrets stay in Render environment variables. The OS stores masked recipients, provider IDs, delivery state and GST acknowledgements—never API keys.</p></div>
      <div class="integration-legend"><span><i class="dot active"></i>Live verified</span><span><i class="dot configured"></i>Ready to verify</span><span><i class="dot missing"></i>Needs setup</span></div>
    </div>
    <div class="manual-message-strip">
      <div><span class="eyebrow">FREE MANUAL FALLBACK</span><b>No provider credit required</b><p>Open the device SMS app or WhatsApp with a prefilled message. You still review and press Send; the OS does not claim or log automated delivery.</p></div>
      <div><button class="btn btn-outline btn-sm" onclick="Pages.openManualMessage('sms')">Open SMS composer</button><button class="btn btn-gold btn-sm" onclick="Pages.openManualMessage('whatsapp')">Open WhatsApp chat</button></div>
    </div>
    <div class="integration-grid">${data.integrations.map(item => `<article class="integration-card">
      <div class="integration-head"><div><span class="provider-mark">${Core.esc(item.mark)}</span><div><h3>${Core.esc(item.label)}</h3><p>${Core.esc(item.description)}</p></div></div>
      <label class="ios-switch"><input type="checkbox" data-integration="${Core.esc(item.provider)}" ${item.enabled ? 'checked' : ''}><span class="ios-track"></span></label></div>
      <div class="provider-status ${item.active ? 'ready' : (item.configured ? 'configured' : '')}"><span></span>${Core.esc(item.message)}</div>
      <div class="provider-setup"><b>Setup</b><p>${Core.esc(item.setup)}</p>${item.missingEnvironment.length ? `<code>${item.missingEnvironment.map(key => Core.esc(key)).join(' · ')}</code>` : ''}</div>
      <div class="provider-actions">${item.provider === 'gst'
        ? `<button class="btn btn-outline btn-sm" data-provider-test="gst" ${item.configured ? '' : 'disabled'}>Verify GST session</button>`
        : `<button class="btn btn-outline btn-sm" data-provider-test="${Core.esc(item.provider)}" ${item.configured ? '' : 'disabled'}>Send live test</button>`}
        ${item.lastSuccessAt ? `<small>Last success ${Core.fmtDate(item.lastSuccessAt)}</small>` : '<small>No successful request yet</small>'}
      </div>
    </article>`).join('')}</div>
    <div class="integration-history">
      <section><div class="section-title"><div><h3>Message delivery log</h3><p>Recipients are masked; use the provider ID for support and reconciliation.</p></div></div>${Core.table([
        { label: 'Channel', render: item => Core.badge(item.channel) },
        { label: 'Recipient', key: 'recipient' }, { label: 'Reference', key: 'reference' },
        { label: 'Status', render: item => Core.badge(item.status) },
        { label: 'Provider ID', render: item => `<code>${Core.esc(String(item.providerId || '-').slice(0, 32))}</code>` },
        { label: 'Requested', render: item => Core.fmtDate(item.createdAt) }
      ], deliveryData.deliveries, { emptyTitle: 'No provider messages yet', emptyText: 'Run a live test after adding provider credentials.' })}</section>
      <section><div class="section-title"><div><h3>GST submission log</h3><p>IRN and E-Way Bill attempts are immutable operational records.</p></div></div>${Core.table([
        { label: 'Type', render: item => Core.badge(item.type) }, { label: 'Invoice', key: 'invoiceNumber' },
        { label: 'Status', render: item => Core.badge(item.status) },
        { label: 'Acknowledgement', render: item => `<code>${Core.esc(item.irn || item.ewayBillNo || '-')}</code>` },
        { label: 'Submitted', render: item => Core.fmtDate(item.createdAt) }
      ], gstData.submissions, { emptyTitle: 'No GST submissions yet', emptyText: 'Generate an IRN from the GST Invoices screen.' })}</section>
    </div>`;
  document.querySelectorAll('[data-integration]').forEach(input => input.onchange = async () => {
    const result = await Core.patch('/integrations/' + input.dataset.integration, { enabled: input.checked });
    toast('Integration updated', result.integration.status.replace(/_/g, ' '), result.integration.configured ? 'success' : 'info'); Core.render();
  });
  document.querySelectorAll('[data-provider-test]').forEach(button => button.onclick = () => Pages.testIntegration(button.dataset.providerTest));
});

Pages.openManualMessage = channel => Core.formModal({
  title: channel === 'sms' ? 'Free manual SMS composer' : 'Free manual WhatsApp chat',
  fields: [
    { name: 'to', label: 'Mobile with country code *', required: true, placeholder: '+919876543210' },
    { name: 'message', label: 'Message *', type: 'textarea', required: true, value: 'Hello from Tech Defenders.' }
  ],
  submitLabel: channel === 'sms' ? 'Open SMS app' : 'Open WhatsApp',
  onSubmit: async values => {
    let mobile = String(values.to || '').replace(/\D/g, '');
    if (mobile.length === 10) mobile = '91' + mobile;
    if (mobile.length < 11 || mobile.length > 15) throw new Error('Use a valid mobile number with country code');
    const message = encodeURIComponent(String(values.message || '').trim());
    if (channel === 'sms') window.location.href = `sms:+${mobile}?body=${message}`;
    else window.open(`https://wa.me/${mobile}?text=${message}`, '_blank', 'noopener,noreferrer');
    toast('Composer opened', 'Review the recipient and press Send in your device app.', 'success');
  }
});

Pages.testIntegration = provider => {
  if (provider === 'gst') {
    Core.confirm('This will authenticate with Sandbox and the IRP using the GSTIN in Company Settings. No invoice is submitted.', 'Verify GST provider')
      .then(async confirmed => {
        if (!confirmed) return;
        try { await Core.post('/integrations/gst/verify', {}); toast('GST verified', 'Sandbox and IRP session created', 'success'); Core.render(); }
        catch (error) { toast('GST verification failed', error.message, 'error'); }
      });
    return;
  }
  const common = [{ name: 'to', label: provider === 'email' ? 'Recipient email *' : 'Mobile with country code *', required: true }];
  const fields = provider === 'email' ? [
    ...common, { name: 'subject', label: 'Subject *', value: 'Tech Defenders OS live test', required: true },
    { name: 'text', label: 'Message *', type: 'textarea', value: 'This is a live provider test from Tech Defenders OS.', required: true }
  ] : provider === 'sms' ? [
    ...common, { name: 'templateId', label: 'Approved MSG91 Flow template ID *', required: true },
    { name: 'variablesJson', label: 'Template variables (JSON)', type: 'textarea', value: '{"VAR1":"Tech Defenders OS"}' }
  ] : [
    ...common, { name: 'templateName', label: 'Approved Meta template name *', required: true },
    { name: 'language', label: 'Language code *', value: 'en_US', half: true, required: true },
    { name: 'parametersText', label: 'Body parameters (one per line)', type: 'textarea', value: 'Tech Defenders OS' }
  ];
  Core.formModal({
    title: `Live ${provider} test`, fields, submitLabel: 'Send through provider',
    onSubmit: async values => {
      const payload = { ...values, reference: 'integration-live-test' };
      if (provider === 'sms') {
        try { payload.variables = JSON.parse(values.variablesJson || '{}'); } catch (_) { throw new Error('Template variables must be valid JSON'); }
        delete payload.variablesJson;
      }
      if (provider === 'whatsapp') {
        payload.parameters = String(values.parametersText || '').split('\n').map(value => value.trim()).filter(Boolean);
        delete payload.parametersText;
      }
      const result = await Core.post(`/integrations/${provider}/send`, payload);
      toast('Provider accepted request', result.delivery.providerId, 'success'); Core.render();
    }
  });
};

/* ================= BRANCHES ================= */
Core.route('admin/branches', async () => {
  const data = await Core.get('/v3/admin/branches');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Branches', 'Organization-scoped branch and GST registration master', Core.can('admin', 'create') ? '<button class="btn btn-gold" id="new-branch">+ Branch</button>' : '')}
    ${Core.table([
      { label: 'Branch', render: item => `<b>${Core.esc(item.name)}</b><br><small>${Core.esc(item.code || '')}</small>` },
      { label: 'GSTIN', key: 'gstin' }, { label: 'State code', key: 'stateCode' }, { label: 'Address', key: 'address' },
      { label: 'Status', render: item => Core.badge(item.active ? 'active' : 'disabled') },
      { label: '', render: item => Core.can('admin', 'edit') ? `<label class="ios-switch"><input type="checkbox" data-branch="${Core.esc(item.id)}" ${item.active ? 'checked' : ''}><span class="ios-track"></span></label>` : '' }
    ], data.branches, { emptyTitle: 'No branches configured', emptyText: 'Add a branch when the company operates from multiple registrations or locations.' })}`;
  const button = document.getElementById('new-branch');
  if (button) button.onclick = () => Core.formModal({
    title: 'New Branch', fields: [
      { name: 'name', label: 'Branch name', required: true }, { name: 'code', label: 'Code', half: true },
      { name: 'stateCode', label: 'GST state code', half: true, value: Core.state.org.stateCode },
      { name: 'gstin', label: 'GSTIN' }, { name: 'address', label: 'Address', type: 'textarea' }
    ], onSubmit: async values => { await Core.post('/v3/admin/branches', values); toast('Branch created', values.name, 'success'); Core.render(); }
  });
  document.querySelectorAll('[data-branch]').forEach(input => input.onchange = async () => {
    await Core.patch('/v3/admin/branches/' + input.dataset.branch, { active: input.checked }); toast('Branch updated', input.checked ? 'Active' : 'Inactive', 'success'); Core.render();
  });
});

window.Adv = Adv;

/* ============================================================
   Pages: Sales (Quotations/SO/Invoices/Receipts),
          Purchase (PR/RFQ/PO/GRN/Suppliers),
          Inventory (Products/Summary/Ledger)
   ============================================================ */
'use strict';

/* ================= QUOTATIONS ================= */
Core.route('sales/quotations', async () => {
  const d = await Core.get('/sales/quotations');
  const canEdit = Core.can('sales', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Quotations', 'Estimates you send to customers - accept and convert to orders',
      Core.can('sales', 'create') ? '<button class="btn btn-gold" onclick="location.hash=\'#/sales/quotations/new\'">+ New Quotation</button>' : '')}
    ${Core.table([
      { label: 'Number', render: q => `<b>${Core.esc(q.number)}</b>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: q => Core.fmtDate(q.date) },
      { label: 'Valid until', render: q => Core.fmtDate(q.validUntil) },
      { label: 'Total', num: true, render: q => Core.money(q.totals?.grandTotal) },
      { label: 'Status', render: q => Core.badge(q.status) },
      { label: '', render: q => `<div class="actions-cell">
        ${canEdit && ['draft'].includes(q.status) ? `<button class="btn btn-outline btn-sm" onclick="Pages.setQuoteStatus('${q.id}','sent')">Mark sent</button>` : ''}
        ${canEdit && ['draft', 'sent'].includes(q.status) ? `<button class="btn btn-outline btn-sm" onclick="Pages.setQuoteStatus('${q.id}','accepted')">Accept</button>` : ''}
        ${canEdit && q.status === 'accepted' && !q.convertedToId ? `<button class="btn btn-gold btn-sm" onclick="Pages.quoteToSO('${q.id}')">Convert to Order</button>` : ''}
        ${q.convertedToId ? '<span class="badge b-success">converted</span>' : ''}
      </div>` }
    ], d.quotations, { emptyTitle: 'No quotations yet', emptyText: 'Create your first quotation to start Lead-to-Cash.' })}`;
});

Pages.setQuoteStatus = async (id, status) => {
  try { await Core.patch('/sales/quotations/' + id + '/status', { status }); toast('Updated', 'Quotation marked ' + status, 'success'); Core.render(); }
  catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.quoteToSO = async id => {
  const ok = await Core.confirm('Convert this accepted quotation into a confirmed sales order?', 'Convert');
  if (!ok) return;
  try {
    const r = await Core.post('/sales/quotations/' + id + '/convert-sales-order');
    toast('Converted', 'Sales order ' + r.salesOrder.number + ' created', 'success');
    location.hash = '#/sales/orders';
  } catch (e) { toast('Conversion failed', e.message, 'error'); }
};

/* ---- new quotation page with live line editor ---- */
Core.route('sales/quotations/new', async () => {
  if (!Core.can('sales', 'create')) { location.hash = '#/sales/quotations'; return; }
  const custD = await Core.get('/crm/customers');
  Pages._qLines = [];
  Pages._qCust = custD.customers;
  const today = new Date().toISOString().slice(0, 10);

  document.getElementById('content').innerHTML = `
    ${Core.pageHead('New Quotation', 'Enter every item manually; no product catalogue selection is required',
      '<button class="btn btn-outline" onclick="location.hash=\'#/sales/quotations\'">Cancel</button>')}
    <div class="card card-pad document-editor">
      <div class="manual-entry-callout"><b>Manual quotation mode</b><span>Type the description, HSN/SAC, unit, quantity, rate, discount and GST for each line. GST totals are recalculated live and verified again by the server.</span></div>
      <div class="grid-2 document-meta">
        <label class="field"><span>Customer *</span>
          <select id="q-cust" onchange="Pages.salesTotalsPreview('q')">${custD.customers.map(c => `<option value="${c.id}">${Core.esc(c.name)} (${Core.esc(c.stateCode || '-')})</option>`).join('')}</select></label>
        <label class="field"><span>Quotation date</span><input type="date" id="q-date" value="${today}"></label>
        <label class="field"><span>Valid until</span><input type="date" id="q-valid"></label>
        <label class="field"><span>Notes</span><input type="text" id="q-notes" maxlength="2000" placeholder="Commercial terms or delivery notes"></label>
      </div>
      <div class="lines-editor">
        <table class="manual-lines-table"><thead><tr><th>Description *</th><th>HSN / SAC</th><th>Unit</th><th>Qty *</th><th>Rate *</th><th>Disc %</th><th>GST %</th><th></th></tr></thead>
        <tbody id="q-lines"></tbody></table>
        <button class="btn btn-outline btn-sm add-line-btn" onclick="Pages.addSalesLine('q')">+ Add manual line</button>
      </div>
      <div class="totals-box" id="q-totals" style="margin-top:18px"></div>
      <div class="document-actions">
        <button class="btn btn-gold" id="q-save" onclick="Pages.saveQuotation()">Save Quotation</button>
      </div>
    </div>`;
  Pages.addSalesLine('q');
});

Pages.addSalesLine = function (kind) {
  const key = kind === 'inv' ? '_invLines' : '_qLines';
  Pages[key].push({ name: '', hsn: '', uom: 'Nos', qty: 1, rate: 0, discountPct: 0, gstRate: 18 });
  Pages.renderSalesLines(kind);
};

Pages.renderSalesLines = function (kind) {
  const key = kind === 'inv' ? '_invLines' : '_qLines';
  const lines = Pages[key];
  const tbody = document.getElementById(kind + '-lines');
  if (!tbody) return;
  tbody.innerHTML = lines.map((l, i) => `
    <tr>
      <td data-label="Description"><input aria-label="Line ${i + 1} description" maxlength="200" value="${Core.esc(l.name)}" placeholder="Product or service description" oninput="Pages.salesLineChange('${kind}',${i},'name',this.value)"></td>
      <td data-label="HSN / SAC"><input aria-label="Line ${i + 1} HSN or SAC" maxlength="20" value="${Core.esc(l.hsn)}" placeholder="e.g. 998313" oninput="Pages.salesLineChange('${kind}',${i},'hsn',this.value)"></td>
      <td data-label="Unit"><input aria-label="Line ${i + 1} unit" maxlength="20" value="${Core.esc(l.uom)}" placeholder="Nos" oninput="Pages.salesLineChange('${kind}',${i},'uom',this.value)"></td>
      <td data-label="Qty"><input aria-label="Line ${i + 1} quantity" type="number" min="0.01" step="any" value="${l.qty}" oninput="Pages.salesLineChange('${kind}',${i},'qty',this.value)"></td>
      <td data-label="Rate"><input aria-label="Line ${i + 1} rate" type="number" min="0" step="0.01" value="${l.rate}" oninput="Pages.salesLineChange('${kind}',${i},'rate',this.value)"></td>
      <td data-label="Discount %"><input aria-label="Line ${i + 1} discount percentage" type="number" min="0" max="100" step="0.01" value="${l.discountPct}" oninput="Pages.salesLineChange('${kind}',${i},'discountPct',this.value)"></td>
      <td data-label="GST %"><input aria-label="Line ${i + 1} GST percentage" type="number" min="0" max="100" step="0.01" value="${l.gstRate}" oninput="Pages.salesLineChange('${kind}',${i},'gstRate',this.value)"></td>
      <td class="line-remove"><button class="rm" type="button" aria-label="Remove line ${i + 1}" title="Remove line" onclick="Pages.removeSalesLine('${kind}',${i})">&times;</button></td>
    </tr>`).join('');
  Pages.salesTotalsPreview(kind);
};

Pages.salesLineChange = (kind, index, field, value) => {
  const key = kind === 'inv' ? '_invLines' : '_qLines';
  const line = Pages[key][index];
  line[field] = ['name', 'hsn', 'uom'].includes(field) ? value : Number(value);
  Pages.salesTotalsPreview(kind);
};
Pages.removeSalesLine = (kind, index) => {
  const key = kind === 'inv' ? '_invLines' : '_qLines';
  Pages[key].splice(index, 1);
  if (!Pages[key].length) Pages[key].push({ name: '', hsn: '', uom: 'Nos', qty: 1, rate: 0, discountPct: 0, gstRate: 18 });
  Pages.renderSalesLines(kind);
};

Pages.salesTotalsPreview = function (kind) {
  const box = document.getElementById(kind + '-totals');
  if (!box) return;
  let taxable = 0, cg = 0, sg = 0, ig = 0;
  const customers = kind === 'inv' ? Pages._invCust : Pages._qCust;
  const cust = customers.find(c => c.id === document.getElementById(kind + '-cust')?.value);
  const intra = !cust || String(cust.stateCode) === String(Core.state.org.stateCode);
  const lines = kind === 'inv' ? Pages._invLines : Pages._qLines;
  for (const l of lines) {
    const gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
    const t = gross * (1 - (Number(l.discountPct) || 0) / 100);
    taxable += t;
    const tax = t * (Number(l.gstRate) || 0) / 100;
    if (intra) { cg += tax / 2; sg += tax / 2; } else ig += tax;
  }
  const r2 = n => Math.round(n * 100) / 100;
  box.innerHTML = `
    <div class="tr"><span>Taxable value</span><span>${Core.money(r2(taxable))}</span></div>
    ${intra
      ? `<div class="tr"><span>CGST</span><span>${Core.money(r2(cg))}</span></div><div class="tr"><span>SGST</span><span>${Core.money(r2(sg))}</span></div>`
      : `<div class="tr"><span>IGST</span><span>${Core.money(r2(ig))}</span></div>`}
    <div class="tr grand"><span>Grand total</span><span>${Core.money(r2(taxable + cg + sg + ig))}</span></div>`;
};

Pages.saveQuotation = async function () {
  const customerId = document.getElementById('q-cust').value;
  const date = document.getElementById('q-date').value;
  const validUntil = document.getElementById('q-valid').value || null;
  const notes = document.getElementById('q-notes').value;
  const lines = Pages._qLines.filter(l => l.name.trim() && l.qty > 0)
    .map(l => ({ name: l.name.trim(), hsn: l.hsn.trim(), uom: l.uom.trim() || 'Nos', qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate }));
  if (!lines.length) return toast('Check lines', 'Enter a description and quantity for at least one line', 'warning');
  const saveButton = document.getElementById('q-save');
  saveButton.disabled = true;
  try {
    const r = await Core.post('/sales/quotations', { customerId, date, validUntil, notes, lines });
    toast('Created', 'Quotation ' + r.quotation.number + ' saved as draft', 'success');
    location.hash = '#/sales/quotations';
  } catch (e) {
    saveButton.disabled = false;
    toast('Save failed', e.message, 'error');
  }
};

/* ================= SALES ORDERS ================= */
Core.route('sales/orders', async () => {
  const d = await Core.get('/sales/sales-orders');
  const canEdit = Core.can('sales', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Sales Orders', 'Confirmed customer orders - raise GST invoices against remaining quantity',
      Core.can('sales', 'create') ? '<button class="btn btn-gold" onclick="location.hash=\'#/sales/quotations/new\'">+ New (via quotation)</button>' : '')}
    ${Core.table([
      { label: 'Number', render: s => `<b>${Core.esc(s.number)}</b><br><small class="muted">from ${Core.esc(s.sourceType)}</small>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: s => Core.fmtDate(s.date) },
      { label: 'Total', num: true, render: s => Core.money(s.totals?.grandTotal) },
      { label: 'Progress', render: s => {
          const tot = s.lines.reduce((a, l) => a + l.qty, 0);
          const inv = s.lines.reduce((a, l) => a + (l.invoicedQty || 0), 0);
          return `<div class="funnel-track" style="width:110px"><div class="funnel-fill" style="width:${tot ? Math.round(inv / tot * 100) : 0}%"></div></div>
            <small class="muted">${inv}/${tot} invoiced</small>`;
        } },
      { label: 'Status', render: s => Core.badge(s.status) },
      { label: '', render: s => canEdit && !['completed', 'cancelled'].includes(s.status)
        ? `<button class="btn btn-gold btn-sm" onclick="Pages.openInvoiceFromSO('${s.id}')">Create Invoice</button>` : '' }
    ], d.salesOrders, { emptyTitle: 'No sales orders', emptyText: 'Accept a quotation and convert it into an order.' })}`;
});

Pages.openInvoiceFromSO = async soId => {
  const d = await Core.get('/sales/sales-orders');
  const so = d.salesOrders.find(s => s.id === soId);
  const remaining = so.lines.map((l, idx) => ({ idx, name: l.name, qty: l.qty, invoiced: l.invoicedQty || 0 }))
    .filter(l => l.qty > l.invoiced);
  if (!remaining.length) return toast('Nothing to invoice', 'All lines are fully invoiced', 'warning');

  const m = Core.openModal({
    title: 'Create GST invoice from ' + so.number,
    wide: true,
    body: `<form id="inv-form">
      <p class="muted" style="margin-bottom:12px;font-size:13px">Enter the quantity to invoice now (partial invoicing supported).</p>
      <div class="grid-2">${remaining.map(l => `
        <label class="field"><span>${Core.esc(l.name)} <small>(remaining ${l.qty - l.invoiced})</small></span>
        <input type="number" name="qty_${l.idx}" min="0" max="${l.qty - l.invoiced}" step="any" value="${l.qty - l.invoiced}"></label>`).join('')}
      </div></form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="inv-form">Create Invoice</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#inv-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = [];
    for (const [k, v] of fd.entries()) {
      const idx = Number(k.replace('qty_', ''));
      const qty = Number(v);
      if (qty > 0) lines.push({ index: idx, qty });
    }
    try {
      const r = await Core.post('/sales/sales-orders/' + soId + '/invoice', { lines });
      m.close();
      toast('Invoice created', r.invoice.number + ' generated (AMC checked)', 'success');
      location.hash = '#/sales/invoices';
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};

/* ================= INVOICES ================= */
Core.route('sales/invoices/new', async () => {
  if (!Core.can('sales', 'create')) { location.hash = '#/sales/invoices'; return; }
  const custD = await Core.get('/crm/customers');
  Pages._invCust = custD.customers;
  Pages._invLines = [];
  const today = new Date().toISOString().slice(0, 10);
  const firstCustomer = custD.customers[0];
  const dueDate = Pages.invoiceDueDate(today, firstCustomer?.paymentTermsDays);

  document.getElementById('content').innerHTML = `
    ${Core.pageHead('New GST Invoice', 'Create a tax invoice directly without a quotation or Sales Order',
      '<button class="btn btn-outline" onclick="location.hash=\'#/sales/invoices\'">Cancel</button>')}
    <div class="card card-pad document-editor">
      <div class="manual-entry-callout invoice-callout"><b>Direct manual invoice</b><span>Enter item or service lines manually. These manual lines post GST and accounting entries, but do not change inventory stock because they are not linked to catalogue products.</span></div>
      ${custD.customers.length ? `
        <div class="grid-2 document-meta">
          <label class="field"><span>Customer *</span>
            <select id="inv-cust" onchange="Pages.invoiceCustomerChanged()">${custD.customers.map(c => `<option value="${c.id}">${Core.esc(c.name)} (${Core.esc(c.stateCode || '-')})</option>`).join('')}</select></label>
          <label class="field"><span>Invoice date *</span><input type="date" id="inv-date" value="${today}" onchange="Pages.invoiceDateChanged()"></label>
          <label class="field"><span>Due date *</span><input type="date" id="inv-due" value="${dueDate}"></label>
          <label class="field"><span>Notes</span><input type="text" id="inv-notes" maxlength="2000" placeholder="Payment, delivery or reference notes"></label>
        </div>
        <div class="lines-editor">
          <table class="manual-lines-table"><thead><tr><th>Description *</th><th>HSN / SAC</th><th>Unit</th><th>Qty *</th><th>Rate *</th><th>Disc %</th><th>GST %</th><th></th></tr></thead>
          <tbody id="inv-lines"></tbody></table>
          <button class="btn btn-outline btn-sm add-line-btn" onclick="Pages.addSalesLine('inv')">+ Add manual line</button>
        </div>
        <div class="totals-box" id="inv-totals" style="margin-top:18px"></div>
        <div class="document-actions"><button class="btn btn-gold" id="inv-save" onclick="Pages.saveDirectInvoice()">Create GST Invoice</button></div>`
        : `<div class="empty-state"><div class="big">&#9823;</div><h3>Create a customer first</h3><p>A GST invoice needs a billing customer.</p><button class="btn btn-gold" style="margin-top:14px" onclick="location.hash='#/crm/customers'">Open Customers</button></div>`}
    </div>`;
  if (custD.customers.length) Pages.addSalesLine('inv');
});

Pages.invoiceDueDate = (invoiceDate, termsDays) => {
  const date = new Date((invoiceDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + (Number(termsDays) || 30));
  return date.toISOString().slice(0, 10);
};

Pages.invoiceCustomerChanged = () => {
  const customer = Pages._invCust.find(c => c.id === document.getElementById('inv-cust')?.value);
  const invoiceDate = document.getElementById('inv-date')?.value;
  const dueInput = document.getElementById('inv-due');
  if (dueInput) dueInput.value = Pages.invoiceDueDate(invoiceDate, customer?.paymentTermsDays);
  Pages.salesTotalsPreview('inv');
};

Pages.invoiceDateChanged = () => {
  const customer = Pages._invCust.find(c => c.id === document.getElementById('inv-cust')?.value);
  const invoiceDate = document.getElementById('inv-date')?.value;
  const dueInput = document.getElementById('inv-due');
  if (dueInput) dueInput.value = Pages.invoiceDueDate(invoiceDate, customer?.paymentTermsDays);
};

Pages.saveDirectInvoice = async () => {
  const customerId = document.getElementById('inv-cust').value;
  const date = document.getElementById('inv-date').value;
  const dueDate = document.getElementById('inv-due').value;
  const notes = document.getElementById('inv-notes').value;
  const lines = Pages._invLines.filter(line => line.name.trim() && line.qty > 0)
    .map(line => ({
      name: line.name.trim(), hsn: line.hsn.trim(), uom: line.uom.trim() || 'Nos',
      qty: line.qty, rate: line.rate, discountPct: line.discountPct, gstRate: line.gstRate
    }));
  if (!lines.length) return toast('Check lines', 'Enter a description and quantity for at least one line', 'warning');
  if (!date || !dueDate) return toast('Check dates', 'Invoice and due dates are required', 'warning');
  const saveButton = document.getElementById('inv-save');
  saveButton.disabled = true;
  try {
    const result = await Core.post('/sales/invoices', { customerId, date, dueDate, notes, lines });
    toast('Invoice created', result.invoice.number + ' is ready to view or print', 'success');
    location.hash = '#/print/invoice/' + result.invoice.id;
  } catch (error) {
    saveButton.disabled = false;
    toast('Invoice failed', error.message, 'error');
  }
};

Core.route('sales/invoices', async () => {
  const d = await Core.get('/sales/invoices');
  Pages._invoiceRows = d.invoices;
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('GST Invoices', 'Create direct manual invoices or raise them from confirmed Sales Orders',
      Core.can('sales', 'create') ? '<button class="btn btn-gold" onclick="location.hash=\'#/sales/invoices/new\'">+ New Invoice</button>' : '')}
    ${Core.table([
      { label: 'Number', render: i => `<a href="#/print/invoice/${i.id}"><b>${Core.esc(i.number)}</b></a>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: i => Core.fmtDate(i.date) },
      { label: 'Due', render: i => Core.fmtDate(i.dueDate) },
      { label: 'Total', num: true, render: i => Core.money(i.totals?.grandTotal) },
      { label: 'Paid', num: true, render: i => Core.money(i.paidAmount) },
      { label: 'Balance', num: true, render: i => `<b style="color:${i.balanceDue > 0 ? 'var(--danger)' : 'var(--success)'}">${Core.money(i.balanceDue)}</b>` },
      { label: 'Status', render: i => Core.badge(i.status) },
      { label: 'GST network', render: i => i.gstEwayBill?.ewayBillNo || i.gstEinvoice?.ewayBillNo
        ? `<span class="badge b-success">EWB ${Core.esc(i.gstEwayBill?.ewayBillNo || i.gstEinvoice?.ewayBillNo)}</span>`
        : (i.gstEinvoice?.irn ? '<span class="badge b-info">IRN generated</span>' : '<span class="badge b-neutral">Not submitted</span>') },
      { label: '', render: i => `<div class="actions-cell"><a class="btn btn-outline btn-sm" href="#/print/invoice/${i.id}">View / Print</a>
        ${Core.can('sales', 'edit') && !['cancelled', 'credited'].includes(i.status) && !i.gstEinvoice?.irn ? `<button class="btn btn-dark btn-sm" onclick="Pages.generateEinvoice('${i.id}')">Generate IRN</button>` : ''}
        ${Core.can('sales', 'edit') && i.gstEinvoice?.irn && !i.gstEwayBill?.ewayBillNo && !i.gstEinvoice?.ewayBillNo ? `<button class="btn btn-dark btn-sm" onclick="Pages.generateEwayBill('${i.id}')">E-Way Bill</button>` : ''}
        ${Core.can('sales', 'edit') && i.customerEmail ? `<button class="btn btn-ghost btn-sm" onclick="Pages.emailInvoiceById('${Core.esc(i.id)}')">Email</button>` : ''}
        ${Core.can('sales', 'edit') && i.customerPhone ? `<button class="btn btn-ghost btn-sm" onclick="Pages.whatsappInvoiceById('${Core.esc(i.id)}')">WhatsApp API</button><button class="btn btn-ghost btn-sm" onclick="Pages.manualInvoiceWhatsApp('${Core.esc(i.id)}')">Open WhatsApp</button>` : ''}
        ${Core.can('sales', 'edit') && !['cancelled', 'credited'].includes(i.status) ? `<button class="btn btn-ghost btn-sm" onclick="Pages.createCreditNote('${i.id}')">Credit</button>` : ''}
        ${Core.can('sales', 'delete') && !['cancelled', 'credited'].includes(i.status) && !i.paidAmount ? `<button class="btn btn-ghost btn-sm" onclick="Pages.cancelInvoice('${i.id}')">Cancel</button>` : ''}</div>` }
    ], d.invoices, { emptyTitle: 'No invoices yet', emptyText: 'Create a direct manual invoice or raise one from a Sales Order.' })}`;
});

Pages.generateEinvoice = async invoiceId => {
  const confirmed = await Core.confirm('Submit this invoice to the GST Invoice Registration Portal? Customer/company GSTIN, address, pincode and every HSN/SAC must be complete.', 'Generate GST IRN');
  if (!confirmed) return;
  try {
    const result = await Core.post('/integrations/gst/einvoice/' + invoiceId, {});
    toast(result.duplicate ? 'IRN already exists' : 'GST e-Invoice generated', result.submission.irn || 'IRP accepted', 'success');
    Core.render();
  } catch (error) {
    toast('GST submission failed', error.details?.join(' · ') || error.message, 'error');
  }
};

Pages.generateEwayBill = invoiceId => Core.formModal({
  title: 'Generate E-Way Bill',
  fields: [
    { name: 'distance', label: 'Approx. distance (km) *', type: 'number', value: 1, half: true, required: true },
    { name: 'transMode', label: 'Transport mode *', type: 'select', half: true, required: true, options: [
      { value: '1', label: 'Road' }, { value: '2', label: 'Rail' }, { value: '3', label: 'Air' }, { value: '4', label: 'Ship' }
    ] },
    { name: 'vehicleNo', label: 'Vehicle number (required for road)', half: true, placeholder: 'GJ01AB1234' },
    { name: 'vehicleType', label: 'Vehicle type', type: 'select', half: true, options: [{ value: 'R', label: 'Regular' }, { value: 'O', label: 'Over-dimensional cargo' }] },
    { name: 'transporterId', label: 'Transporter GSTIN / TRANSIN', half: true },
    { name: 'transporterName', label: 'Transporter name', half: true },
    { name: 'transportDocumentNo', label: 'Transport document number', half: true },
    { name: 'transportDocumentDate', label: 'Transport document date', type: 'date', half: true }
  ],
  submitLabel: 'Submit E-Way Bill',
  onSubmit: async values => {
    const result = await Core.post('/integrations/gst/ewaybill/' + invoiceId, values);
    toast(result.duplicate ? 'E-Way Bill already exists' : 'E-Way Bill generated', result.submission.ewayBillNo || 'GST provider accepted', 'success');
    Core.render();
  }
});

Pages.emailInvoiceById = id => {
  const item = (Pages._invoiceRows || []).find(invoice => invoice.id === id);
  if (item) Pages.emailInvoice({ id: item.id, number: item.number, to: item.customerEmail, total: item.totals?.grandTotal });
};

Pages.whatsappInvoiceById = id => {
  const item = (Pages._invoiceRows || []).find(invoice => invoice.id === id);
  if (item) Pages.whatsappInvoice({ id: item.id, number: item.number, to: item.customerPhone, total: item.totals?.grandTotal });
};

Pages.manualInvoiceWhatsApp = id => {
  const invoice = (Pages._invoiceRows || []).find(item => item.id === id);
  if (!invoice) return;
  let mobile = String(invoice.customerPhone || '').replace(/\D/g, '');
  if (mobile.length === 10) mobile = '91' + mobile;
  if (mobile.length < 11 || mobile.length > 15) return toast('WhatsApp not opened', 'Customer mobile number is invalid', 'error');
  const message = encodeURIComponent(`Your invoice ${invoice.number} for ${Core.money(invoice.totals?.grandTotal || 0)} is ready. Please contact Tech Defenders for any clarification.`);
  window.open(`https://wa.me/${mobile}?text=${message}`, '_blank', 'noopener,noreferrer');
};

Pages.emailInvoice = invoice => Core.formModal({
  title: `Email ${invoice.number}`,
  fields: [
    { name: 'to', label: 'Recipient email *', value: invoice.to, required: true },
    { name: 'subject', label: 'Subject *', value: `Invoice ${invoice.number} from Tech Defenders`, required: true },
    { name: 'text', label: 'Message *', type: 'textarea', value: `Your invoice ${invoice.number} for ${Core.money(invoice.total)} is ready. Please contact Tech Defenders for the PDF or any clarification.`, required: true }
  ], submitLabel: 'Send via Brevo',
  onSubmit: async values => {
    const result = await Core.post('/integrations/email/send', { ...values, reference: invoice.number, idempotencyKey: `invoice-email:${invoice.id}:${Date.now()}` });
    toast('Email accepted', result.delivery.providerId, 'success');
  }
});

Pages.whatsappInvoice = invoice => Core.formModal({
  title: `WhatsApp ${invoice.number}`,
  fields: [
    { name: 'to', label: 'Mobile with country code *', value: invoice.to, required: true },
    { name: 'templateName', label: 'Approved Meta template name *', required: true, placeholder: 'invoice_ready' },
    { name: 'language', label: 'Language code *', value: 'en_US', half: true, required: true }
  ], submitLabel: 'Send via WhatsApp',
  onSubmit: async values => {
    const result = await Core.post('/integrations/whatsapp/send', { ...values, parameters: [invoice.number, String(invoice.total || 0)], reference: invoice.number, idempotencyKey: `invoice-whatsapp:${invoice.id}:${Date.now()}` });
    toast('WhatsApp accepted', result.delivery.providerId, 'success');
  }
});

Core.route('sales/credit-notes', async () => {
  const data = await Core.get('/sales/credit-notes');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Credit Notes', 'Posted sales reversals with accounting and stock-return entries')}
    ${Core.table([
      { label: 'Credit note', render: note => `<b>${Core.esc(note.number)}</b>` },
      { label: 'Invoice', render: note => Core.esc(note.invoiceNumber) },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: note => Core.fmtDate(note.date) },
      { label: 'Reason', key: 'reason' },
      { label: 'Amount', num: true, render: note => Core.money(note.totals?.grandTotal) },
      { label: 'Status', render: note => Core.badge(note.status) }
    ], data.creditNotes, { emptyTitle: 'No credit notes', emptyText: 'Use Credit on an invoice to post a full reversal.' })}`;
});

Pages.createCreditNote = invoiceId => {
  Core.formModal({
    title: 'Create full credit note',
    fields: [
      { name: 'date', label: 'Credit note date', type: 'date', half: true, value: new Date().toISOString().slice(0, 10) },
      { name: 'reason', label: 'Reason *', type: 'textarea', required: true, placeholder: 'Return, pricing correction, cancellation...' }
    ],
    submitLabel: 'Post Credit Note',
    onSubmit: async values => {
      const result = await Core.post('/sales/credit-notes', { invoiceId, ...values });
      toast('Credit note posted', result.creditNote.number + ' created', 'success');
      location.hash = '#/sales/credit-notes';
    }
  });
};

Pages.cancelInvoice = invoiceId => {
  Core.formModal({
    title: 'Cancel unpaid invoice',
    fields: [{ name: 'reason', label: 'Cancellation reason *', type: 'textarea', required: true }],
    submitLabel: 'Cancel Invoice',
    onSubmit: async values => {
      await Core.post('/sales/invoices/cancel/' + invoiceId, values);
      toast('Invoice cancelled', 'Accounting, stock, order quantities and AMC state were reversed', 'success');
      Core.render();
    }
  });
};

/* ================= RECEIPTS ================= */
Core.route('sales/receipts', async () => {
  const d = await Core.get('/sales/receipts');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Receipts', 'Payments received, allocated across invoices',
      Core.can('sales', 'edit') ? '<button class="btn btn-gold" onclick="Pages.openReceiptForm()">+ Record Receipt</button>' : '')}
    ${Core.table([
      { label: 'Number', render: r => `<b>${Core.esc(r.number)}</b>` },
      { label: 'Customer', key: 'customerName' },
      { label: 'Date', render: r => Core.fmtDate(r.date) },
      { label: 'Amount', num: true, render: r => Core.money(r.amount) },
      { label: 'Mode', render: r => Core.badge(r.mode === 'bank' ? 'confirmed' : r.mode) },
      { label: 'Reference', key: 'reference' },
      { label: 'Allocated to', render: r => (r.allocations || []).length + ' invoice(s)' }
    ], d.receipts, { emptyTitle: 'No receipts yet', emptyText: 'Record payments against outstanding invoices.' })}`;
});

Pages.openReceiptForm = async () => {
  const custD = await Core.get('/crm/customers');
  Core.formModal({
    title: 'Record receipt',
    fields: [
      { name: 'customerId', label: 'Customer *', type: 'select', required: true,
        options: custD.customers.map(c => ({ value: c.id, label: c.name })) },
      { name: 'amount', label: 'Amount received (INR) *', type: 'number', step: '0.01', required: true, half: true },
      { name: 'mode', label: 'Mode', type: 'select', half: true,
        options: ['bank', 'cash', 'upi', 'cheque', 'card'].map(v => ({ value: v, label: v.toUpperCase() })) },
      { name: 'date', label: 'Date', type: 'date', half: true },
      { name: 'reference', label: 'Reference (UTR / cheque no.)', half: true },
      { name: 'note', label: 'Note' }
    ],
    submitLabel: 'Record receipt',
    onSubmit: async v => {
      /* allocate proportionally across the customer's open invoices (oldest first) */
      const cd = await Core.get('/crm/customers/' + v.customerId);
      let left = Number(v.amount);
      const allocations = [];
      const open = cd.invoices
        .filter(i => !['cancelled', 'paid'].includes(i.status))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const inv of open) {
        if (left <= 0) break;
        const due = Math.round(((inv.totals?.grandTotal || 0) - (inv.paidAmount || 0)) * 100) / 100;
        if (due <= 0) continue;
        const amt = Math.min(left, due);
        allocations.push({ invoiceId: inv.id, amount: amt });
        left = Math.round((left - amt) * 100) / 100;
      }
      if (!allocations.length) throw new Error('This customer has no open invoices to allocate against');
      const r = await Core.post('/sales/receipts', { ...v, allocations });
      toast('Receipt recorded', r.receipt.number + ' allocated to ' + allocations.length + ' invoice(s)', 'success');
      Core.render();
    }
  });
};

/* ================= PURCHASE REQUISITIONS ================= */
Core.route('purchase/requisitions', async () => {
  const d = await Core.get('/purchase/requisitions');
  const canApprove = Core.can('purchase', 'approve'), canEdit = Core.can('purchase', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Purchase Requisitions', 'Internal requests with approval before buying',
      Core.can('purchase', 'create') ? '<button class="btn btn-gold" onclick="Pages.openRequisitionForm()">+ New Requisition</button>' : '')}
    ${Core.table([
      { label: 'Number', render: r => `<b>${Core.esc(r.number)}</b><br><small class="muted">${Core.esc(r.department)}</small>` },
      { label: 'Requested by', key: 'requestedByName' },
      { label: 'Items', render: r => r.lines.map(l => `${Core.esc(l.description)} x${l.qty}`).join('<br>') },
      { label: 'Required by', render: r => Core.fmtDate(r.requiredBy) },
      { label: 'Status', render: r => Core.badge(r.status) },
      { label: '', render: r => `<div class="actions-cell">
        ${canApprove && r.status === 'pending_approval' ? `
          <button class="btn btn-outline btn-sm" onclick="Pages.approveReq('${r.id}',true)">Approve</button>
          <button class="btn btn-ghost btn-sm" onclick="Pages.approveReq('${r.id}',false)">Reject</button>` : ''}
        ${canEdit && r.status === 'approved' && !r.rfqId ? `<button class="btn btn-gold btn-sm" onclick="Pages.reqToRFQ('${r.id}')">Send RFQ</button>` : ''}
        ${r.rfqId ? '<span class="badge b-info">rfq raised</span>' : ''}
      </div>` }
    ], d.requisitions, { emptyTitle: 'No requisitions', emptyText: 'Raise internal purchase requests here.' })}`;
});

Pages.approveReq = async (id, approve) => {
  let comment = '';
  if (!approve) {
    comment = prompt('Rejection reason (required):') || '';
    if (!comment.trim()) return toast('Reason required', 'A comment is mandatory when rejecting', 'warning');
  }
  try {
    await Core.post('/purchase/requisitions/' + id + '/approve', { decision: approve ? 'approved' : 'rejected', comment });
    toast(approve ? 'Approved' : 'Rejected', 'Requisition updated', approve ? 'success' : 'warning');
    Core.render();
  } catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.openRequisitionForm = function () {
  Core.formModal({
    title: 'New purchase requisition',
    fields: [
      { name: 'department', label: 'Department', half: true },
      { name: 'requiredBy', label: 'Required by', type: 'date', half: true },
      { name: 'priority', label: 'Priority', type: 'select', half: true, options: ['low', 'normal', 'high'].map(v => ({ value: v, label: v })) },
      { name: 'reason', label: 'Business reason', half: true },
      { name: 'lineDesc', label: 'Item description *', required: true },
      { name: 'lineQty', label: 'Quantity *', type: 'number', required: true, half: true },
      { name: 'lineRate', label: 'Estimated rate', type: 'number', step: '0.01', half: true }
    ],
    submitLabel: 'Submit for approval',
    onSubmit: async v => {
      await Core.post('/purchase/requisitions', {
        department: v.department, requiredBy: v.requiredBy, priority: v.priority, reason: v.reason,
        lines: [{ description: v.lineDesc, qty: v.lineQty, estRate: v.lineRate || 0 }]
      });
      toast('Submitted', 'Requisition sent for approval', 'success');
      Core.render();
    }
  });
};

Pages.reqToRFQ = async reqId => {
  const supD = await Core.get('/purchase/suppliers');
  const m = Core.openModal({
    title: 'Send RFQ to vendors',
    body: `<form id="rfq-form">
      <p class="muted" style="font-size:13px;margin-bottom:10px">Select the suppliers who should quote:</p>
      ${supD.suppliers.map(s => `<label class="check" style="margin-bottom:8px"><input type="checkbox" name="vendor" value="${s.id}"> ${Core.esc(s.name)}</label>`).join('')}
      <label class="field" style="margin-top:12px"><span>Quotes due by</span><input type="date" name="dueDate"></label>
    </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="rfq-form">Send RFQ</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#rfq-form').addEventListener('submit', async e => {
    e.preventDefault();
    const vendorIds = [...m.el.querySelectorAll('input[name="vendor"]:checked')].map(i => i.value);
    if (!vendorIds.length) return toast('Select vendors', 'Choose at least one supplier', 'warning');
    try {
      const r = await Core.post('/purchase/requisitions/' + reqId + '/convert-rfq', { vendorIds, dueDate: new FormData(e.target).get('dueDate') });
      m.close();
      toast('RFQ sent', r.rfq.number + ' created for ' + vendorIds.length + ' vendor(s)', 'success');
      location.hash = '#/purchase/rfqs';
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};

/* ================= RFQs ================= */
Core.route('purchase/rfqs', async () => {
  const d = await Core.get('/purchase/rfqs');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('RFQs & Vendor Quotes', 'Compare quotes side-by-side and award lines to vendors')}
    ${Core.table([
      { label: 'RFQ', render: r => `<b>${Core.esc(r.number)}</b>` },
      { label: 'Vendors', render: r => r.vendors.map(name => Core.esc(name)).join(', ') || '-' },
      { label: 'Lines', num: true, render: r => r.lines.length },
      { label: 'Quotes in', num: true, render: r => r.quoteCount },
      { label: 'Status', render: r => Core.badge(r.status) },
      { label: '', render: r => `<button class="btn btn-outline btn-sm" onclick="Pages.openRFQDetail('${r.id}')">Open comparison</button>` }
    ], d.rfqs, { emptyTitle: 'No RFQs', emptyText: 'Convert an approved requisition into an RFQ.' })}`;
});

Pages.openRFQDetail = async id => {
  const d = await Core.get('/purchase/rfqs/' + id);
  const rfq = d.rfq;
  const canEdit = Core.can('purchase', 'edit');
  const canAward = Core.can('purchase', 'approve');
  const vendors = rfq.vendorIds.map(vid => ({ id: vid, name: (d.comparison[0]?.quotes.find(q => q.vendorName) , '') }));

  /* build vendor list from quotes or vendorIds */
  const vendorNames = {};
  for (const line of d.comparison) for (const q of line.quotes) vendorNames[q.vendorName] = true;

  const cmpRows = d.comparison.map((line, li) => `
    <tr><td><b>${Core.esc(line.description)}</b><br><small class="muted">qty ${line.qty}</small></td>
    ${line.quotes.map((q, qi) => `<td>
      ${q.rate != null ? `${Core.money(q.rate)}<br><small class="muted">+${q.taxPct}% GST &middot; ${q.leadTimeDays ?? '-'}d lead</small>
      ${canAward && rfq.status === 'open' ? `<label class="check" style="margin-top:6px;font-size:11px"><input type="checkbox" data-line="${li}" data-vendor="${qi}"> award</label>` : ''}` : '<span class="muted">no quote</span>'}
    </td>`).join('')}</tr>`).join('');

  const quoteForm = canEdit && rfq.status === 'open' && rfq.vendorIds.length ? `
    <div class="card-head" style="border-top:1px solid var(--line);margin-top:6px"><h3>Record a vendor quote</h3></div>
    <div class="card-pad">
      <form id="quote-form">
        <label class="field"><span>Vendor *</span><select name="vendorId">
          ${rfq.vendorIds.map(vid => `<option value="${vid}">${Core.esc(vendorLabel(vid))}</option>`).join('')}
        </select></label>
        <div class="grid-2">
        ${rfq.lines.map((l, i) => `
          <label class="field"><span>${Core.esc(l.description)} - rate *</span><input type="number" step="any" name="rate_${i}" required></label>
          <label class="field"><span>GST %</span><input type="number" step="any" name="tax_${i}" value="18"></label>`).join('')}
        </div>
        <div class="grid-2">
          <label class="field"><span>Freight (INR)</span><input type="number" step="any" name="freight" value="0"></label>
          <label class="field"><span>Lead time (days)</span><input type="number" name="leadTimeDays" value="7"></label>
        </div>
        <button class="btn btn-dark">Save quote</button>
      </form>
    </div>` : '';

  function vendorLabel(vid) {
    // resolve from any quote or fall back
    for (const line of d.comparison) { const q = line.quotes.find(x => x.vendorName); if (q) break; }
    return Pages._supNames?.[vid] || vid.slice(0, 8);
  }

  const m = Core.openModal({
    title: rfq.number + ' - vendor comparison',
    wide: true,
    body: `
      <div class="meta-grid" style="margin-bottom:14px">
        <div class="meta-item"><span>Status</span><b>${Core.badge(rfq.status)}</b></div>
        <div class="meta-item"><span>Vendors invited</span><b>${rfq.vendorIds.length}</b></div>
        <div class="meta-item"><span>Quotes received</span><b>${(rfq.quotes || []).length}</b></div>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Item</th>${Object.keys(vendorNames).map(v => `<th>${Core.esc(v)}</th>`).join('')}</tr></thead>
        <tbody>${cmpRows}</tbody></table></div>
      ${quoteForm}`,
    footer: canAward && rfq.status === 'open'
      ? `<button class="btn btn-gold" id="award-btn">Award selected lines</button><button class="btn btn-outline" data-cancel>Close</button>`
      : `<button class="btn btn-outline" data-cancel>Close</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;

  /* need supplier names for the quote form */
  Core.get('/purchase/suppliers').then(sd => { Pages._supNames = Object.fromEntries(sd.suppliers.map(s => [s.id, s.name])); }).catch(() => {});

  const qb = m.el.querySelector('#quote-form');
  if (qb) qb.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = rfq.lines.map((_, i) => ({ rate: Number(fd.get('rate_' + i)), taxPct: Number(fd.get('tax_' + i)) }));
    try {
      await Core.post('/purchase/rfqs/' + id + '/quotes', {
        vendorId: fd.get('vendorId'), lines,
        freight: Number(fd.get('freight')) || 0,
        leadTimeDays: Number(fd.get('leadTimeDays')) || 7
      });
      toast('Quote saved', 'Vendor quote recorded', 'success');
      m.close(); Pages.openRFQDetail(id);
    } catch (err) { toast('Failed', err.message, 'error'); }
  });

  const ab = m.el.querySelector('#award-btn');
  if (ab) ab.onclick = async () => {
    const checks = [...m.el.querySelectorAll('input[data-line]:checked')];
    if (!checks.length) return toast('Nothing selected', 'Tick the quotes you want to award', 'warning');
    const byVendor = {};
    for (const c of checks) {
      const li = Number(c.dataset.line), qi = Number(c.dataset.vendor);
      const vendorName = Object.keys(vendorNames)[qi];
      /* map vendor name back to id via quotes */
      const quote = rfq.quotes.find(q => ((Pages._supNames || {})[q.vendorId]) === vendorName);
      const vid = quote ? quote.vendorId : null;
      if (!vid) continue;
      (byVendor[vid] = byVendor[vid] || []).push(li);
    }
    const awards = Object.entries(byVendor).map(([vendorId, lineIndexes]) => ({ vendorId, lineIndexes }));
    try {
      const r = await Core.post('/purchase/rfqs/' + id + '/award', { awards });
      m.close();
      toast('Awarded', r.purchaseOrders.map(p => p.number).join(', ') + ' created', 'success');
      Core.render();
    } catch (err) { toast('Award failed', err.message, 'error'); }
  };
};

/* ================= PURCHASE ORDERS ================= */
Core.route('purchase/orders', async () => {
  const d = await Core.get('/purchase/purchase-orders');
  const canEdit = Core.can('purchase', 'edit');
  const canGRN = Core.can('inventory', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Purchase Orders', 'Orders to suppliers - receive through GRN',
      Core.can('purchase', 'create') ? '<button class="btn btn-gold" onclick="Pages.openPOForm()">+ New PO</button>' : '')}
    ${Core.table([
      { label: 'PO', render: p => `<b>${Core.esc(p.number)}</b><br><small class="muted">${p.rfqId ? 'from RFQ' : 'manual'}</small>` },
      { label: 'Supplier', key: 'supplierName' },
      { label: 'Items', render: p => p.lines.map(l => `${Core.esc(l.description)} x${l.qty}`).join('<br>') },
      { label: 'Value', num: true, render: p => Core.money(p.total) },
      { label: 'Received', render: p => {
          const tot = p.lines.reduce((a, l) => a + l.qty, 0);
          const rec = p.lines.reduce((a, l) => a + (l.receivedQty || 0), 0);
          return `<div class="funnel-track" style="width:100px"><div class="funnel-fill" style="width:${tot ? Math.round(rec / tot * 100) : 0}%"></div></div><small class="muted">${rec}/${tot}</small>`;
        } },
      { label: 'Status', render: p => Core.badge(p.status) },
      { label: '', render: p => `<div class="actions-cell">
        ${canEdit && p.status === 'draft' ? `<button class="btn btn-outline btn-sm" onclick="Pages.setPOStatus('${p.id}','sent')">Send</button>` : ''}
        ${canGRN && ['sent', 'partial'].includes(p.status) ? `<button class="btn btn-gold btn-sm" onclick="Pages.openGRNForm('${p.id}')">Receive (GRN)</button>` : ''}
      </div>` }
    ], d.purchaseOrders, { emptyTitle: 'No purchase orders', emptyText: 'Award an RFQ or create a manual PO.' })}`;
});

Pages.setPOStatus = async (id, status) => {
  try { await Core.patch('/purchase/purchase-orders/' + id + '/status', { status }); toast('Updated', 'PO marked ' + status, 'success'); Core.render(); }
  catch (e) { toast('Failed', e.message, 'error'); }
};

Pages.openPOForm = async () => {
  const supD = await Core.get('/purchase/suppliers');
  Core.formModal({
    title: 'New purchase order',
    fields: [
      { name: 'supplierId', label: 'Supplier *', type: 'select', required: true, options: supD.suppliers.map(s => ({ value: s.id, label: s.name })) },
      { name: 'expectedDate', label: 'Expected delivery', type: 'date', half: true },
      { name: 'notes', label: 'Notes', half: true },
      { name: 'desc', label: 'Item description *', required: true },
      { name: 'qty', label: 'Quantity *', type: 'number', required: true, half: true },
      { name: 'rate', label: 'Rate *', type: 'number', step: '0.01', required: true, half: true },
      { name: 'taxPct', label: 'GST %', type: 'number', value: 18, half: true }
    ],
    submitLabel: 'Create PO',
    onSubmit: async v => {
      const r = await Core.post('/purchase/purchase-orders', {
        supplierId: v.supplierId, expectedDate: v.expectedDate, notes: v.notes,
        lines: [{ description: v.desc, qty: v.qty, rate: v.rate, taxPct: v.taxPct }]
      });
      toast('Created', r.purchaseOrder.number + ' drafted', 'success');
      Core.render();
    }
  });
};

/* ---- GRN ---- */
Core.route('purchase/grns', async () => {
  const d = await Core.get('/purchase/grns');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('GRN - Goods Received', 'Receipts with QC split; accepted quantity updates stock automatically')}
    ${Core.table([
      { label: 'GRN', render: g => `<b>${Core.esc(g.number)}</b>` },
      { label: 'PO', key: 'poNumber' },
      { label: 'Supplier', key: 'supplierName' },
      { label: 'Date', render: g => Core.fmtDate(g.date) },
      { label: 'Lines', render: g => g.lines.map(l => `${Core.esc(l.description)}: acc ${l.acceptedQty}/rej ${l.rejectedQty}`).join('<br>') },
      { label: 'QC', render: g => Core.badge(g.qcStatus) },
      { label: 'Invoice no.', key: 'invoiceNo' }
    ], d.grns, { emptyTitle: 'No GRNs yet', emptyText: 'Receive purchase orders to create GRNs.' })}`;
});

Pages.openGRNForm = async poId => {
  const [poD, prodD] = await Promise.all([Core.get('/purchase/purchase-orders'), Core.get('/inventory/products')]);
  const po = poD.purchaseOrders.find(p => p.id === poId);
  const pending = po.lines.map((l, idx) => ({ idx, ...l })).filter(l => l.qty > (l.receivedQty || 0));
  const m = Core.openModal({
    title: 'Receive goods - ' + po.number,
    wide: true,
    body: `<form id="grn-form">
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Pending</th><th>Received</th><th>Rejected</th><th>Stock product</th><th>Batch</th></tr></thead>
      <tbody>${pending.map(l => `<tr>
        <td>${Core.esc(l.description)}</td><td>${l.qty - (l.receivedQty || 0)}</td>
        <td><input type="number" step="any" name="rec_${l.idx}" value="${l.qty - (l.receivedQty || 0)}" style="width:80px"></td>
        <td><input type="number" step="any" name="rej_${l.idx}" value="0" style="width:70px"></td>
        <td><select name="prod_${l.idx}" style="min-width:170px">
          <option value="">- not tracked -</option>
          ${prodD.products.filter(p => p.type !== 'service').map(p => `<option value="${p.id}" ${p.name.toLowerCase().includes(l.description.toLowerCase().split(' ')[0]) ? 'selected' : ''}>${Core.esc(p.name)}</option>`).join('')}
        </select></td>
        <td><input name="batch_${l.idx}" placeholder="optional" style="width:90px"></td>
      </tr>`).join('')}</tbody></table></div>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>Supplier invoice no.</span><input name="invoiceNo"></label>
        <label class="field"><span>QC result</span><select name="qcStatus"><option value="pass">Pass</option><option value="fail">Fail</option><option value="pending">Pending</option></select></label>
      </div>
    </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancel</button>
             <button class="btn btn-gold" type="submit" form="grn-form">Post GRN & Update Stock</button>`
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#grn-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = pending.map(l => ({
      receivedQty: Number(fd.get('rec_' + l.idx)) || 0,
      rejectedQty: Number(fd.get('rej_' + l.idx)) || 0,
      productId: fd.get('prod_' + l.idx) || null,
      batchNo: fd.get('batch_' + l.idx) || ''
    }));
    try {
      const r = await Core.post('/purchase/grns', { poId, lines, qcStatus: fd.get('qcStatus'), invoiceNo: fd.get('invoiceNo') });
      m.close();
      toast('GRN posted', r.grn.number + ' - stock updated for accepted qty', 'success');
      Core.render();
    } catch (err) { toast('Failed', err.message, 'error'); }
  });
};

/* ================= SUPPLIERS ================= */
Core.route('purchase/suppliers', async () => {
  const d = await Core.get('/purchase/suppliers');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Suppliers', 'Your vendor master',
      Core.can('purchase', 'create') ? '<button class="btn btn-gold" onclick="Pages.openSupplierForm()">+ New Supplier</button>' : '')}
    ${Core.table([
      { label: 'Supplier', render: s => `<b>${Core.esc(s.name)}</b><br><small class="muted">${Core.esc(s.contactPerson || '')}</small>` },
      { label: 'Contact', render: s => `${Core.esc(s.email || '-')}<br><small class="muted">${Core.esc(s.phone || '')}</small>` },
      { label: 'GSTIN', key: 'gstin' },
      { label: 'State code', key: 'stateCode' },
      { label: 'Address', key: 'address' }
    ], d.suppliers, { emptyTitle: 'No suppliers', emptyText: 'Add vendors to send RFQs.' })}`;
});

Pages.openSupplierForm = function () {
  Core.formModal({
    title: 'New supplier',
    fields: [
      { name: 'name', label: 'Supplier name *', required: true },
      { name: 'contactPerson', label: 'Contact person', half: true },
      { name: 'phone', label: 'Phone', half: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'gstin', label: 'GSTIN', half: true },
      { name: 'address', label: 'Address', half: true }
    ],
    submitLabel: 'Create supplier',
    onSubmit: async v => { await Core.post('/purchase/suppliers', v); toast('Created', 'Supplier added', 'success'); Core.render(); }
  });
};

/* ================= PRODUCTS ================= */
Core.route('inventory/products', async () => {
  const d = await Core.get('/inventory/products');
  const canEdit = Core.can('inventory', 'edit');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Products & Services', `${d.products.length} items in your master`,
      Core.can('inventory', 'create') ? '<button class="btn btn-gold" onclick="location.hash=\'#/inventory/products/new\'">+ New Product</button>' : '')}
    ${Core.table([
      { label: 'SKU', render: p => `<b>${Core.esc(p.sku)}</b>` },
      { label: 'Name', render: p => `${Core.esc(p.name)}<br><small class="muted">${Core.esc(p.category)} &middot; HSN ${Core.esc(p.hsn || '-')}</small>` },
      { label: 'Type', render: p => Core.badge(p.type) },
      { label: 'UOM', key: 'uom' },
      { label: 'Purchase', num: true, render: p => Core.money(p.purchasePrice) },
      { label: 'Sale', num: true, render: p => Core.money(p.salePrice) },
      { label: 'Stock', num: true, render: p => {
          if (p.type === 'service') return '<span class="muted">-</span>';
          const tone = p.balance <= 0 ? 'var(--danger)' : p.balance <= p.minStock ? 'var(--warning)' : 'inherit';
          return `<b style="color:${tone}">${p.balance}</b> <small class="muted">(min ${p.minStock})</small>`;
        } },
      { label: 'AMC', render: p => p.amcEligible ? `<span class="badge b-gold">${p.amcMonths}m</span>` : '-' },
      { label: '', render: p => canEdit ? `<div class="actions-cell">
          <button class="btn btn-ghost btn-sm" onclick="Pages.openProductForm('${p.id}')">&#9998;</button>
          ${p.type !== 'service' ? `<button class="btn btn-outline btn-sm" onclick="Pages.openAdjustForm('${p.id}')">Adjust</button>` : ''}
        </div>` : '' }
    ], d.products, { emptyTitle: 'No products', emptyText: 'Add products, raw materials and services.' })}`;
});

Core.route('inventory/products/new', async () => {
  Pages.openProductForm();
  history.replaceState(null, '', '#/inventory/products');
});

Pages.openProductForm = async id => {
  const d = await Core.get('/inventory/products');
  const p = id ? d.products.find(x => x.id === id) : null;
  Core.formModal({
    title: p ? 'Edit product' : 'New product',
    fields: [
      { name: 'sku', label: 'SKU *', required: true, half: true, value: p?.sku },
      { name: 'name', label: 'Name *', required: true, half: true, value: p?.name },
      { name: 'category', label: 'Category', half: true, value: p?.category || 'General' },
      { name: 'type', label: 'Type', type: 'select', half: true, options: ['goods', 'raw', 'finished', 'service'].map(v => ({ value: v, label: v })), value: p?.type || 'goods' },
      { name: 'hsn', label: 'HSN / SAC', half: true, value: p?.hsn },
      { name: 'uom', label: 'UOM', half: true, value: p?.uom || 'Nos' },
      { name: 'gstRate', label: 'GST %', type: 'number', half: true, value: p?.gstRate ?? 18 },
      { name: 'purchasePrice', label: 'Purchase price', type: 'number', step: '0.01', half: true, value: p?.purchasePrice },
      { name: 'salePrice', label: 'Sale price', type: 'number', step: '0.01', half: true, value: p?.salePrice },
      { name: 'minStock', label: 'Min stock / reorder level', type: 'number', half: true, value: p?.minStock },
      { name: 'openingStock', label: 'Opening stock (new items only)', type: 'number', half: true, value: 0 },
      { name: 'amcEligible', label: `AMC eligible (auto-create contract on invoice)`, type: 'checkbox', value: p?.amcEligible },
      { name: 'amcMonths', label: 'AMC duration (months)', type: 'number', half: true, value: p?.amcMonths }
    ],
    submitLabel: p ? 'Save changes' : 'Create product',
    onSubmit: async v => {
      if (p) await Core.patch('/inventory/products/' + p.id, v);
      else await Core.post('/inventory/products', v);
      toast('Saved', p ? 'Product updated' : 'Product created', 'success');
      Core.render();
    }
  });
};

Pages.openAdjustForm = async productId => {
  const whD = await Core.get('/inventory/warehouses');
  Core.formModal({
    title: 'Stock adjustment (reason mandatory)',
    fields: [
      { name: 'warehouseId', label: 'Warehouse', type: 'select', options: whD.warehouses.map(w => ({ value: w.id, label: w.name })) },
      { name: 'qty', label: 'Quantity (+ add / - remove) *', type: 'number', step: 'any', required: true, half: true },
      { name: 'reason', label: 'Reason *', required: true, half: true, placeholder: 'damage count cycle-count etc.' }
    ],
    submitLabel: 'Post adjustment',
    onSubmit: async v => {
      await Core.post('/inventory/adjustments', { ...v, productId });
      toast('Adjusted', 'Ledger entry posted', 'success');
      Core.render();
    }
  });
};

/* ================= STOCK SUMMARY ================= */
Core.route('inventory/summary', async () => {
  const d = await Core.get('/inventory/summary');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Stock Summary', 'Balances per product per warehouse - derived from the ledger')}
    ${Core.table([
      { label: 'SKU', key: 'sku' },
      { label: 'Product', key: 'productName' },
      { label: 'Warehouse', key: 'warehouse' },
      { label: 'Balance', num: true, render: r => `<b>${r.balance}</b> ${Core.esc(r.uom)}` },
      { label: 'Min level', num: true, key: 'minStock' },
      { label: 'Value', num: true, render: r => Core.money(r.value) },
      { label: 'Health', render: r => Core.badge(r.status) }
    ], d.summary, { emptyTitle: 'No stock yet', emptyText: 'Opening stock, GRNs and production output will appear here.' })}`;
});

/* ================= STOCK LEDGER ================= */
Core.route('inventory/ledger', async () => {
  const [ledD, prodD] = await Promise.all([Core.get('/inventory/ledger'), Core.get('/inventory/products')]);
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Stock Ledger', 'Every movement is an immutable event - nothing is overwritten')}
    <div class="filter-bar">
      <select onchange="Pages.filterLedger(this.value)">
        <option value="">All products</option>
        ${prodD.products.map(p => `<option value="${p.id}">${Core.esc(p.name)}</option>`).join('')}
      </select>
    </div>
    <div id="ledger-table"></div>`;
  Pages._ledger = ledD.entries;
  const render = rows => {
    document.getElementById('ledger-table').innerHTML = Core.table([
      { label: 'Date', render: e => Core.fmtDate(e.date) },
      { label: 'Product', key: 'productName' },
      { label: 'Warehouse', key: 'warehouseName' },
      { label: 'Event', render: e => Core.badge(e.type) },
      { label: 'Qty', num: true, render: e => `<b style="color:${e.qty >= 0 ? 'var(--success)' : 'var(--danger)'}">${e.qty > 0 ? '+' : ''}${e.qty}</b>` },
      { label: 'Rate', num: true, render: e => Core.money(e.rate) },
      { label: 'Reference', render: e => Core.esc(e.refNumber || e.note || '-') }
    ], rows, { emptyTitle: 'No ledger entries' });
  };
  render(ledD.entries);
  Pages.filterLedger = pid => render(pid ? ledD.entries.filter(e => e.productId === pid) : ledD.entries);
});

const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let code = fs.readFileSync(file, 'utf8');

// Update sales/quotations list to include view/edit link
code = code.replace(
  /{ label: 'Number', render: q => \`<b>\$\{Core\.esc\(q\.number\)\}<\/b>\` }/g,
  "{ label: 'Number', render: q => `<a href=\"#/sales/quotations/${q.id}\"><b>${Core.esc(q.number)}</b></a>` }"
);

// Update route definition
code = code.replace(
  "Core.route('sales/quotations/new', async () => {",
  "Core.route('sales/quotations/:id', async (p) => {\n  const isNew = p.id === 'new';"
);

// Update logic inside the route
code = code.replace(
  "    Pages._qLines = [];\n    Pages._qCust = custD.customers;\n    const today = new Date().toISOString().slice(0, 10);\n  \n    document.getElementById('content').innerHTML = `\n      ${Core.pageHead('New Quotation', 'Enter every item manually; no product catalogue selection is required',\n        '<button class=\"btn btn-outline\" onclick=\"location.hash=\\'#/sales/quotations\\'\">Cancel</button>')}",
  `    let existing = null;
    let docs = [];
    if (!isNew) {
      const qd = await Core.get('/sales/quotations/' + p.id);
      existing = qd.quotation;
      docs = qd.documents || [];
    }
    Pages._qLines = existing ? existing.lines : [];
    Pages._qCust = custD.customers;
    const today = new Date().toISOString().slice(0, 10);
  
    document.getElementById('content').innerHTML = \`
      \${Core.pageHead(isNew ? 'New Quotation' : 'Edit Quotation ' + existing.number, 'Enter every item manually; no product catalogue selection is required',
        '<button class="btn btn-outline" onclick="location.hash=\\'#/sales/quotations\\'">Cancel</button>' + 
        (!isNew ? \` <a class="btn btn-outline" href="#/print/quotation/\${existing.id}" target="_blank">Print</a>\` : '')
      )}`
);

code = code.replace(
  /id="q-cust" onchange="Pages\.salesTotalsPreview\('q'\)">\$\{custD\.customers\.map\(c => `<option value="\$\{c\.id\}">\$\{Core\.esc\(c\.name\)\} \(\$\{Core\.esc\(c\.stateCode \|\| '-'\)\}\)<\/option>`\)\.join\(''\)\}<\/select>/g,
  `id="q-cust" onchange="Pages.salesTotalsPreview('q')">\${custD.customers.map(c => \`<option value="\${c.id}" \${existing?.customerId===c.id?'selected':''}>\${Core.esc(c.name)} (\${Core.esc(c.stateCode || '-')})</option>\`).join('')}</select>`
);

code = code.replace(
  /id="q-date" value="\$\{today\}"/g,
  `id="q-date" value="\${existing?.date || today}"`
);

code = code.replace(
  /id="q-valid"/g,
  `id="q-valid" value="\${existing?.validUntil || ''}"`
);

code = code.replace(
  /id="q-notes" maxlength="2000" placeholder="Commercial terms or delivery notes"/g,
  `id="q-notes" maxlength="2000" placeholder="Commercial terms or delivery notes" value="\${Core.esc(existing?.notes || '')}"`
);

code = code.replace(
  /Pages\.salesTotalsPreview\('q'\);\n  };\n\n  Pages\.saveQuotation/g,
  `Pages.salesTotalsPreview('q');
  
    if (!isNew) {
      document.getElementById('content').innerHTML += \`<div class="card customer-documents" style="margin-top:16px"><div class="card-head"><div><h3>Attachments</h3><small class="muted">Upload files related to this quotation</small></div>\${Core.can('sales', 'edit') ? \\\`<button class="btn btn-outline btn-sm" onclick="Pages.openQuotationDocForm('\${existing.id}')">Upload document</button>\\\` : ''}</div>
      \${docs.length ? \\\`<div class="document-list">\${docs.map(doc => \\\`<div class="document-item"><span><b>\${Core.esc(doc.title)}</b><small>\${Core.esc((doc.mimeType || '').replace('application/', '').replace('image/', '').toUpperCase())} &middot; \${Core.fmtDate(doc.createdAt)}</small></span><span><a class="btn btn-outline btn-sm" href="/api/sales/documents/\${doc.id}/download" target="_blank">Download</a>\${Core.can('sales', 'edit') ? \\\`<button class="btn btn-ghost btn-sm" onclick="Pages.deleteQuotationDoc('\${doc.id}')">Remove</button>\\\` : ''}</span></div>\\\`).join('')}</div>\\\` : '<div class="empty-state">No documents uploaded yet.</div>'}
      </div>\`;
    }
  };

  Pages.openQuotationDocForm = function (qId) {
    const modal = Core.openModal({ title: 'Upload quotation document', wide: false,
      body: \`<form id="quotation-document-form"><label class="field"><span>Document title *</span><input name="title" required maxlength="120" placeholder="e.g. Terms and Conditions"></label><label class="field"><span>File * (PDF, PNG, JPG or WEBP; max 1.5 MB)</span><input name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></label></form>\`,
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="quotation-document-form">Upload</button>' });
    modal.el.querySelector('[data-cancel]').onclick = modal.close;
    modal.el.querySelector('#quotation-document-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, file = form.file.files[0];
      if (!file) return; if (file.size > 1536 * 1024) return toast('File too large', 'Limit is 1.5 MB', 'error');
      const btn = modal.el.querySelector('[type="submit"]'); btn.disabled = true;
      try {
        const contentData = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        await Core.post('/sales/documents', { entityType: 'quotation', entityId: qId, title: form.title.value, contentData });
        toast('Document uploaded', 'File added successfully', 'success'); modal.close(); Core.render();
      } catch (e) { toast('Upload failed', e.message, 'error'); btn.disabled = false; }
    });
  };
  
  Pages.deleteQuotationDoc = async function (docId) {
    if (!await Core.confirm('Remove this document?', 'Remove')) return;
    try { await Core.del('/sales/documents/' + docId); toast('Removed', 'Document deleted', 'success'); Core.render(); }
    catch (e) { toast('Error', e.message, 'error'); }
  };

  Pages.saveQuotation`
);

code = code.replace(
  /const payload = { customerId, date, validUntil, notes, lines: filtered };\n    await Core\.post\('\/sales\/quotations', payload\);\n    toast\('Quotation saved', 'Redirecting to list', 'success'\);\n    location\.hash = '#\/sales\/quotations';/g,
  `const payload = { customerId, date, validUntil, notes, lines: filtered };
    const hash = window.location.hash;
    const isNew = hash.endsWith('/new');
    if (isNew) {
      await Core.post('/sales/quotations', payload);
      toast('Quotation saved', 'Redirecting to list', 'success');
      location.hash = '#/sales/quotations';
    } else {
      const qId = hash.split('/').pop();
      await Core.patch('/sales/quotations/' + qId, payload);
      toast('Quotation updated', 'Saved successfully', 'success');
      Core.render();
    }`
);

fs.writeFileSync(file, code);

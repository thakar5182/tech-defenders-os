/* Tech Defenders OS v4 · Smart Import, Communication and Automation UI */
'use strict';

window.Pages = window.Pages || {};

const importStatus = value => Core.badge(String(value || '').replace(/_/g, ' '));

const PACKAGE_TARGETS = [
  ['data:customers','CRM · Customers'],['data:leads','CRM · Leads'],['data:products','Inventory · Products'],
  ['data:invoices','Sales · Invoices'],['data:quotations','Sales · Quotations'],['data:payments','Sales · Payments'],
  ['data:expenses','Accounts · Expenses'],['data:suppliers','Purchase · Suppliers'],['data:employees','HR · Employees'],
  ['data:tickets','Service · Tickets'],['data:amc','Service · AMC'],
  ['doc:contracts','Documents · Contracts'],['doc:identity','Documents · Identity / KYC'],['doc:legal','Documents · Legal'],
  ['doc:finance','Documents · Finance'],['doc:projects','Documents · Projects'],['doc:media','Documents · Media'],
  ['doc:technical','Documents · Technical'],['doc:archives','Documents · Archives'],['doc:general','Documents · General'],['doc:restricted','Documents · Restricted']
];
const packageChoice = item => item.kind === 'business-data' ? `data:${item.entity}` : `doc:${item.category || 'general'}`;
const bytesLabel = value => { const units=['B','KB','MB','GB']; let n=Number(value)||0,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++;} return `${n.toFixed(i?1:0)} ${units[i]}`; };

Pages.packageState = { files: [], analysis: [] };

Core.route('data-package', async () => {
  const state = Pages.packageState;
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Data Package Studio', 'Collect any client file, review smart routing and create one Tech Defenders ZIP')}
    <section class="package-hero">
      <div class="package-copy"><span class="eyebrow">CLIENT DATA INTAKE</span><h2>Many files. One controlled handoff.</h2><p>PDF, Excel, CSV, Word, images, video, archives and other file types stay together. Smart detection suggests a destination; you remain in control before the ZIP is created.</p><div class="package-flow"><span>01 Select</span><i></i><span>02 Detect</span><i></i><span>03 Review</span><i></i><span>04 ZIP</span></div></div>
      <label class="package-drop" id="package-drop"><input id="package-files" type="file" multiple><span class="drop-orbit">+</span><b>Drop files here or browse</b><small>Up to 250 files · 25 MB each · 100 MB per package by default</small></label>
    </section>
    <section class="package-client">
      <label class="field"><span>Client / company name</span><input id="package-client-name" value="${Core.esc(state.clientName || '')}" placeholder="Example: Ananta Industries"></label>
      <label class="field"><span>Client reference (optional)</span><input id="package-client-reference" value="${Core.esc(state.clientReference || '')}" placeholder="Example: TD-CLIENT-0042"></label>
      <div class="package-meter"><span id="package-count">${state.files.length} files</span><b id="package-size">${bytesLabel(state.files.reduce((sum,file)=>sum+file.size,0))}</b></div>
    </section>
    <div id="package-workspace">${Pages.packageReviewHtml()}</div>`;

  const input = document.getElementById('package-files'), drop = document.getElementById('package-drop');
  input.onchange = () => Pages.analysePackageFiles([...input.files]);
  ['dragenter','dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave','drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', event => Pages.analysePackageFiles([...event.dataTransfer.files]));
});

Pages.packageReviewHtml = () => {
  const { files, analysis } = Pages.packageState;
  if (!files.length) return `<section class="package-empty"><span>&#8645;</span><h3>Your package workspace is empty</h3><p>Select all client files together. Nothing is sent into business modules until the final ZIP is imported and confirmed.</p></section>`;
  if (!analysis.length) return `<section class="package-empty package-loading"><span></span><h3>Inspecting ${files.length} file(s)…</h3><p>Reading filenames, file types and supported business-data structures.</p></section>`;
  return `<div class="package-review-head"><div><h2>Review destinations</h2><p>Change any suggestion before creating the ZIP.</p></div><button class="btn btn-ghost" onclick="Pages.clearPackage()">Clear all</button></div>
    <div class="package-file-list">${analysis.map((item,index) => `<article class="package-file-row">
      <div class="package-file-icon">${Core.esc((files[index].name.split('.').pop()||'FILE').slice(0,4).toUpperCase())}</div>
      <div class="package-file-meta"><b title="${Core.esc(files[index].name)}">${Core.esc(files[index].name)}</b><span>${bytesLabel(files[index].size)} · ${Core.esc(item.reason)}</span></div>
      <span class="package-confidence ${item.confidence >= .7 ? 'high' : item.confidence >= .55 ? 'medium' : 'low'}">${Math.round(item.confidence*100)}%</span>
      <label><span class="sr-only">Destination for ${Core.esc(files[index].name)}</span><select class="package-target" data-index="${index}">${PACKAGE_TARGETS.map(([value,label])=>`<option value="${value}" ${packageChoice(item)===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <button class="btn btn-ghost btn-sm" aria-label="Remove ${Core.esc(files[index].name)}" onclick="Pages.removePackageFile(${index})">Remove</button>
    </article>`).join('')}</div>
    <div class="package-buildbar"><div><b>Ready to create package</b><span>ZIP includes routing instructions and SHA-256 checksums.</span></div><button class="btn btn-gold" id="build-package" onclick="Pages.buildPackage()">Create Tech Defenders ZIP</button></div>`;
};

Pages.analysePackageFiles = async files => {
  if (!files.length) return;
  Pages.packageState.files = files; Pages.packageState.analysis = [];
  document.getElementById('package-workspace').innerHTML = Pages.packageReviewHtml();
  document.getElementById('package-count').textContent = `${files.length} files`;
  document.getElementById('package-size').textContent = bytesLabel(files.reduce((sum,file)=>sum+file.size,0));
  const body = new FormData(); files.forEach(file => body.append('files', file, file.name));
  try {
    const result = await Core.uploadForm('/ops/packages/classify', body); Pages.packageState.analysis = result.files;
    document.getElementById('package-workspace').innerHTML = Pages.packageReviewHtml();
    toast('Smart routing complete', `${result.files.length} file(s) are ready for review`, 'success');
  } catch (error) { Pages.packageState.files=[]; Pages.packageState.analysis=[]; document.getElementById('package-workspace').innerHTML=Pages.packageReviewHtml(); toast('Files not analyzed', error.message, 'error'); }
};

Pages.removePackageFile = index => {
  Pages.packageState.files.splice(index,1); Pages.packageState.analysis.splice(index,1);
  document.getElementById('package-workspace').innerHTML=Pages.packageReviewHtml();
  document.getElementById('package-count').textContent=`${Pages.packageState.files.length} files`;
  document.getElementById('package-size').textContent=bytesLabel(Pages.packageState.files.reduce((sum,file)=>sum+file.size,0));
};
Pages.clearPackage = () => { Pages.packageState={files:[],analysis:[]}; Core.render(); };

Pages.buildPackage = async () => {
  const state=Pages.packageState, button=document.getElementById('build-package'); if(!state.files.length||!button)return;
  const assignments=[...document.querySelectorAll('.package-target')].map(select=>{const [kind,value]=select.value.split(':');return kind==='data'?{kind:'business-data',entity:value}:{kind:'document',category:value};});
  state.clientName=document.getElementById('package-client-name').value.trim(); state.clientReference=document.getElementById('package-client-reference').value.trim();
  const body=new FormData(); state.files.forEach(file=>body.append('files',file,file.name)); body.append('assignments',JSON.stringify(assignments)); body.append('clientName',state.clientName); body.append('clientReference',state.clientReference);
  button.disabled=true; button.textContent='Creating verified ZIP…';
  try {
    const response=await fetch('/api/ops/packages/build',{method:'POST',credentials:'same-origin',body});
    if(!response.ok){let detail={};try{detail=await response.json();}catch(_){}throw new Error(detail.error||`Package creation failed (${response.status})`);}
    const blob=await response.blob(), url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=`Tech-Defenders-Data-Package-${new Date().toISOString().slice(0,10)}.zip`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('ZIP package created','Upload it in Smart Data Import when you are ready','success'); button.textContent='ZIP Downloaded';
  } catch(error){button.disabled=false;button.textContent='Create Tech Defenders ZIP';toast('ZIP not created',error.message,'error');}
};

Core.route('client-documents', async () => {
  const data=await Core.get('/ops/documents');
  const categories=[...new Set(data.documents.map(item=>item.category))];
  document.getElementById('content').innerHTML=`${Core.pageHead('Client Documents','Files imported from verified Tech Defenders data packages',`<a class="btn btn-gold" href="#/data-package">Create Package</a>`)}
    <div class="grid-kpi">${Core.kpi('Documents',data.documents.length,'stored in this workspace')}${Core.kpi('Clients',new Set(data.documents.map(item=>item.clientName).filter(Boolean)).size,'linked by package')}${Core.kpi('Categories',categories.length,'organized automatically')}${Core.kpi('Restricted',data.documents.filter(item=>item.restricted).length,'download-only quarantine',data.documents.some(item=>item.restricted)?'k-gold':'')}</div>
    ${Core.table([{label:'Document',render:item=>`<b>${Core.esc(item.filename)}</b><small class="subline">${bytesLabel(item.size)} · ${Core.esc(item.type||'file')}</small>`},{label:'Client',render:item=>`<b>${Core.esc(item.clientName||'Unassigned')}</b><small class="subline">${Core.esc(item.clientReference||'')}</small>`},{label:'Category',render:item=>Core.badge(item.category)},{label:'Imported',render:item=>Core.fmtDate(item.createdAt)},{label:'',render:item=>`<a class="btn btn-outline btn-sm" href="/api/ops/documents/${item.id}/download">Download</a>`}],data.documents,{emptyTitle:'No client documents yet',emptyText:'Create a data package, import it and confirm the review to populate this library.'})}`;
});

Core.route('data-import', async () => {
  const data = await Core.get('/ops/imports');
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Smart Data Import', 'Securely detect, map, validate and migrate previous business data', '<a class="btn btn-outline" href="#/data-package">Create Data Package</a>')}
    <section class="import-hero">
      <div><span class="eyebrow">CONTROLLED MIGRATION</span><h2>Bring your business history with confidence</h2><p>ZIP, CSV, XLSX, XLS, JSON, PDF and XML are inspected locally on the server. Nothing is imported until you review and confirm.</p></div>
      <form id="smart-import-form" class="import-drop">
        <input id="smart-import-file" name="file" type="file" accept=".zip,.csv,.xlsx,.xls,.json,.pdf,.xml" required>
        <label for="smart-import-file"><b>Choose business data</b><span>Maximum size follows server safety limits</span></label>
        <button class="btn btn-gold" type="submit">Analyze file</button>
      </form>
    </section>
    <div class="section-title"><div><h2>Import history</h2><p>Every upload, warning, result and rollback remains auditable.</p></div></div>
    ${Core.table([
      { label: 'Import', render: item => `<a href="#/data-import/${item.id}"><b>${Core.esc(item.number)}</b><small class="subline">${Core.esc(item.filename)}</small></a>` },
      { label: 'Uploaded', render: item => Core.fmtDate(item.createdAt) },
      { label: 'Records', num: true, render: item => item.summary?.records ?? '-' },
      { label: 'Valid', num: true, render: item => item.summary?.valid ?? '-' },
      { label: 'Warnings', num: true, render: item => item.summary?.warnings ?? '-' },
      { label: 'Status', render: item => importStatus(item.status) },
      { label: '', render: item => `<a class="btn btn-outline btn-sm" href="#/data-import/${item.id}">Review</a>` }
    ], data.imports, { emptyTitle: 'No imports yet', emptyText: 'Upload a supported file to create your first controlled import.' })}`;

  document.getElementById('smart-import-form').addEventListener('submit', async event => {
    event.preventDefault(); const file = document.getElementById('smart-import-file').files[0]; if (!file) return;
    const button = event.target.querySelector('button'); button.disabled = true; button.textContent = 'Analyzing safely…';
    try { const result = await Core.upload('/ops/imports', file); toast('Analysis complete', `${result.import.summary?.records || 0} records detected`, 'success'); location.hash = '#/data-import/' + result.import.id; }
    catch (error) { toast('Import analysis failed', error.message, 'error'); button.disabled = false; button.textContent = 'Analyze file'; }
  });
});

Core.route('data-import/:id', async params => {
  const data = await Core.get('/ops/imports/' + params.id + '?limit=500'); const job = data.import; const summary = job.summary || {};
  document.getElementById('content').innerHTML = `
    ${Core.pageHead(`Import ${job.number}`, job.filename, `<a class="btn btn-outline" href="#/data-import">Back</a>${summary.errors ? `<a class="btn btn-outline" href="/api/ops/imports/${job.id}/errors.csv">Download Error Report</a>` : ''}`)}
    <div class="grid-kpi">
      ${Core.kpi('Detected', summary.records || 0, `${summary.files || 0} file(s) · ${summary.documents || 0} document(s)`)}
      ${Core.kpi('Valid', summary.valid || 0, 'ready to import', 'k-success')}
      ${Core.kpi('Warnings', summary.warnings || 0, `${summary.duplicates || 0} duplicates`, summary.warnings ? 'k-gold' : '')}
      ${Core.kpi('Errors', summary.errors || 0, 'must be fixed or skipped', summary.errors ? 'k-danger' : '')}
    </div>
    <section class="card card-pad import-progress"><div class="import-steps"><span class="done">1 Upload</span><span class="done">2 Detect</span><span class="done">3 Map</span><span class="${['completed','completed_with_warnings','rolled_back'].includes(job.status) ? 'done' : 'active'}">4 Confirm</span><span class="${['completed','completed_with_warnings'].includes(job.status) ? 'done' : ''}">5 Complete</span></div></section>
    <div class="section-title"><div><h2>Detected categories</h2><p>Inspect validity before any production record is changed.</p></div></div>
    <div class="category-grid">${(summary.categories || []).map(category => `<article class="category-summary"><b>${Core.esc(category.label)}</b><strong>${category.detected}</strong><span>${category.valid} valid · ${category.duplicates} duplicates</span><small>${category.errors} errors · ${category.warnings} warnings</small></article>`).join('') || '<div class="card card-pad">No importable categories were detected.</div>'}</div>
    <div class="section-title"><div><h2>Column mapping</h2><p>Low-confidence fields stay unaccepted until you approve or change them.</p></div></div>
    <div class="mapping-list">${data.mappings.map(mapping => Pages.importMappingCard(mapping)).join('')}</div>
    <div class="section-title"><div><h2>Record preview</h2><p>Duplicate rows default to Skip. Choose Merge or Keep Both explicitly.</p></div></div>
    ${Core.table([
      { label: 'Row', key: 'rowNumber' }, { label: 'Type', render: item => Core.esc(importsLabel(item.entity)) },
      { label: 'Preview', render: item => `<b>${Core.esc(item.mapped.name || item.mapped.number || item.mapped.subject || item.mapped.description || '-')}</b><small class="subline">${Core.esc(item.mapped.email || item.mapped.phone || item.mapped.customer || '')}</small>` },
      { label: 'Validation', render: item => item.valid ? (item.warnings.length ? `<span class="badge b-warning">${item.warnings.length} warning</span>` : '<span class="badge b-success">Valid</span>') : `<span class="badge b-danger">${item.errors.length} error</span>` },
      { label: 'Decision', render: item => item.duplicateId ? `<select class="decision-select" data-record="${item.id}"><option value="skip">Skip duplicate</option><option value="merge">Merge</option><option value="keep">Keep both</option></select>` : (item.valid ? '<span class="badge b-success">Import</span>' : '<span class="badge b-neutral">Skip</span>') }
    ], data.records, { emptyTitle: 'No preview records' })}
    <div class="import-actionbar">
      <div><b>${importStatus(job.status)}</b><span>${job.importSummary ? `${job.importSummary.imported} imported · ${job.importSummary.skipped} skipped` : 'No record changes have been made yet.'}</span></div>
      <div>${['ready','ready_with_errors'].includes(job.status) ? `<button class="btn btn-outline" onclick="Pages.cancelImport('${job.id}')">Cancel</button><button class="btn btn-gold" onclick="Pages.confirmImport('${job.id}')">Confirm Import</button>` : ''}${['completed','completed_with_warnings'].includes(job.status) && !job.rolledBackAt ? `<button class="btn btn-danger" onclick="Pages.rollbackImport('${job.id}')">Rollback Import</button>` : ''}</div>
    </div>`;
});

function importsLabel(entity) { return ({ customers: 'Customers', leads: 'Leads', products: 'Products', invoices: 'Invoices', quotations: 'Quotations', payments: 'Payments', expenses: 'Expenses', suppliers: 'Suppliers', employees: 'Employees', tickets: 'Service', amc: 'AMC' })[entity] || entity; }

Pages.importMappingCard = mapping => {
  const fields = Object.keys((window.TD_IMPORT_FIELDS || {})[mapping.entity] || {});
  return `<article class="card mapping-card"><div class="card-head"><div><h3>${Core.esc(mapping.entity === 'unknown' ? 'Unrecognized data' : importsLabel(mapping.entity))}</h3><small class="muted">${mapping.columns.length} columns</small></div><button class="btn btn-outline btn-sm" onclick="Pages.saveImportMapping('${mapping.id}')">Save mapping</button></div><div class="mapping-grid" data-mapping="${mapping.id}" data-entity="${mapping.entity}">${mapping.columns.map(column => `<label><span>${Core.esc(column.column)}</span><select data-column="${Core.esc(column.column)}"><option value="">Ignore column</option>${fields.map(field => `<option value="${field}" ${column.field === field ? 'selected' : ''}>${Core.esc(field)}</option>`).join('')}</select><small class="${column.accepted ? 'confidence-ok' : 'confidence-low'}">${Math.round(column.confidence * 100)}% confidence</small></label>`).join('')}</div></article>`;
};

// Kept client-side so changing the detected entity can be added without a bundle rebuild.
window.TD_IMPORT_FIELDS = {
  customers: { name:1, phone:1, email:1, gstin:1, address:1, stateCode:1, contactPerson:1, creditLimit:1, paymentTermsDays:1 },
  leads: { name:1, company:1, phone:1, email:1, source:1, status:1, value:1, productInterest:1 },
  products: { name:1, sku:1, hsn:1, quantity:1, purchasePrice:1, salePrice:1, gstRate:1, minStock:1, uom:1, category:1, type:1 },
  invoices: { number:1, date:1, customer:1, gstin:1, subtotal:1, gst:1, total:1, paidAmount:1, paymentStatus:1, dueDate:1, notes:1 },
  quotations: { number:1, date:1, customer:1, subtotal:1, gst:1, total:1, status:1, validUntil:1, notes:1 },
  payments: { number:1, date:1, customer:1, invoiceNumber:1, amount:1, mode:1, reference:1 },
  expenses: { date:1, number:1, category:1, description:1, amount:1, vendor:1, mode:1, status:1 },
  suppliers: { name:1, phone:1, email:1, gstin:1, address:1, paymentTermsDays:1 }, employees: { name:1, email:1, phone:1, department:1, designation:1, joiningDate:1, salary:1 },
  tickets: { number:1, customer:1, subject:1, status:1, priority:1, date:1, description:1 }, amc: { number:1, customer:1, asset:1, startDate:1, endDate:1, value:1, status:1, visitsAllowed:1 }
};

Pages.saveImportMapping = async id => {
  const root = document.querySelector(`[data-mapping="${id}"]`); if (!root) return;
  const columns = [...root.querySelectorAll('[data-column]')].map(select => ({ column: select.dataset.column, field: select.value || null, accepted: true }));
  try { await Core.patch('/ops/imports/' + location.hash.split('/').pop() + '/mappings', { mappingId: id, entity: root.dataset.entity, columns }); toast('Mapping saved', 'Preview has been revalidated', 'success'); Core.render(); }
  catch (error) { toast('Mapping not saved', error.message, 'error'); }
};

Pages.confirmImport = async id => {
  const decisions = {}; document.querySelectorAll('.decision-select').forEach(select => { decisions[select.dataset.record] = select.value; });
  const allow = await Core.confirm('Import all valid rows? Missing customer references may be created as basic customer records. Existing duplicates are handled using your selected decision.', 'Confirm production import');
  if (!allow) return;
  try { const result = await Core.post(`/ops/imports/${id}/confirm`, { decisions, createMissingReferences: true }); toast('Import completed', `${result.import.importSummary.imported} records imported`, result.import.importSummary.failed ? 'warning' : 'success'); Core.render(); }
  catch (error) { toast('Import failed', error.message, 'error'); }
};
Pages.cancelImport = async id => { if (await Core.confirm('Cancel this import without changing business data?')) { await Core.post(`/ops/imports/${id}/cancel`, {}); Core.render(); } };
Pages.rollbackImport = async id => { if (await Core.confirm('Remove records created by this import and restore merged records? This action is audited.', 'Rollback import')) { try { await Core.post(`/ops/imports/${id}/rollback`, {}); toast('Import rolled back', 'Imported changes were reversed', 'success'); Core.render(); } catch (error) { toast('Rollback stopped', error.message, 'error'); } } };

Core.route('communication/email', async () => {
  const [templateData, customerData, campaignData] = await Promise.all([Core.get('/ops/email/templates'), Core.get('/crm/customers'), Core.get('/ops/email/campaigns')]);
  Pages._emailTemplates = templateData.templates; Pages._emailCustomers = customerData.customers;
  document.getElementById('content').innerHTML = `
    ${Core.pageHead('Email Center', 'Transactional email, bulk campaigns, templates, scheduling and retry queues', `<button class="btn btn-outline" onclick="Pages.newEmailTemplate()">New Template</button><button class="btn btn-gold" onclick="Pages.newEmailCampaign()">Send Email</button>`)}
    <div class="grid-kpi">${Core.kpi('Templates', templateData.templates.length, 'reusable messages')}${Core.kpi('Campaigns', campaignData.campaigns.length, 'individual and bulk')}${Core.kpi('Queue', campaignData.queue.filter(item => ['queued','retry','sending'].includes(item.status)).length, 'waiting or retrying')}${Core.kpi('Failed', campaignData.queue.filter(item => item.status === 'failed').length, 'manual retry available', campaignData.queue.some(item => item.status === 'failed') ? 'k-danger' : '')}</div>
    <div class="grid-2col">
      <section><div class="section-title"><div><h2>Campaign history</h2><p>Queued work is rate-controlled and retried with backoff.</p></div></div>${Core.table([
        { label: 'Campaign', render: item => `<b>${Core.esc(item.name)}</b><small class="subline">${Core.esc(item.number)}</small>` }, { label: 'Type', render: item => Core.badge(item.type) },
        { label: 'Total', num: true, key: 'total' }, { label: 'Sent', num: true, key: 'sent' }, { label: 'Failed', num: true, key: 'failed' }, { label: 'Status', render: item => Core.badge(item.status) }
      ], campaignData.campaigns, { emptyTitle: 'No email campaigns' })}</section>
      <aside><div class="section-title"><div><h2>Templates</h2><p>Variables are filled per customer or invoice.</p></div></div>${templateData.templates.length ? `<div class="template-list">${templateData.templates.map(item => `<article class="card card-pad"><div class="row-split"><b>${Core.esc(item.name)}</b>${Core.badge(item.type)}</div><strong>${Core.esc(item.subject)}</strong><p>${Core.esc(item.body).slice(0,140)}</p></article>`).join('')}</div>` : '<div class="card card-pad"><div class="empty-state">Create a template to standardize communication.</div></div>'}</aside>
    </div>
    <div class="section-title"><div><h2>Failed jobs</h2><p>Recipient addresses are masked in operational views.</p></div></div>
    ${Core.table([{ label:'Recipient', key:'to' }, { label:'Status', render:item=>Core.badge(item.status) }, { label:'Attempts', key:'attempts' }, { label:'Error', key:'error' }, { label:'', render:item=>item.status==='failed'?`<button class="btn btn-outline btn-sm" onclick="Pages.retryEmail('${item.id}')">Retry</button>`:'' }], campaignData.queue.filter(item => item.status === 'failed'), { emptyTitle: 'No failed email jobs' })}`;
});

Pages.newEmailTemplate = () => Core.formModal({ title: 'New email template', fields: [
  { name:'name', label:'Template name *', required:true }, { name:'type', label:'Type', type:'select', options:[{value:'transactional',label:'Transactional'},{value:'marketing',label:'Marketing'}] },
  { name:'subject', label:'Subject *', required:true, placeholder:'Invoice {{invoice_number}} from {{company_name}}' }, { name:'body', label:'Message *', type:'textarea', required:true, placeholder:'Hello {{customer_name}}, ...' }
], submitLabel:'Create Template', onSubmit: async values => { await Core.post('/ops/email/templates', values); toast('Template created', 'Ready for campaigns', 'success'); Core.render(); } });

Pages.newEmailCampaign = () => {
  const templates = Pages._emailTemplates || [], customers = (Pages._emailCustomers || []).filter(item => item.email);
  const modal = Core.openModal({ title:'Send individual or bulk email', wide:true, body:`<form id="campaign-form"><div class="grid-2"><label class="field"><span>Template</span><select name="templateId"><option value="">Custom message</option>${templates.map(item=>`<option value="${item.id}">${Core.esc(item.name)}</option>`).join('')}</select></label><label class="field"><span>Type</span><select name="type"><option value="transactional">Transactional</option><option value="marketing">Marketing</option></select></label><label class="field" style="grid-column:1/-1"><span>Subject *</span><input name="subject" required></label><label class="field" style="grid-column:1/-1"><span>Message *</span><textarea name="body" rows="6" required></textarea></label><label class="field"><span>Schedule (optional)</span><input type="datetime-local" name="scheduledAt"></label><label class="check"><input type="checkbox" name="attachInvoice"> Attach selected invoice PDF (requires invoice ID via API)</label></div><div class="recipient-picker"><div class="row-split"><b>Recipients</b><button type="button" class="btn btn-ghost btn-sm" data-select-all>Select all</button></div>${customers.map(item=>`<label class="check"><input type="checkbox" name="customerId" value="${item.id}"><span><b>${Core.esc(item.name)}</b><small>${Core.esc(item.email)}</small></span></label>`).join('') || '<p class="muted">No customers with email addresses.</p>'}</div></form>`, footer:'<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="campaign-form">Queue Email</button>' });
  modal.el.querySelector('[data-cancel]').onclick = modal.close;
  modal.el.querySelector('[data-select-all]').onclick = () => modal.el.querySelectorAll('[name="customerId"]').forEach(input => { input.checked = true; });
  const templateSelect = modal.el.querySelector('[name="templateId"]'); templateSelect.onchange = () => { const template = templates.find(item=>item.id===templateSelect.value); if (template) { modal.el.querySelector('[name="subject"]').value=template.subject; modal.el.querySelector('[name="body"]').value=template.body; modal.el.querySelector('[name="type"]').value=template.type; } };
  modal.el.querySelector('#campaign-form').onsubmit = async event => { event.preventDefault(); const fd=new FormData(event.target), customerIds=fd.getAll('customerId'); if(!customerIds.length)return toast('Select recipients','Choose at least one customer','error'); const button=modal.el.querySelector('[type="submit"]');button.disabled=true;try{await Core.post('/ops/email/send',{customerIds,templateId:fd.get('templateId')||null,type:fd.get('type'),subject:fd.get('subject'),body:fd.get('body'),scheduledAt:fd.get('scheduledAt')?new Date(fd.get('scheduledAt')).toISOString():null,attachInvoice:fd.get('attachInvoice')==='on'});modal.close();toast('Email queued',`${customerIds.length} recipient(s) added`,'success');Core.render();}catch(error){button.disabled=false;toast('Email not queued',error.message,'error');} };
};
Pages.retryEmail = async id => { await Core.post(`/ops/email/jobs/${id}/retry`, {}); toast('Retry queued', 'The worker will try again', 'success'); Core.render(); };

Core.route('communication/history', async () => {
  const data = await Core.get('/ops/communications');
  document.getElementById('content').innerHTML = `${Core.pageHead('Communication History', 'Customer email, WhatsApp, invoices and automated contact in one timeline')}${Core.table([
    {label:'Time',render:item=>Core.fmtDate(item.createdAt)}, {label:'Channel',render:item=>Core.badge(item.channel)}, {label:'Type',key:'messageType'}, {label:'Status',render:item=>Core.badge(item.status)}, {label:'Initiated by',render:item=>item.initiatedBy===Core.state.user.id?'You':Core.esc(item.initiatedBy||'System')}
  ], data.communications, {emptyTitle:'No communication recorded'})}`;
});

Core.route('communication/analytics', async () => {
  const { analytics:a } = await Core.get('/ops/analytics');
  document.getElementById('content').innerHTML = `${Core.pageHead('Communication & Automation Analytics','Operational delivery figures from real provider and worker records')}<div class="grid-kpi">${Core.kpi('Emails Sent',a.emailsSent)}${Core.kpi('Emails Delivered',a.emailsDelivered,'provider confirmed','k-success')}${Core.kpi('Emails Failed',a.emailsFailed,'needs attention',a.emailsFailed?'k-danger':'')}${Core.kpi('WhatsApp Sent',a.whatsappSent)}${Core.kpi('WhatsApp Delivered',a.whatsappDelivered,'provider confirmed','k-success')}${Core.kpi('WhatsApp Read',a.whatsappRead)}${Core.kpi('WhatsApp Failed',a.whatsappFailed,'needs attention',a.whatsappFailed?'k-danger':'')}${Core.kpi('Invoices Sent',a.invoicesSent)}${Core.kpi('Invoices Paid',a.invoicesPaid,'completed','k-success')}${Core.kpi('Invoices Overdue',a.invoicesOverdue,'payment follow-up',a.invoicesOverdue?'k-danger':'')}${Core.kpi('Automations Executed',a.automationsExecuted)}${Core.kpi('Automation Failures',a.automationFailures,'inspect execution log',a.automationFailures?'k-danger':'')}</div>`;
});

Core.route('automation/builder', async () => {
  const [data, meta] = await Promise.all([Core.get('/ops/automations'), Core.get('/ops/automations/meta')]); Pages._automationMeta=meta;
  document.getElementById('content').innerHTML = `${Core.pageHead('Automation Builder','Create WHEN → IF → THEN workflows with safe idempotent execution',`<button class="btn btn-gold" onclick="Pages.newAutomation()">New Automation</button>`)}
    <div class="automation-guide"><div><span>WHEN</span><b>Business event</b></div><i>→</i><div><span>IF</span><b>Conditions match</b></div><i>→</i><div><span>THEN</span><b>Run approved actions</b></div></div>
    ${Core.table([{label:'Automation',render:item=>`<b>${Core.esc(item.name)}</b><small class="subline">${Core.esc(item.description||'')}</small>`},{label:'Trigger',render:item=>Core.badge(item.trigger.replace(/_/g,' '))},{label:'Conditions',num:true,render:item=>(item.conditions||[]).length},{label:'Actions',num:true,render:item=>(item.actions||[]).length},{label:'Status',render:item=>Core.badge(item.enabled?'active':'disabled')},{label:'Last match',render:item=>`${item.lastMatched||0} / ${item.lastQueued||0} queued`},{label:'',render:item=>`<div class="actions-cell"><button class="btn btn-outline btn-sm" onclick="Pages.testAutomation('${item.id}')">Test</button><button class="btn btn-ghost btn-sm" onclick="Pages.toggleAutomation('${item.id}',${!item.enabled})">${item.enabled?'Disable':'Enable'}</button><button class="btn btn-ghost btn-sm" onclick="Pages.deleteAutomation('${item.id}')">Delete</button></div>`}],data.automations,{emptyTitle:'No v4 automations yet',emptyText:'Create a trigger-condition-action workflow.'})}
    <div class="section-title"><div><h2>Execution history</h2><p>Retries and failures remain visible for support and audit.</p></div></div>${Core.table([{label:'Time',render:item=>Core.fmtDate(item.createdAt)},{label:'Trigger',key:'trigger'},{label:'Status',render:item=>Core.badge(item.status)},{label:'Attempts',key:'attempts'},{label:'Error',key:'error'}],data.executions,{emptyTitle:'No automation executions'})}`;
  Pages._automations=data.automations;
});

Pages.newAutomation = () => {
  const meta=Pages._automationMeta; const modal=Core.openModal({title:'New automation',wide:true,body:`<form id="automation-form" class="automation-form"><label class="field"><span>Name *</span><input name="name" required placeholder="Overdue invoice reminder"></label><label class="field"><span>Description</span><input name="description"></label><div class="rule-block when"><span>WHEN</span><label class="field"><span>Trigger</span><select name="trigger">${meta.triggers.map(value=>`<option value="${value}">${value.replace(/_/g,' ')}</option>`).join('')}</select></label></div><div class="rule-block if"><span>IF (optional)</span><div class="grid-3"><label class="field"><span>Field</span><input name="conditionField" placeholder="balanceDue"></label><label class="field"><span>Operator</span><select name="operator">${meta.operators.map(value=>`<option value="${value}">${value}</option>`).join('')}</select></label><label class="field"><span>Value</span><input name="conditionValue"></label></div></div><div class="rule-block then"><span>THEN</span><label class="field"><span>Action</span><select name="actionType">${meta.actions.map(value=>`<option value="${value}">${value.replace(/_/g,' ')}</option>`).join('')}</select></label><div class="grid-2"><label class="field"><span>Title / email subject</span><input name="actionTitle"></label><label class="field"><span>Delay in minutes</span><input type="number" min="0" name="delayMinutes" value="0"></label><label class="field" style="grid-column:1/-1"><span>Message</span><textarea name="message" rows="4"></textarea></label><label class="field"><span>WhatsApp template (official API action)</span><input name="templateName"></label><label class="field"><span>Task due in days</span><input type="number" name="dueInDays" value="1"></label></div></div></form>`,footer:'<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="automation-form">Create Automation</button>'}); modal.el.querySelector('[data-cancel]').onclick=modal.close;modal.el.querySelector('#automation-form').onsubmit=async event=>{event.preventDefault();const fd=new FormData(event.target),field=fd.get('conditionField').trim(),actionType=fd.get('actionType'),action={type:actionType,title:fd.get('actionTitle'),subject:fd.get('actionTitle'),message:fd.get('message'),templateName:fd.get('templateName'),dueInDays:Number(fd.get('dueInDays'))||1};try{await Core.post('/ops/automations',{name:fd.get('name'),description:fd.get('description'),trigger:fd.get('trigger'),conditions:field?[{field,operator:fd.get('operator'),value:fd.get('conditionValue')}]:[],actions:[action],delayMinutes:Number(fd.get('delayMinutes'))||0,enabled:true});modal.close();toast('Automation created','The workflow is enabled and auditable','success');Core.render();}catch(error){toast('Automation not created',error.message,'error');}};
};
Pages.testAutomation=async id=>{try{const result=await Core.post(`/ops/automations/${id}/test`,{});toast('Test completed',`${result.result.matched} match(es), ${result.result.queued} queued`,'success');Core.render();}catch(error){toast('Test failed',error.message,'error');}};
Pages.toggleAutomation=async(id,enabled)=>{const rule=(Pages._automations||[]).find(item=>item.id===id);if(!rule)return;await Core.put(`/ops/automations/${id}`,{...rule,enabled});Core.render();};
Pages.deleteAutomation=async id=>{if(await Core.confirm('Delete this automation rule? Existing execution history remains.')){await Core.del(`/ops/automations/${id}`);Core.render();}};

// Secure one-tap invoice delivery upgrades the existing invoice actions.
Pages.manualInvoiceWhatsApp = async id => {
  try { const result=await Core.post('/ops/whatsapp/link',{invoiceId:id}); if(!result.requiresUserSend||!result.url.startsWith('https://wa.me/'))throw new Error('WhatsApp link was not accepted'); window.open(result.url,'_blank','noopener,noreferrer'); toast('WhatsApp opened','Review the pre-filled message and press Send','success'); }
  catch(error){toast('WhatsApp not opened',error.message,'error');}
};

Pages.emailInvoice = invoice => {
  const row = (Pages._invoiceRows || []).find(item => item.id === invoice.id) || invoice;
  const modal = Core.openModal({ title:`Email ${invoice.number}`, body:`<form id="invoice-email-form"><label class="field"><span>Recipient email *</span><input type="email" name="to" value="${Core.esc(invoice.to)}" required></label><label class="field"><span>Subject *</span><input name="subject" value="Invoice ${Core.esc(invoice.number)} from Tech Defenders" required></label><label class="field"><span>Message *</span><textarea name="body" rows="5" required>Hello {{customer_name}},\nYour invoice {{invoice_number}} for ₹{{invoice_total}} is attached.\nDue date: {{due_date}}\nThank you,\n{{company_name}}</textarea></label><label class="check"><input type="checkbox" name="attachInvoice" checked> Attach secure invoice PDF</label></form>`, footer:'<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-gold" type="submit" form="invoice-email-form">Queue Email</button>' });
  modal.el.querySelector('[data-cancel]').onclick=modal.close;
  modal.el.querySelector('#invoice-email-form').onsubmit=async event=>{event.preventDefault();const fd=new FormData(event.target),button=modal.el.querySelector('[type="submit"]');button.disabled=true;try{await Core.post('/ops/email/send',{to:fd.get('to'),name:row.customerName||'',subject:fd.get('subject'),body:fd.get('body'),type:'transactional',invoiceId:invoice.id,attachInvoice:fd.get('attachInvoice')==='on'});modal.close();toast('Invoice email queued','Delivery will be tracked in Email Center','success');}catch(error){button.disabled=false;toast('Email not queued',error.message,'error');}};
};

Pages.whatsappInvoice = invoice => Core.formModal({
  title:`Send ${invoice.number} via official WhatsApp API`,
  fields:[{name:'to',label:'Mobile with country code *',value:invoice.to,required:true},{name:'templateName',label:'Approved Meta template name *',required:true,placeholder:'invoice_ready'},{name:'language',label:'Language code *',value:'en_US',required:true}],
  submitLabel:'Send via Meta',
  onSubmit:async values=>{const result=await Core.post('/ops/whatsapp/send',{...values,invoiceId:invoice.id,parameters:[invoice.number,String(invoice.total||0)],idempotencyKey:`invoice-wa:${invoice.id}:${Date.now()}`});toast('WhatsApp accepted',result.delivery.providerId,'success');}
});

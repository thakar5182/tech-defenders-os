'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const yazl = require('yazl');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { can, audit, nextNumber } = require('../util');
const providers = require('../services/integrations');
const imports = require('../services/imports');
const communications = require('../services/communications');
const automations = require('../services/automation-engine');

const router = express.Router();
const clean = (value, max = 500) => String(value == null ? '' : value).trim().slice(0, max);
const originFor = req => clean(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`, 300).replace(/\/$/, '');

router.get('/public/invoices/:token.pdf', async (req, res) => {
  const payload = communications.verifyPayload(req.params.token, 'invoice');
  if (!payload) return res.status(404).send('Invoice link is invalid or has expired.');
  const invoice = store.findOne('invoices', item => item.id === payload.invoiceId && item.orgId === payload.orgId);
  const org = store.findOne('organizations', item => item.id === payload.orgId);
  const customer = invoice ? store.findOne('customers', item => item.id === invoice.customerId && item.orgId === payload.orgId) : null;
  if (!invoice || !org) return res.status(404).send('Invoice is no longer available.');
  try {
    const pdf = await communications.invoicePdf(invoice, customer, org);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${clean(invoice.number, 80).replace(/[^a-z0-9._-]/gi, '_')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (_) { res.status(500).send('Invoice PDF could not be generated.'); }
});

router.get('/public/unsubscribe/:token', (req, res) => {
  const payload = communications.verifyPayload(req.params.token, 'unsubscribe');
  const customer = payload ? store.findOne('customers', item => item.id === payload.customerId && item.orgId === payload.orgId) : null;
  if (!customer) return res.status(404).send('<!doctype html><title>Invalid link</title><p>This unsubscribe link is invalid.</p>');
  store.update('customers', customer.id, { marketingOptOut: true, marketingOptOutAt: new Date().toISOString() });
  res.send('<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><main style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px"><h1>Preference saved</h1><p>You will no longer receive marketing email from this business. Transactional emails such as invoices may still be sent.</p></main>');
});

router.use(requireAuth);

const requireAny = (modules, action) => (req, res, next) => modules.some(module => can(req.user, module, action)) ? next() : res.status(403).json({ error: `Permission denied: ${modules.join(' or ')}:${action}` });
const importView = requireAny(['dataImport', 'admin'], 'view');
const importCreate = requireAny(['dataImport', 'admin'], 'create');
const importManage = requireAny(['dataImport', 'admin'], 'edit');
const communicationView = requireAny(['communication', 'admin'], 'view');
const communicationSend = requireAny(['communication', 'admin'], 'create');
const automationView = requireAny(['automation', 'admin'], 'view');
const automationManage = requireAny(['automation', 'admin'], 'edit');

const upload = multer({
  storage: multer.memoryStorage(), limits: { files: 1, fileSize: (Number(process.env.IMPORT_MAX_UPLOAD_MB) || 25) * 1024 * 1024 },
  fileFilter: (req, file, callback) => imports.ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()) ? callback(null, true) : callback(Object.assign(new Error('Upload ZIP, CSV, XLSX, XLS, JSON, PDF or XML only'), { status: 400, expose: true }))
});

function uploadOne(req, res, next) {
  upload.single('file')(req, res, error => {
    if (!error) return next();
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.status || 400)).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Upload is larger than the configured limit' : error.message });
  });
}

const packageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: Number(process.env.PACKAGE_MAX_FILES) || 250, fileSize: (Number(process.env.PACKAGE_MAX_FILE_MB) || 25) * 1024 * 1024, fields: 10, parts: 270 }
});
function uploadMany(req, res, next) {
  packageUpload.array('files', Number(process.env.PACKAGE_MAX_FILES) || 250)(req, res, error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'One or more files exceed the configured per-file limit' : error.message });
    const total = (req.files || []).reduce((sum, file) => sum + file.size, 0);
    const max = (Number(process.env.PACKAGE_MAX_TOTAL_MB) || 100) * 1024 * 1024;
    if (total > max) return res.status(413).json({ error: `Selected files exceed the ${Math.round(max / 1024 / 1024)} MB package limit` });
    next();
  });
}

router.post('/packages/classify', importCreate, uploadMany, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one file' });
  const results = [];
  for (let index = 0; index < req.files.length; index++) {
    const file = req.files[index];
    const target = await imports.classifyPackageFile(file.originalname, file.buffer);
    results.push({ index, name: clean(file.originalname, 240), size: file.size, type: clean(file.mimetype, 100), ...target });
  }
  res.json({ files: results, limits: { files: Number(process.env.PACKAGE_MAX_FILES) || 250, totalMB: Number(process.env.PACKAGE_MAX_TOTAL_MB) || 100, perFileMB: Number(process.env.PACKAGE_MAX_FILE_MB) || 25 } });
});

router.post('/packages/build', importCreate, uploadMany, (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one file' });
  let assignments;
  try { assignments = JSON.parse(req.body.assignments || '[]'); } catch (_) { return res.status(400).json({ error: 'File assignments are invalid' }); }
  if (!Array.isArray(assignments) || assignments.length !== req.files.length) return res.status(400).json({ error: 'Review an assignment for every file' });
  const client = { name: clean(req.body.clientName, 200), reference: clean(req.body.clientReference, 120) };
  const packageId = crypto.randomUUID();
  const manifestFiles = [];
  const zip = new yazl.ZipFile();
  req.files.forEach((file, index) => {
    const incoming = assignments[index] || {};
    let target;
    if (incoming.kind === 'business-data' && imports.defs[incoming.entity]) target = { kind: 'business-data', entity: incoming.entity };
    else target = { kind: 'document', category: imports.DOCUMENT_CATEGORIES.has(incoming.category) ? incoming.category : imports.documentCategory(file.originalname) };
    const safeName = path.basename(file.originalname).replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').slice(0, 180) || `file-${index + 1}`;
    const storedName = `files/${String(index + 1).padStart(4, '0')}-${safeName}`;
    zip.addBuffer(file.buffer, storedName, { compress: true });
    manifestFiles.push({ storedName, originalName: clean(file.originalname, 240), size: file.size, mimeType: clean(file.mimetype, 100), sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), target });
  });
  const manifest = { format: 'tech-defenders-data-package', version: 1, packageId, createdAt: new Date().toISOString(), createdBy: { userId: req.user.id, organizationId: req.org.id }, client, files: manifestFiles };
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), imports.PACKAGE_MANIFEST, { compress: true });
  audit(req.org.id, req.user.id, 'build_data_package', 'data_package', packageId, { files: req.files.length, client: client.name || null });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Tech-Defenders-Data-Package-${new Date().toISOString().slice(0, 10)}.zip"`);
  zip.outputStream.on('error', next => { if (!res.headersSent) res.status(500).json({ error: next.message }); else res.destroy(next); });
  zip.outputStream.pipe(res);
  zip.end();
});

router.get('/documents', importView, (req, res) => {
  const category = clean(req.query.category, 40);
  const documents = store.find('clientDocuments', item => item.orgId === req.org.id && (!category || item.category === category))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500).map(item => ({ ...item, storedPath: undefined, sourceHash: undefined }));
  res.json({ documents });
});

router.get('/documents/:id/download', importView, (req, res) => {
  const document = store.findOne('clientDocuments', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!document || !document.storedPath || !fs.existsSync(document.storedPath)) return res.status(404).json({ error: 'Document file not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(document.storedPath, document.filename);
});

function importJob(req, id) { return store.findOne('importJobs', item => item.id === id && item.orgId === req.org.id); }

router.post('/imports', importCreate, uploadOne, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a business data file to upload' });
  const job = store.insert('importJobs', {
    orgId: req.org.id, number: nextNumber(req.org.id, 'importJob'), userId: req.user.id, filename: clean(req.file.originalname, 240),
    fileSize: req.file.size, mimeType: clean(req.file.mimetype, 120), status: 'uploaded', sourceHash: require('crypto').createHash('sha256').update(req.file.buffer).digest('hex')
  });
  audit(req.org.id, req.user.id, 'upload', 'import_job', job.id, { filename: job.filename, size: job.fileSize });
  try {
    const analysed = await imports.analyseUpload(job.id, req.org.id, req.file);
    res.status(201).json({ import: analysed });
  } catch (error) { res.status(422).json({ error: error.message, import: store.byId('importJobs', job.id) }); }
});

router.get('/imports', importView, (req, res) => {
  const jobs = store.find('importJobs', item => item.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(item => ({ ...item, rollbackPlan: undefined, failures: undefined }));
  res.json({ imports: jobs });
});

router.get('/imports/:id', importView, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const entity = clean(req.query.entity, 50);
  const records = store.find('importRecords', item => item.orgId === req.org.id && item.importJobId === job.id && (!entity || item.entity === entity)).slice(0, limit).map(item => ({ ...item, raw: undefined }));
  const files = store.find('importFiles', item => item.orgId === req.org.id && item.importJobId === job.id).map(item => ({ ...item, stagedPath: undefined, sourceHash: undefined }));
  res.json({ import: { ...job, rollbackPlan: undefined }, files, mappings: store.find('importMappings', item => item.orgId === req.org.id && item.importJobId === job.id), records, errors: store.find('importErrors', item => item.orgId === req.org.id && item.importJobId === job.id).slice(0, 250) });
});

function recomputeImportSummary(job) {
  const records = store.find('importRecords', item => item.orgId === job.orgId && item.importJobId === job.id);
  const documents = store.find('importFiles', item => item.orgId === job.orgId && item.importJobId === job.id && item.kind === 'document');
  const categories = {};
  for (const record of records) {
    categories[record.entity] ||= { entity: record.entity, label: imports.defs[record.entity]?.label || record.entity, detected: 0, valid: 0, warnings: 0, errors: 0, duplicates: 0 };
    const category = categories[record.entity]; category.detected += 1; if (record.valid) category.valid += 1; category.warnings += record.warnings.length; category.errors += record.errors.length; if (record.duplicateId) category.duplicates += 1;
  }
  if (documents.length) categories.documents = { entity: 'documents', label: 'Client Documents', detected: documents.length, valid: documents.length, warnings: 0, errors: 0, duplicates: 0 };
  const summary = { files: store.find('importFiles', item => item.importJobId === job.id && item.orgId === job.orgId).length, documents: documents.length, records: records.length, valid: records.filter(item => item.valid).length + documents.length, warnings: records.reduce((sum, item) => sum + item.warnings.length, 0), errors: records.reduce((sum, item) => sum + item.errors.length, 0), duplicates: records.filter(item => item.duplicateId).length, categories: Object.values(categories) };
  return store.update('importJobs', job.id, { summary, status: summary.errors ? 'ready_with_errors' : 'ready' });
}

router.patch('/imports/:id/mappings', importManage, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job || !['ready', 'ready_with_errors'].includes(job.status)) return res.status(job ? 409 : 404).json({ error: job ? 'Import mappings can no longer be changed' : 'Import job not found' });
  const mapping = store.findOne('importMappings', item => item.id === req.body.mappingId && item.importJobId === job.id && item.orgId === req.org.id);
  const def = mapping && imports.defs[req.body.entity || mapping.entity];
  if (!mapping || !def) return res.status(400).json({ error: 'Select a valid file mapping and business data type' });
  const incoming = Array.isArray(req.body.columns) ? req.body.columns : [];
  const columns = mapping.columns.map(original => {
    const changed = incoming.find(item => item.column === original.column);
    if (!changed) return original;
    if (changed.field && !Object.prototype.hasOwnProperty.call(def.fields, changed.field)) return original;
    return { ...original, field: changed.field || null, accepted: changed.accepted !== false, confidence: changed.field === original.field ? original.confidence : 1 };
  });
  store.update('importMappings', mapping.id, { entity: req.body.entity || mapping.entity, columns, confirmed: true, confirmedBy: req.user.id });
  for (const old of store.find('importErrors', item => item.orgId === req.org.id && item.importFileId === mapping.importFileId)) store.remove('importErrors', old.id);
  for (const record of store.find('importRecords', item => item.orgId === req.org.id && item.importFileId === mapping.importFileId)) {
    const mapped = imports.mappedRow(record.raw, columns); const validation = imports.validateRow(req.body.entity || mapping.entity, mapped, def, req.org.id);
    store.update('importRecords', record.id, { entity: req.body.entity || mapping.entity, mapped, valid: validation.errors.length === 0, errors: validation.errors, warnings: validation.warnings, duplicateId: validation.duplicateId, action: validation.duplicateId ? 'skip' : 'import' });
    for (const message of validation.errors) store.insert('importErrors', { orgId: req.org.id, importJobId: job.id, importFileId: mapping.importFileId, importRecordId: record.id, severity: 'error', rowNumber: record.rowNumber, message });
    for (const message of validation.warnings) store.insert('importErrors', { orgId: req.org.id, importJobId: job.id, importFileId: mapping.importFileId, importRecordId: record.id, severity: 'warning', rowNumber: record.rowNumber, message });
  }
  audit(req.org.id, req.user.id, 'update_mapping', 'import_job', job.id, { mappingId: mapping.id, entity: req.body.entity || mapping.entity });
  res.json({ import: recomputeImportSummary(job), mapping: store.byId('importMappings', mapping.id) });
});

router.post('/imports/:id/validate', importManage, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  res.json({ import: recomputeImportSummary(job) });
});

router.post('/imports/:id/confirm', importManage, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  try { res.json({ import: imports.confirmImport(job, req.body || {}, req.user, req.org) }); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/imports/:id/rollback', importManage, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  try { res.json({ import: imports.rollbackImport(job, req.user, req.org) }); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/imports/:id/cancel', importManage, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  if (!['uploaded', 'processing', 'ready', 'ready_with_errors'].includes(job.status)) return res.status(409).json({ error: 'This import cannot be cancelled' });
  for (const file of store.find('importFiles', item => item.orgId === req.org.id && item.importJobId === job.id && item.stagedPath)) {
    try { if (fs.existsSync(file.stagedPath)) fs.unlinkSync(file.stagedPath); } catch (_) {}
    store.update('importFiles', file.id, { stagedPath: null, importStatus: 'cancelled' });
  }
  res.json({ import: store.update('importJobs', job.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: req.user.id }) });
});

router.get('/imports/:id/errors.csv', importView, (req, res) => {
  const job = importJob(req, req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${job.number}-errors.csv"`); res.send('\uFEFF' + imports.errorCsv(job, req.org.id));
});

router.get('/email/templates', communicationView, (req, res) => res.json({ templates: store.find('emailTemplates', item => item.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name)) }));

router.post('/email/templates', communicationSend, (req, res) => {
  if (!clean(req.body.name, 120) || !clean(req.body.subject, 180) || !clean(req.body.body, 20000)) return res.status(400).json({ error: 'Template name, subject and message are required' });
  const template = store.insert('emailTemplates', { orgId: req.org.id, name: clean(req.body.name, 120), type: req.body.type === 'marketing' ? 'marketing' : 'transactional', subject: clean(req.body.subject, 180), body: clean(req.body.body, 20000), createdBy: req.user.id, active: true });
  audit(req.org.id, req.user.id, 'create', 'email_template', template.id, { name: template.name }); res.status(201).json({ template });
});

router.patch('/email/templates/:id', communicationSend, (req, res) => {
  const template = store.findOne('emailTemplates', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!template) return res.status(404).json({ error: 'Email template not found' });
  const patch = {}; for (const key of ['name', 'subject', 'body', 'active']) if (key in req.body) patch[key] = typeof req.body[key] === 'string' ? clean(req.body[key], key === 'body' ? 20000 : 180) : !!req.body[key];
  res.json({ template: store.update('emailTemplates', template.id, patch) });
});

router.delete('/email/templates/:id', communicationSend, (req, res) => {
  const template = store.findOne('emailTemplates', item => item.id === req.params.id && item.orgId === req.org.id);
  if (!template) return res.status(404).json({ error: 'Email template not found' });
  store.remove('emailTemplates', template.id); res.json({ message: 'Template deleted' });
});

router.post('/email/send', communicationSend, (req, res) => {
  try { const campaign = communications.queueEmail(req.org, req.user, { ...req.body, publicBaseUrl: originFor(req) }); communications.runEmailWorker().catch(() => {}); res.status(202).json({ campaign }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/email/campaigns', communicationView, (req, res) => {
  const campaigns = store.find('emailCampaigns', item => item.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  res.json({ campaigns, queue: store.find('emailQueue', item => item.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 250).map(item => ({ ...item, to: providers.maskRecipient(item.to) })) });
});

router.post('/email/jobs/:id/retry', communicationSend, (req, res) => {
  const job = store.findOne('emailQueue', item => item.id === req.params.id && item.orgId === req.org.id && item.status === 'failed');
  if (!job) return res.status(404).json({ error: 'Failed email job not found' });
  const updated = store.update('emailQueue', job.id, { status: 'retry', attempts: 0, nextAttemptAt: new Date().toISOString(), error: null }); communications.runEmailWorker().catch(() => {}); res.json({ job: updated });
});

function invoiceContext(req) {
  const invoice = store.findOne('invoices', item => item.id === req.body.invoiceId && item.orgId === req.org.id);
  if (!invoice) return null;
  const customer = store.findOne('customers', item => item.id === invoice.customerId && item.orgId === req.org.id);
  return customer ? { invoice, customer } : null;
}

router.post('/whatsapp/link', communicationSend, (req, res) => {
  const context = invoiceContext(req);
  const customer = context?.customer || store.findOne('customers', item => item.id === req.body.customerId && item.orgId === req.org.id);
  const to = clean(req.body.to || customer?.phone, 30); let mobile = to.replace(/\D/g, ''); if (mobile.length === 10) mobile = '91' + mobile;
  if (mobile.length < 11 || mobile.length > 15) return res.status(400).json({ error: 'Customer mobile number with country code is required' });
  const token = context ? communications.invoiceToken(req.org.id, context.invoice.id, Number(req.body.linkDays) || 7) : null;
  const invoiceUrl = token ? `${originFor(req)}/api/ops/public/invoices/${token}.pdf` : '';
  const message = clean(req.body.message || (context ? `Hello ${customer.name},\nYour invoice ${context.invoice.number} from ${req.org.name} is ready.\nInvoice Amount: ₹${context.invoice.totals?.grandTotal || 0}\nDue Date: ${context.invoice.dueDate || '-'}\nInvoice: ${invoiceUrl}\nThank you,\n${req.org.name}` : `Hello ${customer?.name || ''},`), 4000);
  const log = store.insert('communicationLogs', { orgId: req.org.id, customerId: customer?.id || null, channel: 'whatsapp', messageType: context ? 'invoice' : 'message', relatedInvoiceId: context?.invoice.id || null, status: 'initiated', initiatedBy: req.user.id, mode: 'deep_link' });
  audit(req.org.id, req.user.id, 'initiate_whatsapp', 'communication', log.id, { invoiceId: context?.invoice.id || null });
  res.json({ url: `https://wa.me/${mobile}?text=${encodeURIComponent(message)}`, message, invoiceUrl, status: 'initiated', requiresUserSend: true });
});

router.post('/whatsapp/send', communicationSend, async (req, res) => {
  const context = invoiceContext(req); const customer = context?.customer || store.findOne('customers', item => item.id === req.body.customerId && item.orgId === req.org.id);
  try {
    const result = await providers.sendWhatsApp({ orgId: req.org.id, to: req.body.to || customer?.phone, templateName: req.body.templateName, language: req.body.language || 'en_US', parameters: req.body.parameters || [] });
    const delivery = store.insert('messageDeliveries', { orgId: req.org.id, channel: 'whatsapp', idempotencyKey: clean(req.body.idempotencyKey, 200) || `wa:${Date.now()}`, recipient: result.recipient, reference: context?.invoice.number || clean(req.body.reference, 120), status: result.status, provider: result.provider, providerId: result.providerId, requestedBy: req.user.id, attemptCount: 1, acceptedAt: new Date().toISOString() });
    const log = store.insert('communicationLogs', { orgId: req.org.id, customerId: customer?.id || null, channel: 'whatsapp', messageType: context ? 'invoice' : 'message', relatedInvoiceId: context?.invoice.id || null, status: result.status, initiatedBy: req.user.id, mode: 'official_api', deliveryId: delivery.id });
    res.status(202).json({ delivery, communication: log });
  } catch (error) { res.status(error.status || 502).json({ error: error.message, code: error.code }); }
});

router.get('/communications', communicationView, (req, res) => {
  const customerId = clean(req.query.customerId, 100);
  res.json({ communications: communications.communicationTimeline(req.org.id, customerId).slice(0, 500) });
});

router.get('/analytics', communicationView, (req, res) => {
  const deliveries = store.find('messageDeliveries', item => item.orgId === req.org.id);
  const executions = store.find('automationExecutions', item => item.orgId === req.org.id);
  const invoices = store.find('invoices', item => item.orgId === req.org.id && !['cancelled', 'credited'].includes(item.status));
  const count = (channel, states) => deliveries.filter(item => item.channel === channel && states.includes(item.status)).length;
  res.json({ analytics: {
    emailsSent: count('email', ['accepted', 'sent', 'delivered', 'opened']), emailsDelivered: count('email', ['delivered', 'opened']), emailsFailed: count('email', ['failed']),
    whatsappSent: count('whatsapp', ['accepted', 'sent', 'delivered', 'read']), whatsappDelivered: count('whatsapp', ['delivered', 'read']), whatsappRead: count('whatsapp', ['read']), whatsappFailed: count('whatsapp', ['failed']),
    invoicesSent: store.find('communicationLogs', item => item.orgId === req.org.id && item.messageType === 'invoice').length,
    invoicesPaid: invoices.filter(item => item.status === 'paid').length, invoicesOverdue: invoices.filter(item => item.status !== 'paid' && item.dueDate && item.dueDate < new Date().toISOString().slice(0, 10)).length,
    automationsExecuted: executions.filter(item => item.status === 'completed').length, automationFailures: executions.filter(item => item.status === 'failed').length
  } });
});

router.get('/automations/meta', automationView, (req, res) => res.json({ triggers: automations.TRIGGERS, actions: automations.ACTIONS, operators: automations.OPERATORS }));
router.get('/automations', automationView, (req, res) => res.json({ automations: store.find('automationRules', item => item.orgId === req.org.id && item.engineVersion === 2).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), executions: store.find('automationExecutions', item => item.orgId === req.org.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) }));

router.post('/automations', automationManage, (req, res) => {
  try { const rule = store.insert('automationRules', { orgId: req.org.id, ...automations.validateRule(req.body || {}), createdBy: req.user.id }); audit(req.org.id, req.user.id, 'create', 'automation_rule', rule.id, { trigger: rule.trigger }); res.status(201).json({ automation: rule }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.put('/automations/:id', automationManage, (req, res) => {
  const rule = store.findOne('automationRules', item => item.id === req.params.id && item.orgId === req.org.id && item.engineVersion === 2);
  if (!rule) return res.status(404).json({ error: 'Automation not found' });
  try { res.json({ automation: store.update('automationRules', rule.id, automations.validateRule(req.body || {})) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/automations/:id', automationManage, (req, res) => {
  const rule = store.findOne('automationRules', item => item.id === req.params.id && item.orgId === req.org.id && item.engineVersion === 2);
  if (!rule) return res.status(404).json({ error: 'Automation not found' });
  store.remove('automationRules', rule.id); audit(req.org.id, req.user.id, 'delete', 'automation_rule', rule.id, {}); res.json({ message: 'Automation deleted' });
});

router.post('/automations/:id/test', automationManage, async (req, res) => {
  const rule = store.findOne('automationRules', item => item.id === req.params.id && item.orgId === req.org.id && item.engineVersion === 2);
  if (!rule) return res.status(404).json({ error: 'Automation not found' });
  const result = automations.evaluateRule(rule, req.user.id); await automations.runAutomationWorker(); res.json({ result, executions: store.find('automationExecutions', item => item.ruleId === rule.id && item.orgId === req.org.id).slice(-20) });
});

module.exports = router;

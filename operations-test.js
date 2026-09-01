'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const XLSX = require('@e965/xlsx');
const PDFDocument = require('pdfkit');
const yazl = require('yazl');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-v4-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.AUTO_SEED = 'true';
process.env.AUTO_BACKUP = 'false';
process.env.AUTO_AUTOMATION = 'false';
process.env.COOKIE_SECURE = 'false';
process.env.JWT_SECRET = 'operations-test-secret-that-is-long-enough-123456789';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.BREVO_SENDER_EMAIL = 'verified@example.test';

let passed = 0, failed = 0, cookie = '';
function check(name, condition) { if (condition) { passed++; console.log('  PASS ', name); } else { failed++; console.log('  FAIL ', name); } }

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...(payload && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(payload ? { 'Content-Length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks); let json = {}; try { json = JSON.parse(raw.toString('utf8')); } catch (_) {}
        const setCookie = res.headers['set-cookie']; if (setCookie?.[0]) cookie = setCookie[0].split(';')[0];
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    }); req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

function multipart(filename, content) {
  const boundary = '----TDOSV4' + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, Buffer.from(content), tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function multipartMany(files, fields = {}) {
  const boundary = '----TDOSPKG' + Date.now(); const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)); chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function zipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(), chunks = [];
    zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) zip.addBuffer(Buffer.from(entry.content), entry.name);
    zip.end();
  });
}

function pdfBuffer(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(), chunks = [];
    doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (const line of lines) doc.text(line); doc.end();
  });
}

(async () => {
  const providerMock = http.createServer((req, res) => {
    if (req.url === '/v3/smtp/email' && req.method === 'POST') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ messageId: 'test-message-1' })); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => providerMock.listen(0, '127.0.0.1', resolve));
  process.env.TD_TEST_BREVO_BASE_URL = `http://127.0.0.1:${providerMock.address().port}`;
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port;
  try {
    console.log('\n=== Tech Defenders OS v4 operations regression ===\n');
    let response = await request(port, 'GET', '/api/ops/imports');
    check('operations endpoints require authentication', response.status === 401);
    response = await request(port, 'POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'Admin@123' });
    check('administrator login works', response.status === 200 && !!cookie);

    const packageFiles = [
      { name: 'customers-package.csv', type: 'text/csv', content: 'Customer Name,Mobile,Email\nPackage Customer,+919700000001,package@example.test\n' },
      { name: 'signed-contract.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: 'inert test contract bytes' }
    ];
    let packageForm = multipartMany(packageFiles);
    response = await request(port, 'POST', '/api/ops/packages/classify', packageForm.body, { 'Content-Type': packageForm.contentType });
    check('package studio classifies structured data and arbitrary documents', response.status === 200 && response.json.files[0].entity === 'customers' && response.json.files[1].category === 'contracts');
    packageForm = multipartMany(packageFiles, { clientName: 'Package Test Client', clientReference: 'TD-TEST-01', assignments: JSON.stringify([{ kind:'business-data',entity:'customers' },{ kind:'document',category:'contracts' }]) });
    response = await request(port, 'POST', '/api/ops/packages/build', packageForm.body, { 'Content-Type': packageForm.contentType });
    check('package studio creates a manifest-based ZIP', response.status === 200 && String(response.headers['content-type']).includes('application/zip') && response.raw.length > 100);
    const builtPackage = response.raw;
    const packageUpload = multipart('client-package.zip', builtPackage);
    response = await request(port, 'POST', '/api/ops/imports', packageUpload.body, { 'Content-Type': packageUpload.contentType });
    const packageJob = response.json.import;
    check('package import verifies routing and stages both records and documents', response.status === 201 && packageJob.summary.records === 1 && packageJob.summary.documents === 1);
    response = await request(port, 'POST', `/api/ops/imports/${packageJob.id}/confirm`, { createMissingReferences: true });
    check('confirmed package routes all staged content', response.status === 200 && response.json.import.importSummary.imported === 2);
    response = await request(port, 'GET', '/api/ops/documents');
    check('client document appears with package client metadata', response.status === 200 && response.json.documents.some(item => item.filename === 'signed-contract.docx' && item.clientName === 'Package Test Client'));

    const csv = 'Customer Name,Mobile,Email,GSTIN,Address\nAcme Test,+919876543210,acme@example.test,24AAAAA0000A1Z5,Ahmedabad\nBeta Test,+919999999999,beta@example.test,,Surat\n';
    const mp = multipart('customers.csv', csv);
    response = await request(port, 'POST', '/api/ops/imports', mp.body, { 'Content-Type': mp.contentType });
    const importJob = response.json.import;
    check('CSV upload is detected as customer business data', response.status === 201 && importJob.summary.records === 2 && importJob.summary.categories[0].entity === 'customers');
    response = await request(port, 'GET', `/api/ops/imports/${importJob.id}`);
    check('import preview exposes mapping and valid records without raw rows', response.status === 200 && response.json.mappings.length === 1 && response.json.records.every(item => item.raw === undefined && item.valid));
    response = await request(port, 'POST', `/api/ops/imports/${importJob.id}/confirm`, { createMissingReferences: true });
    check('confirmed import creates selected records and rollback plan', response.status === 200 && response.json.import.importSummary.imported === 2);
    response = await request(port, 'GET', '/api/crm/customers');
    const customer = response.json.customers.find(item => item.email === 'acme@example.test');
    check('imported customer appears in existing CRM API', !!customer);

    const duplicate = multipart('customers-again.csv', csv);
    response = await request(port, 'POST', '/api/ops/imports', duplicate.body, { 'Content-Type': duplicate.contentType });
    check('duplicate detection defaults matching rows to safe review', response.status === 201 && response.json.import.summary.duplicates === 2);

    const jsonUpload = multipart('leads.json', JSON.stringify([{ 'Lead Name': 'JSON Lead', Company: 'JSON Co', Mobile: '+919811111111', Email: 'json-lead@example.test' }]));
    response = await request(port, 'POST', '/api/ops/imports', jsonUpload.body, { 'Content-Type': jsonUpload.contentType });
    check('JSON arrays are parsed and detected as business records', response.status === 201 && response.json.import.summary.categories[0].entity === 'leads');

    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Product Name','SKU','HSN','Quantity','Purchase Price','Selling Price'],['XLSX Product','XLSX-001','8471',8,100,150]]), 'Products');
    const xlsxUpload = multipart('products.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    response = await request(port, 'POST', '/api/ops/imports', xlsxUpload.body, { 'Content-Type': xlsxUpload.contentType });
    check('XLSX worksheets are parsed and detected', response.status === 201 && response.json.import.summary.categories[0].entity === 'products');
    const xlsUpload = multipart('products.xls', XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
    response = await request(port, 'POST', '/api/ops/imports', xlsUpload.body, { 'Content-Type': xlsUpload.contentType });
    check('legacy XLS workbooks are parsed and detected', response.status === 201 && response.json.import.summary.categories[0].entity === 'products');

    const xmlUpload = multipart('suppliers.xml', '<suppliers><supplier><Supplier_Name>XML Vendor</Supplier_Name><Email>xml-vendor@example.test</Email><GSTIN>24AAAAA0000A1Z5</GSTIN></supplier></suppliers>');
    response = await request(port, 'POST', '/api/ops/imports', xmlUpload.body, { 'Content-Type': xmlUpload.contentType });
    check('XML object arrays are parsed and detected', response.status === 201 && response.json.import.summary.categories[0].entity === 'suppliers');

    const zipUpload = multipart('business.zip', await zipBuffer([{ name: 'customers.csv', content: 'Customer Name,Mobile,Email\nZIP Customer,+919822222222,zip@example.test\n' }]));
    response = await request(port, 'POST', '/api/ops/imports', zipUpload.body, { 'Content-Type': zipUpload.contentType });
    check('ZIP files are inspected and supported entries are analyzed', response.status === 201 && response.json.import.summary.records === 1);
    const unsafeZip = multipart('unsafe.zip', await zipBuffer([{ name: 'payload.exe', content: 'not executable' }, { name: 'customers.csv', content: 'Customer Name\nUnsafe\n' }]));
    response = await request(port, 'POST', '/api/ops/imports', unsafeZip.body, { 'Content-Type': unsafeZip.contentType });
    check('executable entries are quarantined as download-only documents', response.status === 201 && response.json.import.summary.documents === 1 && response.json.import.summary.records === 1);

    const pdfUpload = multipart('customers.pdf', await pdfBuffer(['Customer Name  Mobile  Email', 'PDF Customer  +919833333333  pdf@example.test']));
    response = await request(port, 'POST', '/api/ops/imports', pdfUpload.body, { 'Content-Type': pdfUpload.contentType });
    check('PDF text tables are analyzed with review-safe behavior', response.status === 201 && response.json.import.summary.files === 1);

    response = await request(port, 'POST', '/api/ops/email/templates', { name: 'Invoice notice', type: 'transactional', subject: 'Hello {{customer_name}}', body: 'Thank you {{customer_name}} from {{company_name}}' });
    const template = response.json.template;
    check('email template with approved variables is created', response.status === 201 && template.subject.includes('{{customer_name}}'));
    response = await request(port, 'PATCH', '/api/integrations/email', { enabled: true });
    check('Brevo adapter can be enabled without storing secrets in the database', response.status === 200 && response.json.integration.configured);
    response = await request(port, 'POST', '/api/ops/email/send', { customerIds: [customer.id], templateId: template.id, subject: template.subject, body: template.body, type: 'transactional' });
    check('bulk email request creates a queued campaign', response.status === 202 && response.json.campaign.queued === 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    response = await request(port, 'GET', '/api/ops/email/campaigns');
    check('email worker records provider acceptance and masks recipients', response.status === 200 && response.json.queue.some(item => item.status === 'sent' && item.to.includes('***')));

    response = await request(port, 'POST', '/api/ops/whatsapp/link', { customerId: customer.id, message: 'Hello Acme Test' });
    check('WhatsApp deep link requires the user to press Send', response.status === 200 && response.json.requiresUserSend === true && response.json.url.startsWith('https://wa.me/'));

    response = await request(port, 'POST', '/api/inventory/products', { name: 'Low Stock Test', sku: 'LOW-001', type: 'goods', minStock: 5, openingStock: 0, purchasePrice: 10, salePrice: 20, gstRate: 18 });
    check('low-stock fixture uses existing inventory API', response.status === 200);
    response = await request(port, 'POST', '/api/ops/automations', { name: 'Low stock notification', trigger: 'low_stock', conditions: [{ field: 'currentStock', operator: 'lt', value: 5 }], actions: [{ type: 'notify_user', title: 'Low stock', message: 'Please reorder' }], enabled: true });
    const rule = response.json.automation;
    check('visual automation rule persists trigger, condition and action', response.status === 201 && rule.engineVersion === 2);
    response = await request(port, 'POST', `/api/ops/automations/${rule.id}/test`, {});
    check('automation test executes idempotently and records history', response.status === 200 && response.json.result.queued >= 1 && response.json.executions.some(item => item.status === 'completed'));

    response = await request(port, 'GET', '/api/ops/analytics');
    check('business dashboard analytics derive from operational records', response.status === 200 && response.json.analytics.emailsSent >= 1 && response.json.analytics.automationsExecuted >= 1);

    response = await request(port, 'POST', `/api/ops/imports/${importJob.id}/rollback`, {});
    check('completed import rolls back safely', response.status === 200 && response.json.import.status === 'rolled_back');
    response = await request(port, 'GET', '/api/crm/customers');
    check('rollback removes only records created by that import', !response.json.customers.some(item => item.email === 'acme@example.test'));
  } finally {
    require('./db/store').flushSync();
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => providerMock.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

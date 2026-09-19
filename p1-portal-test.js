/** Isolated regression for the customer and supplier self-service portals. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-p1-portal-'));
process.env.AUTO_SEED = 'true';
process.env.JWT_SECRET = 'p1-portal-test-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';
delete process.env.PUBLIC_APP_URL;
delete process.env.PORTAL_WEB_URL;

const app = require('./server');
const store = require('./db/store');
let passed = 0, failed = 0, port;

function request(method, requestPath, body, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const buffer = Buffer.concat(chunks); let json = {}; try { json = JSON.parse(buffer.toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] || cookie, buffer, json });
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
function check(name, condition, extra) { if (condition) { passed++; console.log('  PASS  ' + name); } else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 300) : '')); } }
const bearer = token => ({ Authorization: `Bearer ${token}` });

async function run() {
  await app.ready; const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); port = server.address().port;
  console.log('\n=== Tech Defenders OS P1 portal regression ===\n');
  try {
    let response = await request('GET', '/api/portal/session');
    check('portal requires a private access token', response.status === 401);
    response = await request('POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'TestStaffAccount@123' });
    const cookie = response.cookie, org = store.find('organizations')[0];
    check('administrator login works', response.status === 200 && !!cookie);

    const customer = store.insert('customers', { orgId: org.id, name: 'Portal Customer', contactPerson: 'Customer Owner', email: 'customer@example.test' });
    const otherCustomer = store.insert('customers', { orgId: org.id, name: 'Other Customer', email: 'other@example.test' });
    const supplier = store.insert('suppliers', { orgId: org.id, name: 'Portal Supplier', contactPerson: 'Supplier Owner', email: 'supplier@example.test' });
    const quotation = store.insert('quotations', { orgId: org.id, customerId: customer.id, number: 'Q-P1-001', date: '2026-09-19', status: 'sent', lines: [{ name: 'Security service', qty: 1, rate: 5000, lineTotal: 5000 }], totals: { grandTotal: 5900 } });
    const otherQuote = store.insert('quotations', { orgId: org.id, customerId: otherCustomer.id, number: 'Q-OTHER', date: '2026-09-19', status: 'sent', lines: [], totals: { grandTotal: 1 } });
    const invoice = store.insert('invoices', { orgId: org.id, customerId: customer.id, number: 'INV-P1-001', date: '2026-09-19', dueDate: '2026-09-26', status: 'sent', lines: [{ name: 'Security service', qty: 1, rate: 5000, lineTotal: 5000 }], totals: { grandTotal: 5900 }, paidAmount: 0 });
    const project = store.insert('projects', { orgId: org.id, customerId: customer.id, number: 'PRJ-P1', name: 'Portal rollout', status: 'active', startDate: '2026-09-19' });
    store.insert('projectMilestones', { orgId: org.id, projectId: project.id, title: 'Go live', dueDate: '2026-09-30', status: 'planned' });
    store.insert('workOrders', { orgId: org.id, projectId: project.id, number: 'WO-P1', title: 'Configure portal', status: 'open' });
    const rfq = store.insert('rfqs', { orgId: org.id, number: 'RFQ-P1', date: '2026-09-19', status: 'open', vendorIds: [supplier.id], lines: [{ name: 'Firewall', qty: 2 }], quotes: [] });
    const po = store.insert('purchaseOrders', { orgId: org.id, supplierId: supplier.id, number: 'PO-P1', date: '2026-09-19', status: 'sent', lines: [], total: 12000 });

    response = await request('POST', `/api/crm/customers/${customer.id}/portal-invite`, {}, cookie);
    const customerToken = response.json.token;
    check('customer invitation is created without storing raw token', response.status === 200 && customerToken && !store.find('portalAccess').some(row => row.token === customerToken));
    response = await request('GET', `/api/crm/customers/${customer.id}/portal-access`, null, cookie);
    check('invite status hides token hash', response.status === 200 && response.json.invites?.[0]?.active && !('tokenHash' in response.json.invites[0]));
    response = await request('GET', '/api/portal/session', null, null, bearer(customerToken));
    check('customer session includes legacy alias and project details', response.status === 200 && response.json.customer?.id === customer.id && response.json.projects?.[0]?.milestones?.length === 1 && response.json.projects[0].tasks?.length === 1, response.json);
    response = await request('GET', `/api/portal/quotations/${quotation.id}/pdf`, null, null, bearer(customerToken));
    check('customer downloads quotation PDF', response.status === 200 && String(response.headers['content-type']).includes('application/pdf') && response.buffer.subarray(0, 4).toString() === '%PDF');
    response = await request('GET', `/api/portal/quotations/${otherQuote.id}/pdf`, null, null, bearer(customerToken));
    check('customer cannot download another account quotation', response.status === 404);
    response = await request('GET', `/api/portal/invoices/${invoice.id}/pdf`, null, null, bearer(customerToken));
    check('customer downloads invoice PDF', response.status === 200 && response.buffer.subarray(0, 4).toString() === '%PDF');
    response = await request('POST', `/api/portal/quotations/${quotation.id}/decision`, { decision: 'accepted' }, null, bearer(customerToken));
    check('customer accepts quotation', response.status === 200 && response.json.quotation?.status === 'accepted');
    response = await request('POST', '/api/portal/tickets', { subject: 'Portal issue', message: 'Please investigate', priority: 'high' }, null, bearer(customerToken));
    const ticket = response.json.ticket;
    check('customer opens a support ticket', response.status === 201 && ticket?.workLog?.length === 1);
    response = await request('POST', `/api/portal/tickets/${ticket.id}/replies`, { message: 'Additional detail' }, null, bearer(customerToken));
    check('customer replies in ticket conversation', response.status === 200 && response.json.ticket?.workLog?.length === 2);

    response = await request('POST', `/api/purchase/suppliers/${supplier.id}/portal-invite`, {}, cookie);
    const supplierToken = response.json.token;
    check('supplier invitation is created', response.status === 200 && !!supplierToken);
    response = await request('POST', `/api/portal/rfqs/${rfq.id}/quote`, { lines: [{ rate: 4500, taxPct: 18 }], freight: 250, leadTimeDays: 4, paymentTerms: 'Net 15' }, null, bearer(supplierToken));
    check('supplier submits an RFQ response', response.status === 200 && response.json.rfq?.quotes?.[0]?.rate !== 4500 && response.json.rfq?.quotes?.[0]?.lines?.[0]?.rate === 4500);
    response = await request('POST', `/api/portal/purchase-orders/${po.id}/decision`, { decision: 'accepted', note: 'Confirmed' }, null, bearer(supplierToken));
    check('supplier accepts a purchase order', response.status === 200 && response.json.purchaseOrder?.status === 'supplier_accepted');
    const contentData = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 P1 test').toString('base64');
    response = await request('POST', '/api/portal/supplier-documents', { title: 'Supplier invoice', type: 'invoice', reference: 'SI-001', contentData }, null, bearer(supplierToken));
    const supplierDocument = response.json.document;
    check('supplier uploads invoice document securely', response.status === 201 && supplierDocument?.status === 'submitted' && !supplierDocument?.contentData);
    response = await request('GET', `/api/portal/supplier-documents/${supplierDocument.id}/download`, null, null, bearer(supplierToken));
    check('supplier can download its uploaded document', response.status === 200 && response.buffer.toString().startsWith('%PDF'));
    response = await request('GET', '/api/portal/session', null, null, bearer(supplierToken));
    check('supplier session contains workflow activity history', response.status === 200 && response.json.activity?.length >= 3 && response.json.documents?.length === 1, response.json);
    await request('POST', `/api/purchase/suppliers/${supplier.id}/portal-revoke`, {}, cookie);
    response = await request('GET', '/api/portal/session', null, null, bearer(supplierToken));
    check('revoked invitation is immediately invalid', response.status === 401);
    await store.flush();
  } finally { await new Promise(resolve => server.close(resolve)); await store.close().catch(() => {}); }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`); if (failed) process.exitCode = 1;
}
run().catch(error => { console.error(error); process.exitCode = 1; });

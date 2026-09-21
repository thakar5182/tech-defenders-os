/** Phase 0 security, tenant isolation and business calculation regression. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), bcrypt = require('bcryptjs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-phase0-'));
process.env.AUTO_SEED = 'true';
process.env.JWT_SECRET = 'phase-zero-test-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';
const app = require('./server'), store = require('./db/store');
let passed = 0, failed = 0, port;
function request(method, route, body, cookie) { return new Promise((resolve, reject) => { const payload = body == null ? null : Buffer.from(JSON.stringify(body)); const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { let json = {}; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {} resolve({ status: res.statusCode, json, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] || cookie }); }); }); req.on('error', reject); if (payload) req.write(payload); req.end(); }); }
function check(name, condition, evidence) { if (condition) { passed++; console.log('  PASS  ' + name); } else { failed++; console.log('  FAIL  ' + name + (evidence ? ' -> ' + JSON.stringify(evidence).slice(0, 240) : '')); } }
async function run() {
  await app.ready;
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); port = server.address().port;
  console.log('\n=== Phase 0 security and data correctness ===\n');
  try {
    let response = await request('POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'TestStaffAccount@123' });
    const adminCookie = response.cookie, admin = store.findOne('users', row => row.email === 'admin@techdefenders.in'), orgId = admin.orgId;
    check('administrator login works', response.status === 200 && !!adminCookie, response.json);

    const passwordHash = bcrypt.hashSync('EmployeeTest@123', 10);
    const employeeOne = store.insert('users', { orgId, name: 'Employee One', email: 'employee.one@phase0.test', passwordHash, role: 'employee', active: true, tokenVersion: 0, moduleAccess: {}, appAccess: {}, dashboardWidgets: {} });
    const employeeTwo = store.insert('users', { orgId, name: 'Employee Two', email: 'employee.two@phase0.test', passwordHash, role: 'employee', active: true, tokenVersion: 0, moduleAccess: {}, appAccess: {}, dashboardWidgets: {} });
    const profileOne = store.insert('employees', { orgId, userId: employeeOne.id, empCode: 'EMP-P01', name: employeeOne.name, email: employeeOne.email, status: 'active' });
    const profileTwo = store.insert('employees', { orgId, userId: employeeTwo.id, empCode: 'EMP-P02', name: employeeTwo.name, email: employeeTwo.email, status: 'active' });
    store.update('users', employeeOne.id, { employeeId: profileOne.id }); store.update('users', employeeTwo.id, { employeeId: profileTwo.id });
    response = await request('POST', '/api/auth/login', { email: employeeOne.email, password: 'EmployeeTest@123' }); const employeeCookie = response.cookie;
    check('employee login works', response.status === 200 && !!employeeCookie, response.json);
    response = await request('POST', '/api/admin/leaves', { employeeId: profileTwo.id, fromDate: '2026-10-01', toDate: '2026-10-02' }, employeeCookie);
    check('employee cannot impersonate another employee in leave API', response.status === 403, response.json);
    response = await request('POST', '/api/admin/leaves', { employeeId: profileOne.id, fromDate: '2026-10-01', toDate: '2026-10-02' }, employeeCookie);
    check('employee can submit own leave', response.status === 200 && response.json.leave?.employeeId === profileOne.id && response.json.leave?.days === 2, response.json);
    response = await request('POST', '/api/admin/leaves', { employeeId: profileOne.id, fromDate: '2026-10-03', toDate: '2026-10-02' }, employeeCookie);
    check('leave API rejects reversed date range', response.status === 400, response.json);
    response = await request('GET', '/api/crm/activities', null, employeeCookie);
    check('employee cannot bypass hidden CRM activity access', response.status === 403, response.json);

    const foreignOrg = store.insert('organizations', { name: 'Foreign tenant', stateCode: '24' });
    store.insert('backupAgentHeartbeats', { orgId: foreignOrg.id, status: 'success', fileName: 'foreign.zip', createdAt: '2026-09-21T12:00:00.000Z' });
    store.insert('backupAgentHeartbeats', { orgId, status: 'success', fileName: 'own.zip', createdAt: '2026-09-21T11:00:00.000Z' });
    response = await request('GET', '/api/backups/status', null, adminCookie);
    check('backup status returns only active organization heartbeat', response.status === 200 && response.json.driveAgent?.lastHeartbeat?.fileName === 'own.zip', response.json);

    const customer = store.insert('customers', { orgId, name: 'Calculation Customer', paymentTermsDays: 30, creditLimit: 50000 });
    const product = store.insert('products', { orgId, name: 'Costed Product', purchasePrice: 40 });
    const invoice = store.insert('invoices', { orgId, customerId: customer.id, number: 'INV-P0', date: '2026-07-01', dueDate: '2026-07-31', status: 'partial', paidAmount: 50, totals: { grandTotal: 200 }, lines: [{ productId: product.id, productName: product.name, qty: 1, rate: 100, amount: 100 }, { description: 'Manual service', qty: 1, rate: 100, amount: 100 }] });
    store.insert('receipts', { orgId, customerId: customer.id, date: '2026-08-05', amount: 50, allocations: [{ invoiceId: invoice.id, amount: 50 }] });
    response = await request('GET', '/api/customer-tools/customers/' + customer.id + '/intelligence', null, adminCookie);
    const intelligence = response.json.intelligence || {};
    check('payment delay is calculated from due date', response.status === 200 && intelligence.averagePaymentDelayDays === 5, response.json);
    check('unknown manual cost does not inflate estimated profit', intelligence.estimatedProfit === null && intelligence.profitEstimateComplete === false && intelligence.costCoveragePercent === 50, intelligence);
    const uiSource = fs.readFileSync(path.join(__dirname, 'public/js/customer-tools.js'), 'utf8');
    check('Customer 360 endpoints fail independently', uiSource.includes('Promise.allSettled') && !uiSource.includes("console.warn('Customer tools unavailable:'"));
    await store.flush();
  } finally { await new Promise(resolve => server.close(resolve)); await store.close().catch(() => {}); }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`); if (failed) process.exitCode = 1;
}
run().catch(error => { console.error(error); process.exitCode = 1; });

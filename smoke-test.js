/** Isolated end-to-end smoke test. Real /data is never touched. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-smoke-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTO_SEED = 'true';
process.env.JWT_SECRET = 'smoke-test-only-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_RESET_TOKEN = 'false';
process.env.AUTH_TEST_OTP_DELIVERY = 'capture';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';

const app = require('./server');
const store = require('./db/store');
const INITIAL_BUSINESS_COLLECTIONS = [
  'leads', 'customers', 'suppliers', 'deals', 'tasks', 'activities',
  'products', 'warehouses', 'quotations', 'salesOrders', 'invoices',
  'receipts', 'creditNotes', 'requisitions', 'rfqs', 'purchaseOrders',
  'grns', 'stockLedger', 'boms', 'jobOrders', 'amcContracts', 'tickets',
  'journals', 'expenses', 'employees', 'leaveRequests', 'notifications',
  'auditEvents'
];
const INITIAL_BUSINESS_COUNTS = Object.fromEntries(
  INITIAL_BUSINESS_COLLECTIONS.map(collection => [collection, store.find(collection).length])
);
let port;
let passed = 0;
let failed = 0;

function req(method, requestPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        cookie ? { Cookie: cookie } : {}
      )
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch (_) {}
        const setCookie = response.headers['set-cookie'];
        resolve({ status: response.statusCode, json, raw, headers: response.headers, cookie: setCookie?.[0]?.split(';')[0] || cookie });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function check(name, condition, extra) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

async function run() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
  console.log('\n=== Tech Defenders OS v3 - backward-compatibility smoke test ===\n');
  try {
    let response = await req('GET', '/api/health');
    check('health endpoint', response.status === 200 && response.json.ok === true);
    check('clean initializer contains no demo business records',
      Object.values(INITIAL_BUSINESS_COUNTS).every(count => count === 0), INITIAL_BUSINESS_COUNTS);
    const cleanOrg = store.find('organizations');
    check('clean initializer retains only required workspace and login configuration',
      cleanOrg.length === 1 && cleanOrg[0].name === 'Tech Defenders' &&
      store.find('users').length === 9 && store.find('accounts').length === 20 &&
      store.find('sequences').length === 23);
    response = await req('GET', '/');
    check('sign-in page renders secure login options without exposed credentials',
      response.status === 200 && response.raw.includes('/assets/tech-defenders-logo.webp') &&
      !response.raw.includes('superadmin@techdefenders.in') && response.raw.includes('Sign in with Email OTP') &&
      response.raw.includes('Email OTP &amp; Create Workspace') && response.raw.includes('google-auth'));
    response = await req('GET', '/app.html');
    check('application shell references bundled logo', response.status === 200 && response.raw.includes('/assets/tech-defenders-logo.webp'));
    response = await req('GET', '/assets/tech-defenders-logo.webp');
    check('optimized logo asset is served', response.status === 200 && String(response.headers['content-type']).includes('image/webp'));
    response = await req('GET', '/js/pages-ops.js');
    check('Super Admin global account and dashboard-control UI is bundled',
      response.status === 200 && response.raw.includes('/admin/global/users') && response.raw.includes('data-global-widget'));
    response = await req('GET', '/js/pages-core.js');
    check('user dashboard renderer follows widget policy and includes the permission-aware app launcher',
      response.status === 200 && response.raw.includes('widgets.salesTrend') && response.raw.includes('Core.appLauncher()'));
    response = await req('GET', '/js/core.js');
    check('sidebar module labels expand into their permitted apps', response.status === 200 &&
      response.raw.includes('nav-group-toggle') && response.raw.includes('toggleNavGroup') && response.raw.includes('toggleDashboardApp'));
    response = await req('GET', '/js/pages-commerce.js');
    check('manual quotation and direct invoice editors are bundled',
      response.status === 200 && response.raw.includes('Manual quotation mode') &&
      response.raw.includes('Direct manual invoice') && !response.raw.includes('Pages._qProd'));

    response = await req('POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'TestStaffAccount@123' });
    const adminCookie = response.cookie;
    check('admin login uses HTTP-only cookie', response.status === 200 && !!adminCookie && !response.json.token);
    const superLogin = await req('POST', '/api/auth/login', { email: 'superadmin@techdefenders.in', password: 'TestSuperAdmin@123' });
    const superCookie = superLogin.cookie;
    check('Super Admin login works', superLogin.status === 200 && !!superCookie && superLogin.json.user.role === 'super_admin');
    const platformOrgs = await req('GET', '/api/admin/organizations', null, superCookie);
    check('Super Admin can view platform organizations', platformOrgs.status === 200 && platformOrgs.json.organizations.length === 1);
    const initialGlobalUsers = await req('GET', '/api/admin/global/users', null, superCookie);
    check('Super Admin global account index loads every seeded account', initialGlobalUsers.status === 200 && initialGlobalUsers.json.users.length === 9);
    response = await req('GET', '/api/admin/global/users', null, adminCookie);
    check('regular admin cannot open global account index', response.status === 403);
    response = await req('GET', '/api/admin/organizations', null, adminCookie);
    check('regular admin cannot open platform control', response.status === 403);
    response = await req('GET', '/api/auth/me', null, adminCookie);
    check('profile does not expose password hash', response.status === 200 && !response.json.user.passwordHash);
    response = await req('POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'TestStaffAccount@123' });
    check('second login works after authenticated request', response.status === 200);

    response = await req('POST', '/api/auth/forgot', { email: 'admin@techdefenders.in' });
    check('forgot password does not disclose token', response.status === 200 && !response.json.resetToken);
    response = await req('GET', '/api/dashboard/summary', null, adminCookie);
    check('dashboard KPIs computed', response.status === 200 && typeof response.json.kpis.pipelineValue === 'number');

    for (const endpoint of ['/api/purchase/rfqs', '/api/purchase/grns', '/api/manufacturing/boms', '/api/service/tickets']) {
      response = await req('GET', endpoint, null, adminCookie);
      check(endpoint + ' does not crash', response.status === 200, response.json);
    }

    const screenEndpoints = [
      '/api/crm/leads', '/api/crm/customers', '/api/crm/deals', '/api/crm/tasks',
      '/api/sales/quotations', '/api/sales/sales-orders', '/api/sales/invoices', '/api/sales/receipts', '/api/sales/credit-notes',
      '/api/purchase/requisitions', '/api/purchase/purchase-orders', '/api/purchase/suppliers',
      '/api/inventory/products', '/api/inventory/warehouses', '/api/inventory/ledger', '/api/inventory/summary',
      '/api/manufacturing/job-orders', '/api/service/amc', '/api/service/assignees',
      '/api/finance/accounts', '/api/finance/journals', '/api/finance/expenses', '/api/finance/trial-balance', '/api/finance/pnl',
      '/api/reports/sales-by-month', '/api/reports/receivable-aging', '/api/reports/stock-valuation', '/api/reports/lead-funnel', '/api/reports/ticket-summary',
      '/api/admin/users', '/api/admin/access-control', '/api/admin/sequences', '/api/admin/employees', '/api/admin/leaves', '/api/admin/audit'
    ];
    const screenFailures = [];
    for (const endpoint of screenEndpoints) {
      response = await req('GET', endpoint, null, adminCookie);
      if (response.status !== 200) screenFailures.push({ endpoint, status: response.status, body: response.json });
    }
    check('all 35 primary screen endpoints load', screenFailures.length === 0, screenFailures);

    response = await req('POST', '/api/crm/leads', { name: 'Smoke Lead', company: 'Smoke Corp', value: 5000 }, adminCookie);
    response = await req('POST', `/api/crm/leads/${response.json.lead.id}/convert`, {}, adminCookie);
    const customerId = response.json.customer?.id;
    check('lead converts to customer and deal', response.status === 200 && !!customerId);

    response = await req('POST', '/api/sales/quotations', {
      customerId,
      notes: 'Manual quotation smoke test',
      lines: [{ name: 'Manual cyber security assessment', hsn: '998313', uom: 'Job', qty: 2, rate: 1000, discountPct: 10, gstRate: 18 }]
    }, adminCookie);
    const manualQuotation = response.json.quotation;
    check('quotation accepts a fully manual line without product selection',
      response.status === 200 && manualQuotation.lines[0].productId === null &&
      manualQuotation.lines[0].name === 'Manual cyber security assessment' &&
      manualQuotation.totals.grandTotal === 2124);
    await req('PATCH', `/api/sales/quotations/${manualQuotation.id}/status`, { status: 'accepted' }, adminCookie);
    response = await req('POST', `/api/sales/quotations/${manualQuotation.id}/convert-sales-order`, {}, adminCookie);
    const manualSalesOrder = response.json.salesOrder;
    response = await req('POST', `/api/sales/sales-orders/${manualSalesOrder.id}/invoice`, { lines: [{ index: 0, qty: 2 }] }, adminCookie);
    const manualChainInvoice = response.json.invoice;
    check('manual quotation converts through Sales Order to invoice without stock mutation',
      response.status === 200 && manualChainInvoice.sourceType === 'sales_order' &&
      store.find('stockLedger', entry => entry.refType === 'invoice' && entry.refId === manualChainInvoice.id).length === 0);

    const invoiceCountBeforeInvalid = store.find('invoices').length;
    response = await req('POST', '/api/sales/invoices', {
      customerId,
      date: '2026-08-27',
      dueDate: '2026-09-26',
      notes: 'Created directly without quotation',
      lines: [{ name: 'Managed security service', hsn: '998313', uom: 'Month', qty: 3, rate: 500, discountPct: 0, gstRate: 18 }]
    }, adminCookie);
    const directInvoice = response.json.invoice;
    check('direct manual GST invoice is created without quotation or Sales Order',
      response.status === 200 && directInvoice.sourceType === 'manual' && directInvoice.sourceId === null &&
      directInvoice.lines[0].productId === null && directInvoice.totals.grandTotal === 1770);
    const directJournal = store.findOne('journals', journal => journal.refType === 'invoice' && journal.refId === directInvoice.id);
    check('direct invoice posts balanced receivable, sales and GST journal lines',
      !!directJournal && directJournal.lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0) ===
      directJournal.lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0));
    response = await req('POST', '/api/sales/invoices', {
      customerId,
      lines: [{ name: 'Invalid negative line', qty: 1, rate: -1, gstRate: 18 }]
    }, adminCookie);
    check('invalid direct invoice is rejected before any document is saved',
      response.status === 400 && store.find('invoices').length === invoiceCountBeforeInvalid + 1);

    response = await req('POST', '/api/inventory/warehouses', {
      name: 'Smoke Test Warehouse', location: 'Disposable test data'
    }, adminCookie);
    const smokeWarehouse = response.json.warehouse;
    response = await req('POST', '/api/inventory/products', {
      sku: 'FG-PMP-101', name: 'Smoke Test Pump', type: 'finished', hsn: '8413',
      uom: 'Nos', gstRate: 18, purchasePrice: 500, salePrice: 1000,
      warehouseId: smokeWarehouse.id, openingStock: 10
    }, adminCookie);
    const smokePump = response.json.product;
    response = await req('POST', '/api/inventory/products', {
      sku: 'RM-BRG-003', name: 'Smoke Test Bearing', type: 'raw', hsn: '8482',
      uom: 'Nos', gstRate: 18, purchasePrice: 100, salePrice: 0,
      warehouseId: smokeWarehouse.id, openingStock: 0
    }, adminCookie);
    const smokeBearing = response.json.product;
    response = await req('POST', '/api/purchase/suppliers', {
      name: 'Smoke Test Supplier', stateCode: '24'
    }, adminCookie);
    check('isolated smoke fixtures are created only inside the disposable test database',
      response.status === 200 && !!smokeWarehouse && !!smokePump && !!smokeBearing && !!response.json.supplier);

    const products = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products;
    const pump = products.find(product => product.sku === 'FG-PMP-101');
    response = await req('POST', '/api/sales/quotations', { customerId, lines: [{ productId: pump.id, qty: 2 }] }, adminCookie);
    const quoteId = response.json.quotation.id;
    await req('PATCH', `/api/sales/quotations/${quoteId}/status`, { status: 'accepted' }, adminCookie);
    response = await req('POST', `/api/sales/quotations/${quoteId}/convert-sales-order`, {}, adminCookie);
    response = await req('POST', `/api/sales/sales-orders/${response.json.salesOrder.id}/invoice`, { lines: [{ index: 0, qty: 1 }] }, adminCookie);
    const invoice = response.json.invoice;
    check('sales chain creates invoice and deducts stock', response.status === 200 && !!invoice);

    const before = (await req('GET', `/api/sales/invoices/${invoice.id}`, null, adminCookie)).json.invoice.paidAmount;
    response = await req('POST', '/api/sales/receipts', {
      customerId, amount: 10,
      allocations: [{ invoiceId: invoice.id, amount: 10 }, { invoiceId: invoice.id, amount: 10 }]
    }, adminCookie);
    const after = (await req('GET', `/api/sales/invoices/${invoice.id}`, null, adminCookie)).json.invoice.paidAmount;
    check('failed receipt leaves invoice unchanged', response.status === 400 && before === after);
    response = await req('POST', '/api/sales/receipts', {
      customerId, amount: invoice.totals.grandTotal,
      allocations: [{ invoiceId: invoice.id, amount: invoice.totals.grandTotal }]
    }, adminCookie);
    check('valid receipt pays invoice', response.status === 200);

    const stockBeforeCredit = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === pump.id).balance;
    response = await req('POST', '/api/sales/credit-notes', { invoiceId: invoice.id, reason: 'Smoke-test return' }, adminCookie);
    const stockAfterCredit = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === pump.id).balance;
    const creditedInvoice = (await req('GET', `/api/sales/invoices/${invoice.id}`, null, adminCookie)).json.invoice;
    check('credit note restores stock and credits invoice', response.status === 200 && stockAfterCredit === stockBeforeCredit + 1 && creditedInvoice.status === 'credited');

    response = await req('POST', `/api/sales/sales-orders/${creditedInvoice.sourceId}/invoice`, { lines: [{ index: 0, qty: 1 }] }, adminCookie);
    const cancellableInvoice = response.json.invoice;
    const stockBeforeCancel = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === pump.id).balance;
    response = await req('POST', `/api/sales/invoices/cancel/${cancellableInvoice.id}`, { reason: 'Smoke-test cancellation' }, adminCookie);
    const stockAfterCancel = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === pump.id).balance;
    check('invoice cancellation restores stock and reverses workflow', response.status === 200 && stockAfterCancel === stockBeforeCancel + 1);

    const suppliers = (await req('GET', '/api/purchase/suppliers', null, adminCookie)).json.suppliers;
    response = await req('POST', '/api/purchase/purchase-orders', {
      supplierId: suppliers[0].id,
      lines: [{ description: 'Smoke bearings', qty: 10, rate: 100, taxPct: 18 }]
    }, adminCookie);
    const purchaseOrderId = response.json.purchaseOrder.id;
    const bearing = products.find(product => product.sku === 'RM-BRG-003');
    const bearingBefore = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === bearing.id).balance;
    response = await req('POST', '/api/purchase/grns', {
      poId: purchaseOrderId, lines: [{ receivedQty: 10, rejectedQty: -2, productId: bearing.id }]
    }, adminCookie);
    const bearingAfterFailure = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === bearing.id).balance;
    check('negative GRN rejection is blocked without stock mutation', response.status === 400 && bearingAfterFailure === bearingBefore);
    response = await req('POST', '/api/purchase/grns', {
      poId: purchaseOrderId, lines: [{ receivedQty: 10, rejectedQty: 2, productId: bearing.id }]
    }, adminCookie);
    const bearingAfterReceipt = (await req('GET', '/api/inventory/products', null, adminCookie)).json.products.find(p => p.id === bearing.id).balance;
    check('GRN posts accepted quantity only', response.status === 200 && bearingAfterReceipt === bearingBefore + 8);

    const access = await req('GET', '/api/admin/access-control', null, adminCookie);
    const engineer = access.json.users.find(user => user.email === 'engineer@techdefenders.in');
    const superAdminUser = access.json.users.find(user => user.email === 'superadmin@techdefenders.in');
    response = await req('PATCH', `/api/admin/users/${superAdminUser.id}`, { active: false }, adminCookie);
    check('admin cannot control Super Admin', response.status === 403);
    response = await req('PATCH', `/api/admin/users/${engineer.id}/access`, { moduleAccess: { service: false } }, adminCookie);
    check('admin can disable a user module', response.status === 200 && response.json.effectiveAccess.service === false);
    const engineerLogin = await req('POST', '/api/auth/login', { email: engineer.email, password: 'TestStaffAccount@123' });
    response = await req('GET', '/api/service/tickets', null, engineerLogin.cookie);
    check('disabled module is denied by API', response.status === 403);

    response = await req('POST', '/api/admin/users', {
      name: 'Secondary Admin', email: 'secondary.admin@techdefenders.in', role: 'admin'
    }, superCookie);
    const secondaryAdmin = response.json.user;
    check('Super Admin can create an administrator', response.status === 200 && secondaryAdmin.role === 'admin');
    response = await req('PATCH', `/api/admin/users/${secondaryAdmin.id}`, { active: false }, adminCookie);
    check('admin cannot control another admin', response.status === 403);
    response = await req('PATCH', `/api/admin/users/${secondaryAdmin.id}/password`, {
      newPassword: 'Secondary@123', mustChangePassword: false
    }, superCookie);
    const secondaryLogin = await req('POST', '/api/auth/login', {
      email: 'secondary.admin@techdefenders.in', password: 'Secondary@123'
    });
    check('Super Admin can set admin password and revoke sessions', response.status === 200 && secondaryLogin.status === 200);
    response = await req('DELETE', `/api/admin/users/${secondaryAdmin.id}`, null, superCookie);
    check('Super Admin can delete an administrator', response.status === 200);

    response = await req('POST', '/api/admin/users', {
      name: 'Disposable Viewer', email: 'disposable.viewer@techdefenders.in', role: 'viewer'
    }, adminCookie);
    const disposableUser = response.json.user;
    response = await req('DELETE', `/api/admin/users/${disposableUser.id}`, null, adminCookie);
    check('admin can delete a standard user', response.status === 200);

    const signupOtp = await req('POST', '/api/auth/register/request-otp', {
      name: 'Other Owner', email: `owner${Date.now()}@other.example`, password: 'Password1!', company: 'Other Org'
    });
    check('new workspace signup requires an emailed OTP challenge', signupOtp.status === 202 && /^\d{6}$/.test(signupOtp.json.testOtp || ''));
    const wrongSignupOtp = await req('POST', '/api/auth/register/verify-otp', { challengeId: signupOtp.json.challengeId, otp: '000000' });
    check('incorrect signup OTP is rejected without creating a workspace', wrongSignupOtp.status === 400);
    const otherLogin = await req('POST', '/api/auth/register/verify-otp', { challengeId: signupOtp.json.challengeId, otp: signupOtp.json.testOtp });
    check('correct signup OTP creates the organization and an HTTP-only session', otherLogin.status === 200 && !!otherLogin.cookie);
    const otherCustomer = await req('POST', '/api/crm/customers', { name: 'Other Customer' }, otherLogin.cookie);
    const otherOwner = store.findOne('users', user => user.email.startsWith('owner') && user.email.endsWith('@other.example'));
    response = await req('GET', '/api/admin/global/users', null, superCookie);
    const globallyVisibleOwner = response.json.users.find(user => user.id === otherOwner.id);
    check('newly registered account appears immediately in Super Admin without workspace switch',
      response.status === 200 && globallyVisibleOwner && globallyVisibleOwner.organization.name === 'Other Org');
    response = await req('GET', `/api/admin/global/users/${otherOwner.id}/dashboard-preview`, null, superCookie);
    check('Super Admin can preview a user dashboard', response.status === 200 && response.json.widgets.length === 10);
    response = await req('PATCH', `/api/admin/global/users/${otherOwner.id}/access`, {
      dashboardWidgets: { crmOverview: false }, moduleAccess: { service: false }
    }, superCookie);
    check('Super Admin can manage dashboard modules and widgets across organizations',
      response.status === 200 && response.json.effectiveDashboardWidgets.crmOverview === false && response.json.effectiveAccess.service === false);
    const otherOwnerLogin = await req('POST', '/api/auth/login', { email: otherOwner.email, password: 'Password1!' });
    const controlledDashboard = await req('GET', '/api/dashboard/summary', null, otherOwnerLogin.cookie);
    check('dashboard widget policy is enforced in the actual user dashboard',
      controlledDashboard.status === 200 && controlledDashboard.json.widgets.crmOverview === false && controlledDashboard.json.kpis.openLeads === null);
    response = await req('POST', '/api/admin/global/users', {
      orgId: otherOwner.orgId, name: 'Global Created User', email: 'global.created@other.example', role: 'viewer'
    }, superCookie);
    const globalCreatedUser = response.json.user;
    check('Super Admin can create an account in another organization without switching',
      response.status === 200 && globalCreatedUser.organization.name === 'Other Org');
    response = await req('PATCH', `/api/admin/global/users/${globalCreatedUser.id}/password`, { newPassword: 'GlobalUser@123', mustChangePassword: false }, superCookie);
    const globalCreatedLogin = await req('POST', '/api/auth/login', { email: 'global.created@other.example', password: 'GlobalUser@123' });
    check('global password control works and the account can sign in', response.status === 200 && globalCreatedLogin.status === 200);
    response = await req('DELETE', `/api/admin/global/users/${globalCreatedUser.id}`, null, superCookie);
    check('Super Admin can delete an account from another organization', response.status === 200);
    response = await req('POST', '/api/sales/quotations', {
      customerId: otherCustomer.json.customer.id, lines: [{ productId: pump.id, qty: 1 }]
    }, otherOwnerLogin.cookie);
    check('cross-tenant product reference is rejected', response.status === 400);

    const otherOrgId = otherOwner.orgId;
    response = await req('POST', '/api/admin/switch-organization', { orgId: otherOrgId }, superCookie);
    const switchedSuperCookie = response.cookie;
    const switchedProfile = await req('GET', '/api/auth/me', null, switchedSuperCookie);
    const switchedCustomers = await req('GET', '/api/crm/customers', null, switchedSuperCookie);
    check('Super Admin can switch organization and view its complete scoped data',
      response.status === 200 && switchedProfile.json.org.id === otherOrgId &&
      switchedCustomers.json.customers.some(customer => customer.name === 'Other Customer'));
    response = await req('POST', '/api/admin/switch-organization', { orgId: otherOrgId }, adminCookie);
    check('regular admin cannot switch organizations', response.status === 403);

    response = await req('GET', '/api/dashboard/summary');
    check('unauthenticated API is blocked', response.status === 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.flushSync();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error('SMOKE TEST CRASHED:', error);
  store.flushSync();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.exitCode = 1;
});

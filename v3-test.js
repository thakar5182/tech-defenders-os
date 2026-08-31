/** Tech Defenders OS v3 isolated regression suite. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-v3-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTO_SEED = 'true';
process.env.JWT_SECRET = 'v3-test-only-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.OLLAMA_ENABLED = 'false';

const app = require('./server');
const store = require('./db/store');
let port;
let passed = 0;
let failed = 0;

function req(method, requestPath, body, cookie, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}, cookie ? { Cookie: cookie } : {}, headers || {})
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch (_) {}
        const setCookie = response.headers['set-cookie'];
        resolve({ status: response.statusCode, json, raw, cookie: setCookie?.[0]?.split(';')[0] || cookie });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function check(name, condition, extra) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

async function run() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
  console.log('\n=== Tech Defenders OS v3 feature regression ===\n');
  try {
    const login = await req('POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'Admin@123' });
    const cookie = login.cookie;
    check('admin login works', login.status === 200 && !!cookie);

    let response = await req('GET', '/api/v3/admin/branches', null, cookie);
    check('v3 endpoints are authenticated and mounted', response.status === 200 && Array.isArray(response.json.branches));

    response = await req('POST', '/api/v3/admin/branches', { name: 'Ahmedabad Operations', code: 'AMD', stateCode: '24' }, cookie);
    const branch = response.json.branch;
    check('branch master creates organization-scoped branch', response.status === 201 && branch.code === 'AMD');
    const duplicateBranch = await req('POST', '/api/v3/admin/branches', { name: 'Duplicate', code: 'AMD' }, cookie);
    check('duplicate branch code is rejected', duplicateBranch.status === 409);

    response = await req('POST', '/api/crm/customers', { name: 'V3 Test Customer', email: 'customer@v3.test', stateCode: '24', paymentTermsDays: 30 }, cookie);
    const customer = response.json.customer;
    response = await req('POST', '/api/purchase/suppliers', { name: 'V3 Test Supplier', email: 'supplier@v3.test', stateCode: '24' }, cookie);
    const supplier = response.json.supplier;
    response = await req('POST', '/api/inventory/warehouses', { name: 'V3 Test Warehouse', location: 'Disposable' }, cookie);
    const warehouse = response.json.warehouse;
    response = await req('POST', '/api/inventory/products', {
      sku: 'V3-ITEM-1', name: 'V3 Test Item', type: 'finished', hsn: '8471', uom: 'Nos', gstRate: 18,
      purchasePrice: 100, salePrice: 180, warehouseId: warehouse.id, openingStock: 10, minStock: 12
    }, cookie);
    const product = response.json.product;
    check('v3 fixtures created in isolated database', !!customer && !!supplier && !!warehouse && !!product);

    response = await req('POST', '/api/v3/crm/leads-import', { records: [
      { name: 'Imported Lead', email: 'lead@v3.test', company: 'V3 Buyer', value: 250000 },
      { name: 'Duplicate Lead', email: 'lead@v3.test' }
    ] }, cookie);
    check('lead import validates and deduplicates within the batch', response.status === 200 && response.json.imported === 1 && response.json.skipped === 1, response.json);
    response = await req('GET', '/api/v3/crm/lead-insights', null, cookie);
    check('lead intelligence returns explainable score', response.status === 200 && response.json.leads[0].intelligence.reasons.includes('value'));

    response = await req('POST', '/api/v3/sales/proformas', {
      customerId: customer.id, lines: [{ name: 'Security assessment', qty: 1, rate: 1000, gstRate: 18 }]
    }, cookie);
    const proforma = response.json.document;
    check('manual proforma calculates GST', response.status === 201 && proforma.totals.grandTotal === 1180);
    response = await req('POST', `/api/v3/sales/proformas/${proforma.id}/convert-invoice`, {}, cookie);
    const convertedInvoice = response.json.invoice;
    check('proforma converts once to invoice with journal', response.status === 200 && !!store.findOne('journals', item => item.refId === convertedInvoice.id));
    const duplicateConvert = await req('POST', `/api/v3/sales/proformas/${proforma.id}/convert-invoice`, {}, cookie);
    check('duplicate proforma conversion is blocked', duplicateConvert.status === 409);

    response = await req('POST', '/api/v3/sales/delivery-challans', {
      customerId: customer.id, vehicleNo: 'GJ01TEST', lines: [{ name: 'Package', qty: 1, rate: 0, gstRate: 0 }]
    }, cookie);
    check('delivery challan is created independently', response.status === 201 && response.json.deliveryChallan.status === 'issued');
    response = await req('POST', '/api/v3/sales/debit-notes', {
      customerId: customer.id, reason: 'Additional service', lines: [{ name: 'Additional work', qty: 1, rate: 100, gstRate: 18 }]
    }, cookie);
    check('debit note updates accounting', response.status === 201 && !!store.findOne('journals', item => item.refId === response.json.debitNote.id));

    response = await req('POST', '/api/v3/purchase/invoices', {
      supplierId: supplier.id, supplierInvoiceNo: 'SUP-001',
      lines: [{ productId: product.id, description: product.name, qty: 5, rate: 100, taxPct: 18 }]
    }, cookie);
    const purchaseInvoice = response.json.purchaseInvoice;
    check('purchase invoice posts payable journal', response.status === 201 && purchaseInvoice.totals.grandTotal === 590 && !!store.findOne('journals', item => item.refId === purchaseInvoice.id));
    const duplicateInvoice = await req('POST', '/api/v3/purchase/invoices', {
      supplierId: supplier.id, supplierInvoiceNo: 'SUP-001', lines: [{ description: 'Again', qty: 1, rate: 1, taxPct: 0 }]
    }, cookie);
    check('duplicate supplier invoice is blocked', duplicateInvoice.status === 409);

    response = await req('POST', '/api/v3/purchase/returns', {
      purchaseInvoiceId: purchaseInvoice.id, warehouseId: warehouse.id, reason: 'Defective', lines: [{ index: 0, qty: 1 }]
    }, cookie);
    check('purchase return adjusts stock and accounting', response.status === 201 && store.find('stockLedger', item => item.refId === response.json.purchaseReturn.id)[0].qty === -1);
    response = await req('POST', '/api/v3/purchase/payments', { supplierId: supplier.id, amount: 100, mode: 'bank', reference: 'UTR-V3' }, cookie);
    check('supplier payment posts vendor journal', response.status === 201 && !!store.findOne('journals', item => item.refId === response.json.supplierPayment.id));
    response = await req('GET', `/api/v3/purchase/vendor-ledger/${supplier.id}`, null, cookie);
    check('vendor ledger includes invoices, returns and payments', response.status === 200 && response.json.rows.length === 3 && response.json.closingBalance === 372);

    response = await req('POST', '/api/v3/inventory/categories', { name: 'Cyber Hardware', code: 'CYB' }, cookie);
    check('inventory category master works', response.status === 201);
    response = await req('POST', '/api/v3/inventory/reservations', { productId: product.id, warehouseId: warehouse.id, qty: 3, note: 'Customer commitment' }, cookie);
    const reservation = response.json.reservation;
    check('stock reservation uses warehouse availability', response.status === 201 && response.json.available === 6);
    response = await req('GET', `/api/v3/inventory/availability/${product.id}`, null, cookie);
    check('availability separates on-hand and reserved stock', response.status === 200 && response.json.warehouses[0].onHand === 9 && response.json.warehouses[0].reserved === 3);
    response = await req('PATCH', `/api/v3/inventory/reservations/${reservation.id}/release`, {}, cookie);
    check('reservation release restores availability', response.status === 200 && response.json.reservation.status === 'released');

    response = await req('GET', '/api/v3/finance/general-ledger?limit=200', null, cookie);
    check('general ledger exposes posted entries with running balances', response.status === 200 && response.json.rows.length > 0 && response.json.rows[0].runningBalance !== undefined);
    const balanceSheet = await req('GET', '/api/v3/finance/balance-sheet', null, cookie);
    const cashFlow = await req('GET', '/api/v3/finance/cash-flow', null, cookie);
    check('balance sheet and cash flow are calculated', balanceSheet.status === 200 && cashFlow.status === 200 && cashFlow.json.totals.net === -100);

    response = await req('POST', '/api/v3/approvals/workflows', { name: 'Expense Review', entityType: 'expense', minimumAmount: 1000, approverRole: 'admin' }, cookie);
    const workflow = response.json.workflow;
    response = await req('POST', '/api/v3/approvals/requests', { workflowId: workflow.id, entityType: 'expense', entityId: 'expense-test', entityNumber: 'EXP-TEST', amount: 1500 }, cookie);
    const approval = response.json.approvalRequest;
    check('configurable workflow creates approval request', response.status === 201 && approval.status === 'pending');
    response = await req('POST', `/api/v3/approvals/requests/${approval.id}/decision`, { decision: 'approved', note: 'Checked' }, cookie);
    check('authorized role decides approval', response.status === 200 && response.json.approvalRequest.status === 'approved');

    response = await req('GET', '/api/v3/ai/status', null, cookie);
    check('AI disabled state is honest and review is mandatory', response.status === 200 && response.json.configured === false && response.json.reviewRequired === true);
    response = await req('POST', '/api/v3/ai/quotation-draft', { requestText: 'Create a quotation for ten managed security licenses' }, cookie);
    check('disabled AI never returns fake draft success', response.status === 503 && response.json.code === 'AI_DISABLED');

    response = await req('PATCH', '/api/v3/admin/integrations/email', { enabled: true }, cookie);
    check('integration reports missing credentials instead of success', response.status === 200 && response.json.integration.status === 'missing_credentials');
    response = await req('PATCH', '/api/v3/admin/integrations/email', { enabled: true, apiKey: 'must-not-store' }, cookie);
    check('integration secrets cannot be stored through API', response.status === 400);

    response = await req('POST', '/api/v3/automation/rules', { name: 'Daily Low Stock', type: 'low_stock_alert', schedule: 'daily' }, cookie);
    const rule = response.json.automationRule;
    const firstRun = await req('POST', `/api/v3/automation/rules/${rule.id}/run`, {}, cookie);
    const secondRun = await req('POST', `/api/v3/automation/rules/${rule.id}/run`, {}, cookie);
    check('automation job runs and matches low stock', firstRun.status === 200 && firstRun.json.job.result.matched >= 1);
    check('automation is idempotent per rule/day', secondRun.status === 200 && secondRun.json.duplicate === true && secondRun.json.job.id === firstRun.json.job.id);

    const auditEvents = store.find('auditEvents');
    const hashed = auditEvents.filter(item => item.currentHash);
    check('new audit events are hash chained', hashed.length > 5 && hashed.slice(1).every((item, index) => item.previousHash === hashed[index].currentHash));

    response = await req('GET', '/js/pages-advanced.js');
    check('v3 UI bundle contains advanced workflows', response.status === 200 && response.raw.includes('AI Quote Draft') && response.raw.includes('Approval Center'));
    response = await req('POST', '/api/v3/admin/branches', { name: 'Blocked Origin' }, cookie, { Origin: 'https://evil.example' });
    check('unsafe cross-origin write is blocked', response.status === 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.flushSync();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error('V3 TEST CRASHED:', error);
  store.flushSync();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.exitCode = 1;
});

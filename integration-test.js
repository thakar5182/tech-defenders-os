/** Live-equivalent provider contract tests using a local disposable mock server. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-integrations-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTO_SEED = 'true';
process.env.AUTO_BACKUP = 'false';
process.env.AUTO_AUTOMATION = 'false';
process.env.JWT_SECRET = 'integration-test-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.BREVO_SENDER_EMAIL = 'verified@techdefenders.in';
process.env.MSG91_AUTH_KEY = 'test-msg91-key';
process.env.META_WHATSAPP_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = '123456789';
process.env.META_GRAPH_VERSION = 'v23.0';
process.env.META_APP_SECRET = 'test-meta-app-secret';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-meta-verify';
process.env.SANDBOX_API_KEY = 'test-sandbox-key';
process.env.SANDBOX_API_SECRET = 'test-sandbox-secret';
process.env.SANDBOX_EINVOICE_USERNAME = 'test-irp-user';
process.env.SANDBOX_EINVOICE_PASSWORD = 'test-irp-password';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';

let appPort;
let mockPort;
let passed = 0;
let failed = 0;
const calls = [];

function request(port, method, requestPath, body, cookie, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
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
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function check(name, condition, extra) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v3/smtp/email') return res.end(JSON.stringify({ messageId: 'brevo-message-001' }));
    if (req.url === '/api/v5/flow/') return res.end(JSON.stringify({ type: 'success', request_id: 'msg91-request-001' }));
    if (req.url === '/v23.0/123456789/messages') return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.001' }] }));
    if (req.url === '/authenticate') return res.end(JSON.stringify({ access_token: 'sandbox-jwt' }));
    if (req.url.startsWith('/gst/compliance/e-invoice/tax-payer/authenticate')) {
      return res.end(JSON.stringify({ data: { Status: 1, access_token: 'irp-session', expiry: Date.now() + 3600000 } }));
    }
    if (req.url === '/gst/compliance/e-invoice/tax-payer/invoice') {
      return res.end(JSON.stringify({ transaction_id: 'gst-txn-001', data: { Status: 1, Data: { Irn: 'IRN-TEST-001', AckNo: 12345, AckDt: '29/08/2026 12:00:00', SignedInvoice: 'signed-invoice', SignedQRCode: 'signed-qr' } } }));
    }
    if (/\/gst\/compliance\/e-invoice\/tax-payer\/invoice\/IRN-TEST-001\/e-way-bill/.test(req.url)) {
      return res.end(JSON.stringify({ transaction_id: 'gst-txn-002', data: { Status: 1, Data: { EwbNo: 601000000001, EwbDt: '29/08/2026 12:05:00', EwbValidTill: '30/08/2026 23:59:00' } } }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'mock route not found' }));
  });
});

async function run() {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  mockPort = mock.address().port;
  const mockRoot = `http://127.0.0.1:${mockPort}`;
  process.env.TD_TEST_BREVO_BASE_URL = mockRoot;
  process.env.TD_TEST_MSG91_BASE_URL = mockRoot;
  process.env.TD_TEST_META_BASE_URL = mockRoot;
  process.env.TD_TEST_SANDBOX_BASE_URL = mockRoot;

  const app = require('./server');
  const store = require('./db/store');
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  appPort = appServer.address().port;
  console.log('\n=== Tech Defenders OS provider integration regression ===\n');
  try {
    let response = await request(appPort, 'POST', '/api/auth/login', { email: 'admin@techdefenders.in', password: 'TestStaffAccount@123' });
    const cookie = response.cookie;
    check('admin login works', response.status === 200 && !!cookie);

    response = await request(appPort, 'POST', '/api/auth/login/request-otp', { email: 'admin@techdefenders.in' });
    const otpEmailCall = calls.find(call => call.url === '/v3/smtp/email' && /verification code/i.test(call.body.subject || ''));
    const loginOtp = String(otpEmailCall?.body?.subject || '').match(/\b(\d{6})\b/)?.[1];
    check('email OTP uses the real Brevo adapter without exposing the code in the API response',
      response.status === 202 && !!loginOtp && !response.raw.includes(loginOtp));
    const otpLogin = await request(appPort, 'POST', '/api/auth/login/verify-otp', { challengeId: response.json.challengeId, otp: loginOtp });
    check('emailed login OTP creates an HTTP-only session', otpLogin.status === 200 && !!otpLogin.cookie);

    for (const provider of ['email', 'sms', 'whatsapp', 'gst']) {
      response = await request(appPort, 'PATCH', `/api/integrations/${provider}`, { enabled: true }, cookie);
      check(`${provider} enables with configured credentials`, response.status === 200 && response.json.integration.configured === true, response.json);
    }
    response = await request(appPort, 'GET', '/api/integrations/status', null, cookie);
    check('status API never returns secret values', response.status === 200 && !response.raw.includes('test-brevo-key') && response.json.integrations.length === 4);

    response = await request(appPort, 'POST', '/api/integrations/email/send', {
      to: 'customer@example.com', subject: 'Invoice', text: 'Your invoice is ready', idempotencyKey: 'email-once'
    }, cookie);
    const emailId = response.json.delivery?.id;
    check('Brevo email adapter records accepted provider ID', response.status === 202 && response.json.delivery.providerId === 'brevo-message-001');
    const duplicateEmail = await request(appPort, 'POST', '/api/integrations/email/send', {
      to: 'customer@example.com', subject: 'Invoice', text: 'Duplicate', idempotencyKey: 'email-once'
    }, cookie);
    check('email idempotency prevents duplicate provider call', duplicateEmail.status === 200 && duplicateEmail.json.duplicate === true && duplicateEmail.json.delivery.id === emailId && calls.filter(call => call.url === '/v3/smtp/email').length === 2);

    response = await request(appPort, 'POST', '/api/integrations/sms/send', {
      to: '9876543210', templateId: 'DLT-FLOW-001', variables: { VAR1: 'Invoice' }
    }, cookie);
    check('MSG91 Flow adapter sends normalized India mobile', response.status === 202 && response.json.delivery.providerId === 'msg91-request-001' && calls.find(call => call.url === '/api/v5/flow/').body.recipients[0].mobiles === '919876543210');

    response = await request(appPort, 'POST', '/api/integrations/whatsapp/send', {
      to: '+91 98765 43210', templateName: 'invoice_ready', language: 'en_US', parameters: ['INV-1']
    }, cookie);
    check('Meta WhatsApp adapter uses approved template payload', response.status === 202 && response.json.delivery.providerId === 'wamid.001' && calls.find(call => call.url.includes('/messages')).body.type === 'template');

    response = await request(appPort, 'PATCH', '/api/admin/settings', {
      gstin: '24ABCDE1234F1Z5', stateCode: '24', legalName: 'Tech Defenders Private Limited',
      address: { line1: '1 Security Avenue', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' }
    }, cookie);
    check('GST-ready company master updates', response.status === 200 && response.json.org.gstin === '24ABCDE1234F1Z5');
    response = await request(appPort, 'POST', '/api/crm/customers', {
      name: 'GST Test Customer', email: 'gst@example.com', phone: '9876543210', gstin: '27ABCDE1234F1Z5', stateCode: '27',
      billingAddress: { line1: '2 Buyer Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }
    }, cookie);
    const customer = response.json.customer;
    response = await request(appPort, 'POST', '/api/sales/invoices', {
      customerId: customer.id, placeOfSupply: '27', lines: [{ name: 'Security appliance', hsn: '84713010', uom: 'Nos', qty: 1, rate: 10000, gstRate: 18 }]
    }, cookie);
    const invoice = response.json.invoice;
    check('GST test invoice created with complete B2B data', response.status === 200 && invoice.totals.grandTotal === 11800);

    response = await request(appPort, 'POST', '/api/integrations/gst/verify', {}, cookie);
    check('Sandbox + IRP authentication flow verifies', response.status === 200 && response.json.verified === true);
    response = await request(appPort, 'POST', `/api/integrations/gst/einvoice/${invoice.id}`, {}, cookie);
    check('GST e-Invoice stores IRN and acknowledgement', response.status === 201 && response.json.submission.irn === 'IRN-TEST-001' && store.byId('invoices', invoice.id).gstEinvoice.irn === 'IRN-TEST-001', response.json);
    const duplicateIrn = await request(appPort, 'POST', `/api/integrations/gst/einvoice/${invoice.id}`, {}, cookie);
    check('repeat GST e-Invoice request does not resubmit', duplicateIrn.status === 200 && duplicateIrn.json.duplicate === true && calls.filter(call => call.url === '/gst/compliance/e-invoice/tax-payer/invoice').length === 1);

    response = await request(appPort, 'POST', `/api/integrations/gst/ewaybill/${invoice.id}`, {
      distance: 25, transMode: '1', vehicleNo: 'GJ01AB1234', vehicleType: 'R'
    }, cookie);
    check('E-Way Bill stores provider number and validity', response.status === 201 && response.json.submission.ewayBillNo === '601000000001' && store.byId('invoices', invoice.id).gstEwayBill.ewayBillNo === '601000000001', response.json);

    const metaPayload = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.001', status: 'delivered' }] } }] }] };
    const metaRaw = JSON.stringify(metaPayload);
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(metaRaw).digest('hex');
    response = await request(appPort, 'POST', '/api/integrations/webhooks/meta', metaPayload, null, { 'X-Hub-Signature-256': signature });
    check('Meta webhook signature updates delivery state', response.status === 200 && store.findOne('messageDeliveries', item => item.providerId === 'wamid.001').status === 'delivered');
    response = await request(appPort, 'POST', '/api/integrations/webhooks/meta', metaPayload, null, { 'X-Hub-Signature-256': 'sha256=wrong' });
    check('invalid Meta webhook signature is rejected', response.status === 401);

    response = await request(appPort, 'GET', '/api/integrations/deliveries', null, cookie);
    check('delivery log is tenant-scoped and recipient-masked', response.status === 200 && response.json.deliveries.length === 3 && response.json.deliveries.every(item => !item.recipient.includes('9876543210') && !item.recipient.includes('customer@example.com')));
    response = await request(appPort, 'GET', '/api/integrations/gst/submissions', null, cookie);
    check('GST submission history contains IRN and E-Way Bill', response.status === 200 && response.json.submissions.length === 2);
  } finally {
    await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => mock.close(resolve));
    store.flushSync();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });

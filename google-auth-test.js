/** Google Sign-In route regression test with a local verifier stub. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-google-'));
process.env.AUTO_SEED = 'true';
process.env.AUTO_BACKUP = 'false';
process.env.AUTO_AUTOMATION = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'google-test-secret-that-is-longer-than-32-characters';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_AUTO_SIGNUP = 'true';

const googleIdentity = require('./src/services/google-identity');
googleIdentity.verifyCredential = async credential => {
  if (credential === 'existing-user') return { sub: 'google-existing', email: 'admin@techdefenders.in', name: 'Existing Admin', picture: '' };
  if (credential === 'new-user') return { sub: 'google-new', email: 'new.google@example.test', name: 'New Google User', picture: '' };
  throw new Error('Invalid test credential');
};

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

(async () => {
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    let response = await request(port, 'GET', '/api/auth/google/config');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.enabled, true);

    response = await request(port, 'POST', '/api/auth/google', { credential: 'existing-user' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.user.role, 'admin');
    assert.ok(response.headers['set-cookie']);
    console.log('  PASS  verified Google email links to an existing active account');

    response = await request(port, 'POST', '/api/auth/google', { credential: 'new-user' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.user.role, 'admin');
    assert.notStrictEqual(response.json.user.role, 'super_admin');
    console.log('  PASS  Google auto-signup creates only a normal organization admin');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error('  FAIL ', error); process.exit(1); });

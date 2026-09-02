/** Durable-store and Google identity security regression tests (no network). */
'use strict';
const assert = require('assert');

class FakePostgresPool {
  constructor() { this.rows = new Map(); }
  async query(sql) {
    if (/SELECT name, records/i.test(sql)) {
      return { rows: [...this.rows].map(([name, records]) => ({ name, records: structuredClone(records) })) };
    }
    return { rows: [] };
  }
  async connect() {
    return {
      query: async (sql, params) => {
        if (/INSERT INTO td_collections/i.test(sql)) this.rows.set(params[0], JSON.parse(params[1]));
        return { rows: [] };
      },
      release() {}
    };
  }
  async end() {}
}

(async () => {
  const pool = new FakePostgresPool();
  const store = require('./db/store');
  await store.initialize({ pool, databaseUrl: 'postgres://test', force: true });
  assert.strictEqual(store.status().durable, true);
  const account = store.insert('users', { email: 'persistent@example.test', active: true });
  await store.flush();

  store._resetForTests();
  await store.initialize({ pool, databaseUrl: 'postgres://test', force: true });
  assert.strictEqual(store.byId('users', account.id).email, 'persistent@example.test');
  console.log('  PASS  PostgreSQL-backed account survives process-memory restart');

  const { validatePayload } = require('./src/services/google-identity');
  const identity = validatePayload({
    iss: 'https://accounts.google.com', sub: 'google-sub-1',
    email: 'Verified@Example.test', email_verified: true, name: 'Verified User'
  });
  assert.strictEqual(identity.email, 'verified@example.test');
  assert.throws(() => validatePayload({
    iss: 'https://accounts.google.com', sub: 'google-sub-2',
    email: 'unverified@example.test', email_verified: false
  }), /not verified/);
  assert.throws(() => validatePayload({
    iss: 'https://attacker.example', sub: 'google-sub-3',
    email: 'verified@example.test', email_verified: true
  }), /issuer/);
  console.log('  PASS  Google identity requires verified email and trusted issuer');
})().catch(error => { console.error('  FAIL ', error); process.exit(1); });

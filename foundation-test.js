/** Phase 1 technical foundation regression. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-foundation-'));
process.env.AUTO_SEED = 'false'; process.env.NODE_ENV = 'test';

let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('  PASS  ' + name); }

class MigrationPool {
  constructor() { this.sql = []; this.applied = []; }
  async query(sql) { this.sql.push(String(sql)); if (/SELECT version FROM td_schema_migrations/i.test(sql)) return { rows: this.applied.map(version => ({ version })) }; return { rows: [] }; }
  async connect() { return { query: async (sql, params) => { this.sql.push(String(sql)); if (/INSERT INTO td_schema_migrations/i.test(sql)) this.applied.push(params[0]); return { rows: [] }; }, release() {} }; }
}

(async () => {
  console.log('\n=== Phase 1 technical foundation regression ===\n');
  const { MIGRATIONS, runMigrations } = require('./db/migrations');
  const pool = new MigrationPool();
  const version = await runMigrations(pool);
  check('versioned migrations apply in order', version === MIGRATIONS.at(-1).version && pool.applied.join(',') === '1,2');
  await runMigrations(pool);
  check('database migrations are idempotent', pool.applied.length === 2);
  check('normalized records, file blobs and job leases are created', ['td_records', 'td_files', 'td_job_leases'].every(table => pool.sql.some(sql => sql.includes(table))));

  const store = require('./db/store'); store.load();
  const fileStorage = require('./src/services/file-storage');
  const saved = await fileStorage.put({ orgId: 'org-one', filename: 'agreement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('phase-one-file') });
  const loaded = await fileStorage.get(saved.storageKey, 'org-one');
  check('private file storage preserves bytes and checksum', loaded.buffer.toString() === 'phase-one-file' && loaded.sha256 === saved.sha256);
  check('local file storage is tenant isolated', await fileStorage.get(saved.storageKey, 'org-two') === null);
  check('private file can be removed', await fileStorage.remove(saved.storageKey, 'org-one') === true && await fileStorage.get(saved.storageKey, 'org-one') === null);

  const queue = require('./src/services/job-queue');
  let executions = 0;
  queue.register('test.foundation', async payload => { executions++; return { value: payload.value + 1 }; });
  const first = queue.enqueue('test.foundation', { value: 4 }, { idempotencyKey: 'foundation-once' });
  const duplicate = queue.enqueue('test.foundation', { value: 99 }, { idempotencyKey: 'foundation-once' });
  check('job queue enforces idempotency keys', first.id === duplicate.id);
  const run = await queue.runOnce();
  const completed = store.byId('backgroundJobs', first.id);
  check('durable job queue executes and records result', run.processed === 1 && executions === 1 && completed.status === 'completed' && completed.result.value === 5);

  const monitoring = require('./src/services/monitoring').snapshot();
  check('monitoring reports uptime, request and memory metrics', Number.isFinite(monitoring.uptimeSeconds) && Number.isFinite(monitoring.memoryMb.rss));
  check('storage status exposes schema readiness fields', Object.prototype.hasOwnProperty.call(store.status(), 'schemaVersion') && Object.prototype.hasOwnProperty.call(store.status(), 'normalizedRecords'));
  await store.close();
  console.log(`\n=== Results: ${passed}/${passed} passed ===\n`);
})().catch(error => { console.error('  FAIL ', error); process.exit(1); });

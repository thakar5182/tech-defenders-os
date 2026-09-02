/**
 * Tech Defenders Business OS - Data Layer
 * ---------------------------------------
 * Synchronous in-memory document API backed by either PostgreSQL
 * (DATABASE_URL) for production or atomic JSON files for local use/tests.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const COLLECTIONS = [
  'organizations', 'branches', 'users', 'sequences',
  'leads', 'customers', 'suppliers', 'deals', 'tasks', 'activities',
  'products', 'productCategories', 'warehouses', 'stockReservations',
  'quotations', 'proformas', 'salesOrders', 'deliveryChallans',
  'invoices', 'receipts', 'creditNotes', 'debitNotes',
  'requisitions', 'rfqs', 'purchaseOrders', 'grns',
  'purchaseInvoices', 'purchaseReturns', 'supplierPayments',
  'stockLedger', 'boms', 'jobOrders',
  'amcContracts', 'tickets', 'ticketMessages',
  'accounts', 'journals', 'expenses', 'bankTransactions',
  'employees', 'leaveRequests',
  'approvalWorkflows', 'approvalRequests',
  'automationRules', 'backgroundJobs', 'integrationConfigs', 'messageDeliveries',
  'importJobs', 'importFiles', 'importRecords', 'importMappings', 'importErrors',
  'clientDocuments',
  'emailTemplates', 'emailCampaigns', 'emailQueue', 'communicationLogs',
  'automationExecutions', 'whatsappIntegrations',
  'providerWebhooks', 'gstSubmissions', 'aiDrafts', 'authChallenges',
  'savedReports', 'notifications', 'auditEvents'
];

const db = {};
const dirty = new Set();
let loaded = false;
let mode = 'json';
let pool = null;
let timer = null;
let writeChain = Promise.resolve();
let lastPersistenceError = null;

function filePath(col) { return path.join(DATA_DIR, col + '.json'); }
function emptyMemory() { for (const col of COLLECTIONS) db[col] = []; }

function loadJsonIntoMemory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const col of COLLECTIONS) {
    const file = filePath(col);
    db[col] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  }
}

function load() {
  if (loaded) return;
  if (process.env.DATABASE_URL) {
    throw new Error('PostgreSQL storage must be initialized with await store.initialize() before use');
  }
  mode = 'json';
  loadJsonIntoMemory();
  loaded = true;
}

async function initialize(options = {}) {
  if (loaded && !options.force) return;
  const databaseUrl = options.databaseUrl === undefined ? process.env.DATABASE_URL : options.databaseUrl;
  if (!databaseUrl && !options.pool) {
    load();
    return;
  }

  mode = 'postgres';
  pool = options.pool;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Math.max(1, Math.min(Number(process.env.DATABASE_POOL_MAX) || 5, 10)),
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 15000
    });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS td_collections (
      name TEXT PRIMARY KEY,
      records JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const result = await pool.query('SELECT name, records FROM td_collections');
  emptyMemory();
  for (const row of result.rows) {
    if (COLLECTIONS.includes(row.name) && Array.isArray(row.records)) db[row.name] = row.records;
  }
  loaded = true;
  lastPersistenceError = null;

  if (result.rows.length === 0 && process.env.MIGRATE_JSON_TO_DATABASE === 'true') {
    for (const col of COLLECTIONS) {
      const file = filePath(col);
      db[col] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      dirty.add(col);
    }
    await flush();
  }
}

function ensureLoaded() { if (!loaded) load(); }

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush().catch(error => console.error('[storage] Persistence failed:', error.message));
  }, 40);
}

function save(...cols) {
  ensureLoaded();
  for (const col of cols) {
    if (!COLLECTIONS.includes(col)) throw new Error(`Unknown collection: ${col}`);
    dirty.add(col);
  }
  scheduleFlush();
}

function writeJsonCollections(list, snapshots) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const col of list) {
    const file = filePath(col);
    fs.writeFileSync(file + '.tmp', JSON.stringify(snapshots[col]));
    fs.renameSync(file + '.tmp', file);
  }
}

async function writePostgresCollections(list, snapshots) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const col of list) {
      await client.query(
        `INSERT INTO td_collections (name, records, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (name) DO UPDATE
         SET records = EXCLUDED.records, updated_at = NOW()`,
        [col, JSON.stringify(snapshots[col])]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function flush() {
  ensureLoaded();
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty.size) return writeChain;

  const list = [...dirty];
  dirty.clear();
  const snapshots = Object.fromEntries(list.map(col => [col, structuredClone(db[col])]));
  writeChain = writeChain.catch(() => {}).then(async () => {
    try {
      if (mode === 'postgres') await writePostgresCollections(list, snapshots);
      else writeJsonCollections(list, snapshots);
      lastPersistenceError = null;
    } catch (error) {
      lastPersistenceError = error;
      for (const col of list) dirty.add(col);
      throw error;
    }
  });
  await writeChain;
  if (dirty.size) return flush();
}

function flushSync() {
  ensureLoaded();
  if (mode === 'postgres') {
    void flush().catch(error => console.error('[storage] Persistence failed:', error.message));
    return;
  }
  if (timer) { clearTimeout(timer); timer = null; }
  const list = [...dirty];
  dirty.clear();
  writeJsonCollections(list, Object.fromEntries(list.map(col => [col, db[col]])));
}

function id() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function insert(col, obj) {
  ensureLoaded();
  const rec = Object.assign({ id: id(), createdAt: now() }, obj);
  db[col].push(rec); save(col); return rec;
}
function insertMany(col, arr) {
  ensureLoaded();
  for (const obj of arr) db[col].push(Object.assign({ id: id(), createdAt: now() }, obj));
  save(col);
}
function update(col, recId, patch) {
  ensureLoaded();
  const rec = db[col].find(item => item.id === recId);
  if (!rec) return null;
  Object.assign(rec, patch, { updatedAt: now() }); save(col); return rec;
}
function remove(col, recId) {
  ensureLoaded();
  const index = db[col].findIndex(item => item.id === recId);
  if (index === -1) return false;
  db[col].splice(index, 1); save(col); return true;
}
function find(col, pred) { ensureLoaded(); return pred ? db[col].filter(pred) : db[col].slice(); }
function findOne(col, pred) { ensureLoaded(); return db[col].find(pred) || null; }
function byId(col, recId) { ensureLoaded(); return db[col].find(item => item.id === recId) || null; }
function isEmpty() { ensureLoaded(); return db.users.length === 0; }

function reset() {
  if (timer) { clearTimeout(timer); timer = null; }
  dirty.clear(); emptyMemory(); loaded = true;
  for (const col of COLLECTIONS) dirty.add(col);
  scheduleFlush();
}

function backupSync() {
  flushSync();
  const root = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(path.dirname(DATA_DIR), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(root, stamp);
  fs.mkdirSync(target, { recursive: true });
  for (const collection of COLLECTIONS) {
    fs.writeFileSync(path.join(target, collection + '.json'), JSON.stringify(db[collection] || []));
  }
  fs.writeFileSync(path.join(target, 'backup-manifest.json'), JSON.stringify({ createdAt: now(), mode, collections: COLLECTIONS }, null, 2));
  return target;
}

function status() {
  return { mode, durable: mode === 'postgres', ready: loaded && !lastPersistenceError,
    pendingCollections: dirty.size, error: lastPersistenceError ? 'persistence_error' : null };
}

async function close() {
  await flush();
  if (pool && typeof pool.end === 'function') await pool.end();
  pool = null;
}

function _resetForTests() {
  if (timer) { clearTimeout(timer); timer = null; }
  dirty.clear(); loaded = false; mode = 'json'; pool = null;
  writeChain = Promise.resolve(); lastPersistenceError = null;
  for (const col of COLLECTIONS) delete db[col];
}

module.exports = {
  db, COLLECTIONS, DATA_DIR, initialize, load, save, flush, flushSync, reset,
  backupSync, status, close, id, now, insert, insertMany, update, remove, find,
  findOne, byId, isEmpty, _resetForTests
};

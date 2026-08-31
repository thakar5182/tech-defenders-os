/**
 * Tech Defenders Business OS - Data Layer
 * ---------------------------------------
 * Zero-dependency persistent document store.
 * Each collection is a JSON file inside /data with atomic writes
 * (temp file + rename) so the server never serves corrupted state.
 *
 * All money/quantity math is done in plain numbers rounded to 2 decimals
 * at write time (r2 helper in src/util.js).
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
  'providerWebhooks', 'gstSubmissions', 'aiDrafts', 'authChallenges',
  'savedReports', 'notifications', 'auditEvents'
];

const db = {};
let loaded = false;

function load() {
  if (loaded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const c of COLLECTIONS) {
    const f = filePath(c);
    db[c] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  }
  loaded = true;
}

function filePath(col) {
  return path.join(DATA_DIR, col + '.json');
}

/* ---------- atomic batched save (debounced ~40ms) ---------- */
const dirty = new Set();
let timer = null;
function save(...cols) {
  for (const c of cols) dirty.add(c);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const list = [...dirty];
    dirty.clear();
    for (const col of list) {
      const f = filePath(col);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db[col]));
      fs.renameSync(tmp, f);
    }
  }, 40);
}
function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const col of new Set([...dirty])) {
    const f = filePath(col);
    fs.writeFileSync(f + '.tmp', JSON.stringify(db[col]));
    fs.renameSync(f + '.tmp', f);
  }
  dirty.clear();
}

/* ---------- helpers ---------- */
function id() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

function insert(col, obj) {
  load();
  const rec = Object.assign({ id: id(), createdAt: now() }, obj);
  db[col].push(rec);
  save(col);
  return rec;
}
function insertMany(col, arr) {
  load();
  for (const o of arr) db[col].push(Object.assign({ id: id(), createdAt: now() }, o));
  save(col);
}
function update(col, recId, patch) {
  load();
  const rec = db[col].find(r => r.id === recId);
  if (!rec) return null;
  Object.assign(rec, patch, { updatedAt: now() });
  save(col);
  return rec;
}
function remove(col, recId) {
  load();
  const i = db[col].findIndex(r => r.id === recId);
  if (i === -1) return false;
  db[col].splice(i, 1);
  save(col);
  return true;
}
function find(col, pred) {
  load();
  return pred ? db[col].filter(pred) : db[col].slice();
}
function findOne(col, pred) {
  load();
  return db[col].find(pred) || null;
}
function byId(col, recId) {
  load();
  return db[col].find(r => r.id === recId) || null;
}
function isEmpty() {
  load();
  return db.users.length === 0;
}

function reset() {
  if (timer) { clearTimeout(timer); timer = null; }
  dirty.clear();
  for (const c of COLLECTIONS) db[c] = [];
  loaded = true;
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
    const source = filePath(collection);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, collection + '.json'));
  }
  fs.writeFileSync(path.join(target, 'backup-manifest.json'), JSON.stringify({ createdAt: now(), dataDir: DATA_DIR, collections: COLLECTIONS }, null, 2));
  return target;
}

module.exports = { db, COLLECTIONS, DATA_DIR, load, save, flushSync, reset, backupSync, id, now, insert, insertMany, update, remove, find, findOne, byId, isEmpty };

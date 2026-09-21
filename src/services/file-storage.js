'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../../db/store');

const ROOT = path.resolve(process.env.FILE_STORAGE_DIR || path.join(store.DATA_DIR, 'files'));
const clean = (value, max = 180) => String(value || '').trim().slice(0, max);

function localPath(storageKey, orgId) {
  if (!/^[a-f0-9-]{36}$/.test(storageKey)) throw new Error('Invalid storage key');
  const tenant = crypto.createHash('sha256').update(String(orgId)).digest('hex').slice(0, 24);
  return path.join(ROOT, tenant, storageKey + '.bin');
}

async function put({ orgId, filename, mimeType, buffer }) {
  if (!orgId || !Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Organization and file payload are required');
  const maxBytes = (Number(process.env.FILE_STORAGE_MAX_MB) || 10) * 1024 * 1024;
  if (buffer.length > maxBytes) throw new Error(`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB storage limit`);
  const storageKey = crypto.randomUUID();
  const metadata = {
    storageKey, orgId: clean(orgId, 100), filename: clean(filename, 180) || 'file',
    mimeType: clean(mimeType, 120) || 'application/octet-stream', sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
  if (store.status().mode === 'postgres') {
    await store.query(
      `INSERT INTO td_files (storage_key, org_id, filename, mime_type, size_bytes, sha256, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [storageKey, metadata.orgId, metadata.filename, metadata.mimeType, metadata.sizeBytes, metadata.sha256, buffer]
    );
  } else {
    const file = localPath(storageKey, metadata.orgId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
  }
  return metadata;
}

async function get(storageKey, orgId) {
  if (store.status().mode === 'postgres') {
    const result = await store.query(
      'SELECT filename, mime_type, size_bytes, sha256, payload FROM td_files WHERE storage_key = $1 AND org_id = $2',
      [storageKey, String(orgId)]
    );
    const row = result.rows?.[0];
    return row ? { storageKey, filename: row.filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), sha256: row.sha256, buffer: Buffer.from(row.payload) } : null;
  }
  const file = localPath(storageKey, orgId);
  if (!fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  return { storageKey, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), buffer };
}

async function remove(storageKey, orgId) {
  if (store.status().mode === 'postgres') {
    const result = await store.query('DELETE FROM td_files WHERE storage_key = $1 AND org_id = $2', [storageKey, String(orgId)]);
    return result.rowCount > 0;
  }
  const file = localPath(storageKey, orgId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file); return true;
}

function status() {
  return { mode: store.status().mode === 'postgres' ? 'database-blob' : 'local-private', maxMb: Number(process.env.FILE_STORAGE_MAX_MB) || 10 };
}

module.exports = { put, get, remove, status };

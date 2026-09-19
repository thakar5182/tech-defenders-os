'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../../db/store');

const key = () => {
  const source = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  if (source.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be configured with at least 32 characters');
  return crypto.createHash('sha256').update(source).digest();
};
const safeDir = () => path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(store.DATA_DIR), 'encrypted-backups'));
function createEncryptedSnapshot(orgId, actorId) {
  const createdAt = new Date().toISOString();
  const records = {};
  for (const name of store.COLLECTIONS) records[name] = store.find(name, row => row.orgId === orgId || (name === 'organizations' && row.id === orgId));
  const plain = Buffer.from(JSON.stringify({ version: 1, orgId, createdAt, records }));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]), tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from('TDOSB1'), iv, tag, encrypted]);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  fs.mkdirSync(safeDir(), { recursive: true });
  const filename = 'tdos-' + orgId + '-' + createdAt.replace(/[:.]/g, '-') + '.enc';
  fs.writeFileSync(path.join(safeDir(), filename), payload, { mode: 0o600 });
  return store.insert('backupSnapshots', { orgId, createdBy: actorId, createdAt, filename, algorithm: 'aes-256-gcm', sha256: hash, sizeBytes: payload.length, storage: 'local-encrypted', status: 'verified' });
}
function verifySnapshot(snapshot) {
  const payload = fs.readFileSync(path.join(safeDir(), snapshot.filename));
  if (crypto.createHash('sha256').update(payload).digest('hex') !== snapshot.sha256) throw new Error('Backup integrity check failed');
  if (payload.subarray(0, 6).toString() !== 'TDOSB1') throw new Error('Unsupported backup format');
  const iv = payload.subarray(6, 18), tag = payload.subarray(18, 34), body = payload.subarray(34);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv); decipher.setAuthTag(tag);
  const parsed = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  return { orgId: parsed.orgId, createdAt: parsed.createdAt, collections: Object.keys(parsed.records).length };
}
module.exports = { createEncryptedSnapshot, verifySnapshot };

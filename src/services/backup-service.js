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
async function uploadToRemote(snapshot) {
  const accessKey=String(process.env.BACKUP_S3_ACCESS_KEY_ID||'').trim(), secret=String(process.env.BACKUP_S3_SECRET_ACCESS_KEY||'').trim(), bucket=String(process.env.BACKUP_S3_BUCKET||'').trim();
  if (!accessKey || !secret || !bucket) return { configured:false, uploaded:false };
  const region=String(process.env.BACKUP_S3_REGION||'auto').trim(), prefix=String(process.env.BACKUP_S3_PREFIX||'tech-defenders-os').replace(/^\\/|\\/$/g,''), endpoint=new URL(process.env.BACKUP_S3_ENDPOINT||'https://s3.'+region+'.amazonaws.com'), keyName=[prefix,snapshot.orgId,snapshot.filename].filter(Boolean).join('/'), target=new URL(endpoint);
  if (process.env.BACKUP_S3_PATH_STYLE !== 'false') target.pathname='/'+bucket+'/'+keyName.split('/').map(encodeURIComponent).join('/'); else { target.hostname=bucket+'.'+endpoint.hostname; target.pathname='/'+keyName.split('/').map(encodeURIComponent).join('/'); }
  const payload=fs.readFileSync(path.join(safeDir(),snapshot.filename)), payloadHash=crypto.createHash('sha256').update(payload).digest('hex'), now=new Date(), amzDate=now.toISOString().replace(/[:-]|\\.\\d{3}/g,''), dateStamp=amzDate.slice(0,8), host=target.host;
  const hmac=(secretValue,value,encoding)=>crypto.createHmac('sha256',secretValue).update(value,'utf8').digest(encoding);
  const canonicalHeaders='host:'+host+'\\n'+'x-amz-content-sha256:'+payloadHash+'\\n'+'x-amz-date:'+amzDate+'\\n', signedHeaders='host;x-amz-content-sha256;x-amz-date', canonical='PUT\\n'+target.pathname+'\\n\\n'+canonicalHeaders+'\\n'+signedHeaders+'\\n'+payloadHash, scope=dateStamp+'/'+region+'/s3/aws4_request', stringToSign='AWS4-HMAC-SHA256\\n'+amzDate+'\\n'+scope+'\\n'+crypto.createHash('sha256').update(canonical).digest('hex'), kDate=hmac('AWS4'+secret,dateStamp), kRegion=hmac(kDate,region), kService=hmac(kRegion,'s3'), signature=hmac(hmac(kService,'aws4_request'),stringToSign,'hex');
  const response=await fetch(target,{method:'PUT',headers:{host,'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate,authorization:'AWS4-HMAC-SHA256 Credential='+accessKey+'/'+scope+', SignedHeaders='+signedHeaders+', Signature='+signature,'content-type':'application/octet-stream'},body:payload});
  if(!response.ok)throw new Error('Remote backup upload failed ('+response.status+')');
  return {configured:true,uploaded:true,remoteKey:keyName,provider:process.env.BACKUP_S3_PROVIDER||'s3-compatible'};
}
async function createAndUpload(orgId,actorId){const snapshot=createEncryptedSnapshot(orgId,actorId);try{const remote=await uploadToRemote(snapshot);return store.update('backupSnapshots',snapshot.id,{storage:remote.uploaded?'local+remote-encrypted':'local-encrypted',remoteKey:remote.remoteKey||null,remoteProvider:remote.provider||null,remoteStatus:remote.uploaded?'uploaded':'not_configured'});}catch(error){return store.update('backupSnapshots',snapshot.id,{status:'remote_upload_failed',remoteStatus:'failed',remoteError:String(error.message).slice(0,300)});}}

function createPortableSystemExport() {
  const createdAt = new Date().toISOString();
  const records = {};
  for (const name of store.COLLECTIONS) records[name] = store.find(name);
  const plain = Buffer.from(JSON.stringify({ version: 1, scope: 'system', createdAt, records }));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from('TDOSB1'), iv, tag, encrypted]);
  return {
    filename: 'tdos-system-' + createdAt.replace(/[:.]/g, '-') + '.enc',
    payload,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    sizeBytes: payload.length,
    createdAt
  };
}
\nmodule.exports = { createEncryptedSnapshot, createAndUpload, uploadToRemote, verifySnapshot, createPortableSystemExport };

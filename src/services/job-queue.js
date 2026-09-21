'use strict';
const crypto = require('crypto');
const store = require('../../db/store');

const handlers = new Map();
const workerId = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
let timer = null;
let running = false;
const counters = { completed: 0, failed: 0, retried: 0 };

function register(type, handler) {
  if (!type || typeof handler !== 'function') throw new Error('Job type and handler are required');
  handlers.set(type, handler);
}

function enqueue(type, payload = {}, options = {}) {
  if (!handlers.has(type) && options.allowUnregistered !== true) throw new Error(`No job handler registered for ${type}`);
  const key = String(options.idempotencyKey || '');
  if (key) {
    const existing = store.findOne('backgroundJobs', job => job.queue === 'foundation' && job.type === type && job.idempotencyKey === key && !['failed', 'cancelled'].includes(job.status));
    if (existing) return existing;
  }
  return store.insert('backgroundJobs', {
    queue: 'foundation', type, payload, idempotencyKey: key || null,
    status: 'queued', attempts: 0, maxAttempts: Math.max(1, Number(options.maxAttempts) || 5),
    nextAttemptAt: options.runAt || new Date().toISOString(), createdBy: options.createdBy || 'system'
  });
}

async function acquireLease(job) {
  const leaseMs = Math.max(10_000, Number(process.env.JOB_LEASE_MS) || 120_000);
  if (store.status().mode !== 'postgres') return true;
  const result = await store.query(
    `INSERT INTO td_job_leases (job_id, owner_id, leased_until, updated_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'), NOW())
     ON CONFLICT (job_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, leased_until = EXCLUDED.leased_until, updated_at = NOW()
     WHERE td_job_leases.leased_until < NOW() OR td_job_leases.owner_id = EXCLUDED.owner_id
     RETURNING job_id`,
    [job.id, workerId, leaseMs]
  );
  return Boolean(result.rows?.length);
}

async function releaseLease(jobId) {
  if (store.status().mode === 'postgres') {
    await store.query('DELETE FROM td_job_leases WHERE job_id = $1 AND owner_id = $2', [jobId, workerId]).catch(() => {});
  }
}

async function runOnce(limit = Number(process.env.JOB_WORKER_BATCH) || 10) {
  if (running) return { processed: 0, busy: true };
  running = true;
  let processed = 0;
  try {
    const now = new Date().toISOString();
    const jobs = store.find('backgroundJobs', job => job.queue === 'foundation' && ['queued', 'retry'].includes(job.status) && String(job.nextAttemptAt || '') <= now)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, limit);
    for (const job of jobs) {
      const handler = handlers.get(job.type);
      if (!handler || !await acquireLease(job)) continue;
      processed++;
      const attempts = Number(job.attempts || 0) + 1;
      store.update('backgroundJobs', job.id, { status: 'running', attempts, lockedBy: workerId, startedAt: new Date().toISOString(), error: null });
      try {
        const result = await handler(structuredClone(job.payload || {}), job);
        store.update('backgroundJobs', job.id, { status: 'completed', completedAt: new Date().toISOString(), result: result == null ? null : result, lockedBy: null });
        counters.completed++;
      } catch (error) {
        const retry = attempts < Number(job.maxAttempts || 5);
        const delayMs = Math.min(60 * 60 * 1000, Math.pow(2, attempts) * 30_000);
        store.update('backgroundJobs', job.id, { status: retry ? 'retry' : 'failed', error: String(error.message || error).slice(0, 500), nextAttemptAt: retry ? new Date(Date.now() + delayMs).toISOString() : null, failedAt: retry ? null : new Date().toISOString(), lockedBy: null });
        retry ? counters.retried++ : counters.failed++;
      } finally { await releaseLease(job.id); }
    }
    await store.flush();
    return { processed, busy: false };
  } finally { running = false; }
}

function start(intervalMs = Number(process.env.JOB_WORKER_INTERVAL_MS) || 15_000) {
  if (timer) return;
  timer = setInterval(() => runOnce().catch(error => console.error('[job-worker]', error.message)), Math.max(1000, intervalMs));
  timer.unref();
  setTimeout(() => runOnce().catch(error => console.error('[job-worker]', error.message)), 1000).unref();
}

function stop() { if (timer) clearInterval(timer); timer = null; }
function status() {
  const jobs = store.find('backgroundJobs', job => job.queue === 'foundation');
  return { workerId, running, handlers: [...handlers.keys()], queued: jobs.filter(job => ['queued', 'retry'].includes(job.status)).length, failed: jobs.filter(job => job.status === 'failed').length, ...counters };
}

module.exports = { register, enqueue, runOnce, start, stop, status };

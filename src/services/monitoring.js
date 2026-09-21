'use strict';
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, totalDurationMs: 0, byStatus: {}, slowRequests: 0 };

function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.requests++;
    metrics.totalDurationMs += durationMs;
    metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] || 0) + 1;
    if (res.statusCode >= 500) metrics.errors++;
    if (durationMs >= (Number(process.env.SLOW_REQUEST_MS) || 1000)) metrics.slowRequests++;
  });
  next();
}

function snapshot() {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    requests: metrics.requests, errors: metrics.errors, errorRate: metrics.requests ? Number((metrics.errors / metrics.requests * 100).toFixed(2)) : 0,
    averageDurationMs: metrics.requests ? Number((metrics.totalDurationMs / metrics.requests).toFixed(2)) : 0,
    slowRequests: metrics.slowRequests, byStatus: { ...metrics.byStatus },
    memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) }
  };
}

module.exports = { middleware, snapshot };

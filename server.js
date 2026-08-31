/**
 * Tech Defenders Business OS - Application Server
 * -----------------------------------------------
 * Express app that:
 *  - applies security headers
 *  - serves the black/gold/white SPA from /public
 *  - mounts all API routes under /api with JWT auth + RBAC
 *  - initializes a clean workspace and login accounts on first boot
 *
 * Start:  node server.js      (or: npm start)
 */
'use strict';
require('./src/load-env')();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./db/store');
const { attachUser } = require('./src/middleware');

/* load data + optional clean initialization */
store.load();
if ((process.env.AUTO_SEED || 'true') === 'true' && store.isEmpty()) {
  console.log('[boot] Empty database detected - initializing a clean Tech Defenders workspace...');
  require('./db/seed').run(false);
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(cookieParser());

/* request identity + same-origin guard for cookie-authenticated writes */
app.use((req, res, next) => {
  const requestId = req.get('X-Request-ID') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('Origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
      } catch (_) { return res.status(403).json({ error: 'Invalid request origin' }); }
    }
  }
  next();
});

/* basic security headers */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
  );
  next();
});

/* attach authenticated user (if any) to every request */
app.use(attachUser);

/* ---------------- API routes ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Tech Defenders OS', version: '3.2.1', storage: store.DATA_DIR, time: new Date().toISOString() }));
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/crm', require('./src/routes/crm'));
app.use('/api/sales', require('./src/routes/sales'));
app.use('/api/purchase', require('./src/routes/purchase'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/manufacturing', require('./src/routes/manufacturing'));
app.use('/api/service', require('./src/routes/service'));
app.use('/api/finance', require('./src/routes/finance'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/integrations', require('./src/routes/integrations'));
const advancedRoutes = require('./src/routes/advanced');
app.use('/api/v3', advancedRoutes);

/* API 404 */
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

/* ---------------- static frontend ---------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));

/* global error handler - never leak stack traces */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal server error' });
});

/* ---------------- boot ---------------- */
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 4173;
  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ================================================');
    console.log('   TECH DEFENDERS OS v3.2.1');
    console.log(`   Running at  http://localhost:${PORT}`);
    console.log('   Super Admin superadmin@techdefenders.in / Super@123');
    console.log('  ================================================');
    console.log('');
  });

  const shutdown = signal => {
    console.log(`\n[shutdown] ${signal} received - flushing data...`);
    store.flushSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
if ((process.env.AUTO_BACKUP || 'true') === 'true' && process.env.NODE_ENV !== 'test') {
  console.log('[backup] Startup snapshot:', store.backupSync());
  setInterval(() => {
    try { console.log('[backup] Daily snapshot:', store.backupSync()); }
    catch (error) { console.error('[backup] Snapshot failed:', error.message); }
  }, 24 * 60 * 60 * 1000).unref();
}

if ((process.env.AUTO_AUTOMATION || 'true') === 'true' && process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    try { advancedRoutes.runScheduledAutomations(); }
    catch (error) { console.error('[automation] Startup run failed:', error.message); }
  }, 15_000).unref();
  setInterval(() => {
    try { advancedRoutes.runScheduledAutomations(); }
    catch (error) { console.error('[automation] Scheduled run failed:', error.message); }
  }, 15 * 60 * 1000).unref();
}

module.exports = app;

'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('../../db/store');
const { requireAuth } = require('../middleware');
const { audit } = require('../util');
const router = express.Router();
router.use(requireAuth);



router.get('/sessions', (req, res) => res.json({ sessions: store.find('authSessions', row => row.userId === req.user.id && !row.revokedAt).sort((a,b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).map(row => ({ ...row, current: row.id === req.authSession?.id })) }));
router.post('/reconfirm', (req, res) => { const user = store.byId('users', req.user.id); if (!user || !bcrypt.compareSync(String(req.body?.password || ''), user.passwordHash)) return res.status(401).json({ error: 'Password is incorrect' }); if (req.authSession) store.update('authSessions', req.authSession.id, { reconfirmedAt: new Date().toISOString() }); audit(req.org.id, req.user.id, 'security_reconfirm', 'auth_session', req.authSession?.id); res.json({ confirmedForSeconds: 600 }); });
router.post('/sessions/:id/revoke', (req, res) => { const session = store.findOne('authSessions', row => row.id === req.params.id && row.userId === req.user.id); if (!session) return res.status(404).json({ error: 'Session not found' }); store.update('authSessions', session.id, { revokedAt: new Date().toISOString(), revokedBy: req.user.id }); audit(req.org.id, req.user.id, 'revoke_session', 'auth_session', session.id); res.json({ revoked: true, current: session.id === req.authSession?.id }); });
router.post('/logout-all', (req, res) => { store.find('authSessions', row => row.userId === req.user.id && !row.revokedAt).forEach(row => store.update('authSessions', row.id, { revokedAt: new Date().toISOString(), revokedBy: req.user.id })); const user = store.byId('users', req.user.id); store.update('users', user.id, { tokenVersion: (user.tokenVersion || 0) + 1 }); audit(req.org.id, req.user.id, 'logout_all_devices', 'user', user.id); res.json({ revoked: true }); });
router.get('/events', (req, res) => { if (!['admin','super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Administrator access required' }); res.json({ events: store.find('securityEvents', row => row.orgId === req.org.id).slice(-500).reverse() }); });

module.exports = router;

'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm, requireSuperAdmin, rateLimit } = require('../middleware');
const { audit } = require('../util');
const router = express.Router();
router.use(requireAuth);

const clean = value => String(value || '').replace(/[\u0000-\u001F]/g, '').slice(0, 500);
const deviceToken = value => /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(String(value || ''));

router.post('/push-devices', (req, res) => {
  const token = clean(req.body?.token); if (!deviceToken(token)) return res.status(400).json({ error: 'Invalid Expo push token' });
  const existing = store.findOne('mobileDevices', row => row.orgId === req.org.id && row.userId === req.user.id && row.token === token);
  const record = existing ? store.update('mobileDevices', existing.id, { platform: clean(req.body?.platform) || 'android', active: true, updatedAt: new Date().toISOString() }) : store.insert('mobileDevices', { orgId: req.org.id, userId: req.user.id, token, platform: clean(req.body?.platform) || 'android', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  audit(req.org.id, req.user.id, 'register_mobile_push', 'mobile_device', record.id, { platform: record.platform }); res.json({ device: { id: record.id, platform: record.platform } });
});

router.post('/attendance', (req, res) => {
  const type = req.body?.type; if (!['check-in', 'check-out'].includes(type)) return res.status(400).json({ error: 'Use check-in or check-out' });
  const c = req.body?.coordinates; const location = c && Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude)) ? { latitude: Number(c.latitude), longitude: Number(c.longitude), accuracy: Math.max(0, Number(c.accuracy) || 0) } : null;
  const record = store.insert('mobileAttendance', { orgId: req.org.id, userId: req.user.id, type, location, note: clean(req.body?.note), capturedAt: new Date().toISOString() });
  audit(req.org.id, req.user.id, type === 'check-in' ? 'mobile_check_in' : 'mobile_check_out', 'mobile_attendance', record.id, { hasLocation: !!location }); res.status(201).json({ attendance: record });
});

router.get('/attendance', requirePerm('admin', 'view'), (req, res) => res.json({ attendance: store.find('mobileAttendance', row => row.orgId === req.org.id).slice(-500).reverse() }));
router.get('/app-version', (_req, res) => res.json({ version: process.env.MOBILE_APP_VERSION || '3.4.0', forceUpdate: process.env.MOBILE_FORCE_UPDATE === 'true', downloadUrl: clean(process.env.MOBILE_APP_DOWNLOAD_URL), checkedAt: new Date().toISOString() }));

router.get('/lookup/:kind', (req, res) => {
  const query = clean(req.query.q).toLowerCase(); const map = { customers:['customers','name'], employees:['employees','name'], products:['products','name'], assets:['assetRegister','serialNo'] }; const entry = map[req.params.kind];
  if (!entry) return res.status(404).json({ error: 'Unknown lookup' }); const [collection, field] = entry;
  const items = store.find(collection, row => row.orgId === req.org.id && (!query || `${row.name || ''} ${row[field] || ''} ${row.sku || ''} ${row.serialNo || ''}`.toLowerCase().includes(query))).slice(0, 30).map(row => ({ id: row.id, name: row.name || row.assetName || row.serialNo || 'Record', subtitle: row.sku || row.serialNo || row.email || '' })); res.json({ items });
});
router.get('/barcode/:code', (req, res) => { const code=clean(req.params.code).toLowerCase(); const product=store.findOne('products', row=>row.orgId===req.org.id&&[row.sku,row.barcode,row.id].some(value=>String(value||'').toLowerCase()===code)); const asset=store.findOne('assetRegister', row=>row.orgId===req.org.id&&[row.serialNo,row.assetTag,row.id].some(value=>String(value||'').toLowerCase()===code)); if(!product&&!asset)return res.status(404).json({error:'No product or asset found'}); res.json({ type:product?'product':'asset', record:product||asset }); });

router.post('/crash-reports', (req, res) => { if (!rateLimit(`mobile-crash:${req.user.id}`, 20, 3600000)) return res.status(429).json({ error: 'Too many reports' }); const record=store.insert('mobileCrashReports',{orgId:req.org.id,userId:req.user.id,message:clean(req.body?.message),screen:clean(req.body?.screen),appVersion:clean(req.body?.appVersion),createdAt:new Date().toISOString()}); audit(req.org.id,req.user.id,'mobile_crash_report','mobile_crash_report',record.id,{}); res.status(201).json({ accepted:true }); });

router.post('/push/test', requireSuperAdmin, async (req,res) => { const tokens=store.find('mobileDevices',row=>row.orgId===req.org.id&&row.active).map(row=>row.token); if(!tokens.length)return res.json({sent:0,message:'No registered mobile devices'}); try { const response=await fetch('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(tokens.map(to=>({to,title:clean(req.body?.title)||'Tech Defenders OS',body:clean(req.body?.body)||'Test business notification',sound:'default'})))}); if(!response.ok)throw new Error('Expo push provider rejected the request'); audit(req.org.id,req.user.id,'send_mobile_push_test','mobile_devices','all',{count:tokens.length}); res.json({sent:tokens.length}); } catch(error) { res.status(502).json({error:'Push delivery could not be completed'}); } });
module.exports = router;

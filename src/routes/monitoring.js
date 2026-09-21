'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth } = require('../middleware');
const monitoring = require('../services/monitoring');
const jobQueue = require('../services/job-queue');
const fileStorage = require('../services/file-storage');
const router = express.Router();
router.use(requireAuth);
router.get('/', (req, res) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Administrator access required' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ application: monitoring.snapshot(), storage: store.status(), jobs: jobQueue.status(), files: fileStorage.status(), checkedAt: new Date().toISOString() });
});
module.exports = router;

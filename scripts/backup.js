'use strict';
require('../src/load-env')();
const store = require('../db/store');
store.load();
console.log('[backup] Snapshot created:', store.backupSync());

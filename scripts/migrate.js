'use strict';
require('../src/load-env')();
const store = require('../db/store');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for database migrations');
  await store.initialize();
  const status = store.status();
  console.log(`Database migrations complete. Schema version: ${status.schemaVersion}`);
  await store.close();
})().catch(error => { console.error(error.message); process.exit(1); });

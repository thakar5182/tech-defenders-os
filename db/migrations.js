'use strict';

const MIGRATIONS = [
  {
    version: 1,
    name: 'foundation_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS td_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        org_id TEXT,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection, id)
      )`,
      'CREATE INDEX IF NOT EXISTS td_records_org_collection_idx ON td_records (org_id, collection)',
      'CREATE INDEX IF NOT EXISTS td_records_record_gin_idx ON td_records USING GIN (record)',
      `CREATE TABLE IF NOT EXISTS td_files (
        storage_key TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        payload BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS td_files_org_idx ON td_files (org_id, created_at DESC)',
      `CREATE TABLE IF NOT EXISTS td_job_leases (
        job_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        leased_until TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    ]
  },
  {
    version: 2,
    name: 'normalized_record_backfill',
    statements: [
      `INSERT INTO td_records (collection, id, org_id, record, updated_at)
       SELECT source.name, item->>'id', NULLIF(item->>'orgId', ''), item, source.updated_at
       FROM td_collections source
       CROSS JOIN LATERAL jsonb_array_elements(source.records) item
       WHERE item ? 'id'
       ON CONFLICT (collection, id) DO UPDATE
       SET org_id = EXCLUDED.org_id, record = EXCLUDED.record, updated_at = EXCLUDED.updated_at`
    ]
  }
];

async function runMigrations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS td_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const appliedResult = await pool.query('SELECT version FROM td_schema_migrations ORDER BY version');
  const applied = new Set((appliedResult.rows || []).map(row => Number(row.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of migration.statements) await client.query(statement);
      await client.query(
        'INSERT INTO td_schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.name]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      error.message = `Database migration ${migration.version} (${migration.name}) failed: ${error.message}`;
      throw error;
    } finally {
      client.release();
    }
  }
  return MIGRATIONS.at(-1)?.version || 0;
}

module.exports = { MIGRATIONS, runMigrations };

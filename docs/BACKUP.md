# Backup and Restore

`AUTO_BACKUP=true` creates a startup snapshot and repeats every 24 hours.
`npm run backup` creates one immediately. Set `BACKUP_DIR` to another physical
drive or protected network destination.

Before a restore: stop the server, copy the current `data` directory to a safe
location, validate the chosen backup manifest, replace only the collection JSON
files, then start and run both regression suites against a copy. Do not run
`npm run seed` as a restore operation; it intentionally deletes business data.

Test restoration regularly. A backup that has never been restored is not a
verified recovery plan.


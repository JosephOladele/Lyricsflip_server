# PostgreSQL Backup and Recovery Plan

This document outlines the backup and disaster recovery procedures for the Lyricsflip PostgreSQL database.

## 1. Automated Backups

Lyricsflip stores user accounts, game sessions, wagers, and audit trails in PostgreSQL. Regular automated backups must be scheduled (e.g. daily via cron or cloud managed snapshots).

### Backup Command

Using discrete environment variables from `.env` (`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_NAME`):

```bash
# Dump the database into a compressed SQL archive
PGPASSWORD="${DB_PASSWORD}" pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT:-5432}" \
  -U "${DB_USERNAME}" \
  -F c -b -v \
  -f "/backups/lyricflip_$(date +%Y-%m-%d_%H-%M-%S).dump" \
  "${DB_NAME}"
```

For containerized environments (Docker Compose):

```bash
docker compose exec -T postgres pg_dump -U postgres -F c test | gzip > backup_$(date +%Y-%m-%d).dump.gz
```

Store backup archives off-site in encrypted object storage (S3, GCS) with a 30-day lifecycle retention policy.

## 2. Disaster Recovery Procedure

To restore the database from a custom-format dump archive:

```bash
# 1. Terminate active backend connections to the target database
psql -h "${DB_HOST}" -U "${DB_USERNAME}" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();"

# 2. Re-create the database
dropdb -h "${DB_HOST}" -U "${DB_USERNAME}" "${DB_NAME}"
createdb -h "${DB_HOST}" -U "${DB_USERNAME}" "${DB_NAME}"

# 3. Restore the dump
pg_restore -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME}" -d "${DB_NAME}" -v "/backups/lyricflip_backup.dump"
```

## 3. Post-Recovery Verification

After restoration, verify migrations and entity parity:

```bash
npm run migration:check
curl -s http://localhost:3000/health/ready
```
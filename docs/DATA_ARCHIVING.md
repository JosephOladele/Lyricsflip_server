# Data Archiving Strategy

This document outlines the retention and archiving strategy for high-volume historical data in the Lyricsflip PostgreSQL database.

## 1. Objectives

- Maintain low query latency on high-frequency tables (`game_rounds`, `game_sessions`, `wagers`).
- Reduce primary database storage growth and backup snapshot sizes.
- Preserve audit and analytical records for compliance, dispute resolution, and reporting.

## 2. Table-Specific Retention Policies

| Table | Retention in Primary DB | Archive Policy |
|---|---|---|
| `game_rounds` | 90 days after session completion | Export to cold object storage (Parquet/CSV on S3/GCS); purge completed rounds older than 90 days. |
| `game_sessions` | 180 days after completion or abandonment | Archive completed/abandoned sessions with no open wagers. |
| `wagers` | 365 days after terminal state (`SETTLED`, `REFUNDED`, `FAILED`) | Retain financial records on-chain and in archival cold storage for tax/compliance purposes. |
| `audit_logs` | 180 days in primary database | Stream to cold storage or log aggregator (e.g. OpenSearch / BigQuery) for long-term retention. |
| `refresh_tokens` | Immediate deletion upon revocation or expiration | Scheduled cleanup job purges expired and revoked tokens automatically. |

## 3. Recommended Archive & Purge Procedure

A monthly or weekly maintenance script executes:

```sql
-- 1. Export rounds from completed sessions older than 90 days
COPY (
  SELECT r.* FROM game_rounds r
  JOIN game_sessions s ON r."sessionId" = s.id
  WHERE s.status IN ('COMPLETED', 'ABANDONED')
    AND s."updatedAt" < NOW() - INTERVAL '90 days'
) TO PROGRAM 'gzip > /archive/game_rounds_$(date +%Y%m%d).csv.gz' WITH CSV HEADER;

-- 2. Verify export checksum, then purge
DELETE FROM game_rounds
WHERE "sessionId" IN (
  SELECT id FROM game_sessions
  WHERE status IN ('COMPLETED', 'ABANDONED')
    AND "updatedAt" < NOW() - INTERVAL '90 days'
);
```

Purge from Production: Once the copy is verified, the script deletes the archived rows from the production database table.

3. Example Workflow (Archiving User Logs)
Let's say we want to archive user logs older than 2 years.

A scheduled script runs once a month.

SQL Query to select data:

SELECT * FROM user_logs WHERE created_at < NOW() - INTERVAL '2 years';

The script takes the result of this query and inserts it into an archived_user_logs table in a separate "archive" database.

After verifying the data integrity in the archive, it runs the delete command on the production database:

DELETE FROM user_logs WHERE created_at < NOW() - INTERVAL '2 years';

This process ensures the production user_logs table remains at a manageable size, directly contributing to sustained application performance.

4. Game Rounds Retention (`game_rounds`)

A row is inserted into `game_rounds` every time a lyric is served, including rounds the player never guessed. Without retention this table grows without bound and the seen-window query (`getRecentlySeenLyricIds`, which filters by `userId` and `issuedAt`) degrades. Two mechanisms keep it bounded:

Index: `GameRound` declares a composite index on `(userId, issuedAt)` so the seen-window query uses an index scan instead of a sequential scan.

Daily retention job: a scheduled job runs once per day and is guarded by the distributed lock from issue 43 so concurrent runs cannot overlap. Each run:

- Deletes unguessed rounds older than the seen window (they are no longer relevant to `getRecentlySeenLyricIds`).
- Moves guessed rounds older than the configured retention period (N days) into the archive table, or deletes them once `game_history` already holds the record.

Retention settings (seen window and N days) are configurable; `game_rounds` size is therefore bounded by those settings rather than by total traffic.
Always execute purges in bounded batches during off-peak hours to avoid prolonged table locks.

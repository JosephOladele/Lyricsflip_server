# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OpenTelemetry distributed tracing integration (`@opentelemetry/sdk-node`) with HTTP, Express, pg, and Socket.IO instrumentations, activated via `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Manual OpenTelemetry tracing spans around `StellarRpcService.submit` and `StellarRpcService.waitForConfirmation`, recording `transaction_hash` and `attempt_count` attributes.
- Winston logger trace correlation injecting active OpenTelemetry `trace_id` and `span_id` into application log records.
- Root span context propagation in background scheduled jobs (`WagerReconcileJob`, `WagerRefundJob`), linking each execution trace to the target wager.
- Comprehensive documentation audit across `docs/`, including Prometheus alert definitions in `docs/alerts.yml` and full database migration history in `docs/MIGRATIONS.md`.
- Pull request template verification section with a mandatory "Docs updated?" checklist and automated validation script `scripts/check-docs-updated.sh`.
- Initial `CHANGELOG.md` adhering to Keep a Changelog standards.

## [0.3.0] - 2026-10-18

### Added
- Email verification and password reset token workflows with transactional SMTP/console mailer (`#262`).
- Timed game rounds, speed bonuses, hint systems, and daily lyric challenges (`#205`).
- Automatic difficulty calibrator background job (`DifficultyCalibratorJob`).
- Case-insensitive unique indexing for user accounts and usernames.
- Refresh token rotation with cryptographic SHA-256 token hashing and user token versioning.
- Centralized audit logging table and service tracking authentication and administrative role modifications.

### Changed
- Standardized user rank progression titles (renamed `Gossip God` to `Gossip Guru`).

## [0.2.0] - 2026-09-25

### Added
- Remote signing key store support supporting AWS KMS (asymmetric ed25519) and HashiCorp Vault Transit (`#214`).
- Soroban smart contract escrow deployment (`contracts/lyricsflip-escrow`) and reconciliation engine.
- Automated wager refund background job sweeping expired wagers past their stake deadline (`#203`).
- Prometheus metrics exporter collecting HTTP latency, settlement health, and RPC execution statistics (`#211`).
- Winston daily rotating log file transports with request-scoped AsyncLocalStorage tracing (`#200`).
- Multi-instance distributed caching via Redis and `@socket.io/redis-adapter` (`#201`).
- Helmet security headers and OpenAPI Swagger interface.

## [0.1.0] - 2026-08-10

### Added
- Initial MVP backend architecture using NestJS 11 and TypeORM PostgreSQL.
- Solo gameplay, multiplayer game rooms, and head-to-head match sessions.
- In-memory mock wager token settlement for local development and testing.

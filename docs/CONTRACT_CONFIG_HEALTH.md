# Contract Configuration & Health Checks

Lyricsflip verifies Stellar and Soroban contract dependencies across two phases: boot-time environment validation and runtime liveness/readiness probes.

## 1. Boot-time Configuration Validation

When `ConfigModule` and `StellarModule` load at application boot:

- `src/config/env.validation.ts` parses and asserts that all core infrastructure keys (`DATABASE_URL` / `DB_*`, `JWT_SECRET`, `FRONTEND_URL`) conform to expected types.
- When `STELLAR_SETTLEMENT_MODE=stellar`:
  - `STELLAR_ESCROW_CONTRACT_ID` must be configured and valid (`C...` 56-character StrKey format).
  - `STELLAR_TOKEN_CONTRACT_ID` must be configured (`C...` 56-character StrKey format).
  - `STELLAR_RESOLVER_SECRET` or KMS/Vault remote signer must provide a valid 56-character Ed25519 public key (`G...`).
  - Network passphrase must match the target network (`public`, `testnet`, `futurenet`, or `standalone`).

In `STELLAR_SETTLEMENT_MODE=mock`, contract IDs and network passphrases are optional, allowing developers to run offline without an RPC or token contract.

## 2. Runtime Health Checks

Probes are served under `/health` (outside the versioned API prefix):

- **`GET /health/live`** (Liveness probe): Verifies process liveness and that Node.js heap memory does not exceed the ceiling (512 MB). Does not execute remote database or RPC calls, preventing false-positive container restarts on temporary network blips.
- **`GET /health/ready`** (Readiness probe): Verifies database connectivity (`db.pingCheck`). In `stellar` settlement mode, it also calls `stellarRpc.isHealthy()` to confirm that the Soroban RPC server is reachable and reports healthy. If either fails, the probe returns HTTP 503, temporarily removing the instance from load balancer traffic without restarting the container.

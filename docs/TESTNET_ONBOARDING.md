# Stellar Testnet Onboarding Guide

This guide walks through configuring and funding a new player or developer account on the Stellar testnet for Lyricsflip.

1. Funded Stellar account.
2. LYRIC trustline.
3. Starting mock balance in development mode.
4. Contract config verification before first wager.

## Deploying the escrow contract

The escrow contract takes its configuration in its constructor
(`__constructor(admin, token, resolver)`), so it must be deployed with the
constructor arguments. Use the `stellar` CLI and the deploy script:

```bash
ADMIN=<admin-address> \
TOKEN=<token-contract-address> \
RESOLVER=<resolver-address> \
NETWORK=testnet \
./scripts/deploy-escrow-contract.sh
```

The script builds with `stellar contract build` and deploys the workspace
artifact at
`contracts/target/wasm32-unknown-unknown/release/lyricsflip_escrow.wasm`,
passing `--admin`, `--token` and `--resolver` to the constructor. It prints the
deployed contract ID and the `.env` lines to paste.

There is no separate `initialize` step — the configuration is set at deploy
time. Verify it with:

```bash
stellar contract invoke \
  --id "$ESCROW_CONTRACT_ID" \
  --source "$ADMIN" \
  --network testnet \
  -- get_config
```

`get_config` should return the admin, token and resolver addresses you passed
in.
## 1. Create and Fund a Testnet Account

Generate an ed25519 keypair and fund it via Friendbot:

```bash
# Request 10,000 testnet XLM
curl -X GET "https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>"
```

Alternatively, use the Stellar Laboratory Account Creator (`https://laboratory.stellar.org/#account-creator?network=test`).

## 2. Establish a Trustline for the LYRIC Token

Before an account can receive or stake LYRIC tokens, establish a trustline to the LYRIC asset or token contract:

- In **classic asset mode**: Submit a `change_trust` operation for asset code `LYRIC` issued by the issuer account.
- In **Soroban mode**: Ensure your address has an established balance or allowance with `STELLAR_TOKEN_CONTRACT_ID`.

## 3. Authenticate via SEP-10 Web Authentication

Players link their Stellar wallet through SEP-10:

1. **Request Challenge**: `GET /api/v1/auth/sep10/challenge?publicKey=<YOUR_PUBLIC_KEY>`
2. **Sign Challenge**: Sign the returned transaction XDR using your wallet (Freighter, xBull, Albedo, etc.).
3. **Obtain Token**: `POST /api/v1/auth/sep10/token` with `{ "xdr": "<SIGNED_TRANSACTION_XDR>" }`.

The returned JWT bearer token authorizes the player to participate in wagered sessions.

## 4. Verify System Readiness

Check system status before initiating wagers:

```bash
curl -X GET http://localhost:3000/health/ready
```

Returns `{ "status": "ok", "info": { "database": { "status": "up" }, "stellar_rpc": { "status": "up" } } }`.

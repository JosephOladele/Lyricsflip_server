# Testnet Onboarding

New testnet players need:

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

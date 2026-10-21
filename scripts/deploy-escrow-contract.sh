#!/usr/bin/env bash
#
# Deploy the lyricsflip-escrow contract to a Stellar network.
#
# The contract takes its configuration in its constructor, so the admin,
# token and resolver addresses must be supplied at deploy time.
#
# Usage:
#   ADMIN=<admin-address> \
#   TOKEN=<token-contract-address> \
#   RESOLVER=<resolver-address> \
#   NETWORK=testnet \
#   ./scripts/deploy-escrow-contract.sh
#
set -euo pipefail

NETWORK="${NETWORK:-testnet}"

missing=()
[ -z "${ADMIN:-}" ] && missing+=("ADMIN")
[ -z "${TOKEN:-}" ] && missing+=("TOKEN")
[ -z "${RESOLVER:-}" ] && missing+=("RESOLVER")

if [ "${#missing[@]}" -ne 0 ]; then
  echo "Error: missing required environment variable(s): ${missing[*]}" >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  ADMIN=<admin-address> TOKEN=<token-address> RESOLVER=<resolver-address> \\" >&2
  echo "  NETWORK=testnet ./scripts/deploy-escrow-contract.sh" >&2
  exit 1
fi

WASM="contracts/target/wasm32-unknown-unknown/release/lyricsflip_escrow.wasm"

if ! command -v stellar >/dev/null 2>&1; then
  echo "Error: the 'stellar' CLI is not installed or not on PATH." >&2
  echo "Install it from https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli" >&2
  exit 1
fi

echo "Building escrow contract..."
stellar contract build --manifest-path contracts/lyricsflip-escrow/Cargo.toml

if [ ! -f "$WASM" ]; then
  echo "Error: expected wasm at $WASM but it was not produced by the build." >&2
  exit 1
fi

echo "Deploying escrow contract to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ADMIN" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN" \
  --token "$TOKEN" \
  --resolver "$RESOLVER")

echo ""
echo "Escrow contract deployed."
echo "Contract ID: $CONTRACT_ID"
echo ""
echo "Add these lines to your .env:"
echo "ESCROW_CONTRACT_ID=$CONTRACT_ID"
echo "ESCROW_ADMIN=$ADMIN"
echo "ESCROW_TOKEN=$TOKEN"
echo "ESCROW_RESOLVER=$RESOLVER"

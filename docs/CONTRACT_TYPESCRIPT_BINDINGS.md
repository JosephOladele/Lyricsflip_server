# Contract TypeScript Bindings & Service Integration

This document outlines how the TypeScript backend interfaces with the deployed Soroban escrow contract.

## Runtime Invocation Model

In production and integration testing, Lyricsflip invokes the Soroban escrow contract through `EscrowContractService` (`src/stellar/services/escrow-contract.service.ts`) using the official `@stellar/stellar-sdk` and `StellarRpcService`:

- **Simulation & Footprint Resolution**: Every invocation (`open_pot`, `stake`, `resolve`, `refund`) is built with `TransactionBuilder`, converted to Soroban `xdr.ScVal` arguments, and sent to `simulateTransaction` / `prepareTransaction` to establish the necessary storage footprint and fee bounds.
- **Signing & Submission**: Transactions are signed by the resolver keypair (or remote KMS/Vault signer) and submitted via `server.sendTransaction()`.
- **Status Polling**: `StellarRpcService.waitForConfirmation()` monitors status via `pollTransaction()` until inclusion in a confirmed ledger.

## CLI TypeScript Bindings Generation (Optional Tooling)

When generating client-side type definitions or SDK wrappers from the deployed contract WASM:

```bash
soroban contract bindings typescript \
  --contract-id "$ESCROW_CONTRACT_ID" \
  --network "$SOROBAN_NETWORK" \
  --output-dir src/stellar/bindings/lyricsflip-escrow
```

Generated bindings can be used for client testing or off-chain indexer validation.

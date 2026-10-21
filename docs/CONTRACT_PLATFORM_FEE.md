# Contract Platform Fee Policy

This document outlines the design and status of platform fees in Lyricsflip escrow settlement.

## Current On-Chain Escrow Settlement

In the current deployed escrow contract (`contracts/lyricsflip-escrow/src/lib.rs`):

- **No Platform Fee Deduction**: 100% of the total wager pot is paid out directly to the winning player via `resolve`.
- **Drawn Matches**: If a match concludes as a draw, `refund` returns exactly each player's original stake without any administrative or fee deduction.
- **Unclaimed Pots**: If a match is abandoned or a player fails to stake before the deadline, `refund_unfunded` or `claim_refund` returns stakes directly to their depositors.

## Proposed Platform Fee Architecture (Future Enhancement)

When platform monetization is enabled, fee deduction should follow these guidelines:

1. **Basis Points Representation**: Platform fees must be expressed in basis points (`1 bps = 0.01%`).
2. **Hard Ceiling**: Fee percentage must be capped on-chain (e.g., maximum 500 bps / 5%).
3. **Explicit Fee Receiver**: A dedicated fee collector address must be registered before any non-zero fee rate can be activated.
4. **Transparent Emitted Events**: Payout events emitted by the contract must explicitly split `payout_amount` and `fee_amount` so off-chain indexers and user explorers can verify calculations.

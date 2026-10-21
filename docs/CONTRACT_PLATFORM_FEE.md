# Contract Platform Fee Policy

The escrow contract supports an optional platform fee, expressed in basis points, taken from the winner payout before it is transferred.

Implemented rules:

- `Config` carries `fee_bps: u32`, `max_fee_bps: u32` (a constant cap, `1000` = 10%) and `fee_receiver: Option<Address>`.
- Default fee is `0` and the default receiver is `None`.
- The fee is capped by `max_fee_bps`; `set_fee` rejects any `fee_bps` above the cap.
- A non-zero fee requires a configured receiver; `set_fee` rejects a non-zero fee without one.
- `set_fee(fee_bps, receiver)` is admin-only.
- On `resolve`, the fee is `fee = payout * fee_bps / 10_000` (integer division, rounded down) and is transferred to the receiver; the remainder goes to the winner. With a 2.5% fee, a 10 + 10 pot pays 19.5 to the winner and 0.5 to the receiver.
- Draws and refunds are never charged a fee.
- A `fee` event is emitted when a fee is taken.
- The configured fee and receiver are surfaced by `get_config` and by the backend `GET /stellar/info` health check.
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

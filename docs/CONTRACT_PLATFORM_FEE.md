# Contract Platform Fee

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

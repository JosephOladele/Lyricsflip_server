# Escrow Contract Test Plan & Coverage

The Soroban escrow contract (`contracts/lyricsflip-escrow/src/lib.rs`) is tested using the Soroban Rust SDK test harness in `contracts/lyricsflip-escrow/src/test.rs`.

## Test Scenarios & Invariants

The test suite covers:

1. **Happy Path Payouts**:
   - `winner_takes_the_whole_pot`: Confirms that `resolve` transfers the entire 2x stake pot to the winner.
2. **Refund & Draw Handling**:
   - `refund_returns_each_stake`: Both players receive their exact deposited amounts back.
   - `refund_handles_a_pot_only_one_player_funded`: If only Player A staked, `refund` returns Player A's deposit cleanly.
3. **Authorization & Access Control**:
   - `a_player_cannot_stake_twice`: Rejects duplicate stakes for the same session.
   - `outsiders_cannot_stake`: Third-party addresses cannot deposit into a private match pot.
   - `the_pot_cannot_be_paid_to_a_non_player`: Payouts must specify either `player_a` or `player_b`.
   - `an_underfunded_pot_cannot_be_resolved`: Resolving a pot before both parties stake is rejected.
   - `a_pot_cannot_be_resolved_twice`: Double-spending or re-resolving an already paid pot fails.
   - `sessions_cannot_be_reused`: A concluded session ID cannot be reopened.
   - `stakes_must_be_positive`: Zero or negative stake amounts are rejected.
4. **Deadline & Self-Refund (Emergency Exit)**:
   - `claim_before_the_deadline_fails`: Players cannot reclaim funds before the dispute/claim deadline passes.
   - `each_player_can_claim_their_own_stake_after_the_deadline`: After the deadline, players can retrieve their funds without needing resolver intervention.
   - `a_player_cannot_claim_another_players_stake`: Claim logic only refunds the caller's own deposit.
   - `a_player_cannot_claim_twice`: Prevents double claims.
   - `resolve_is_blocked_once_a_player_has_claimed`: Once an expired pot is reclaimed, resolver resolution is permanently locked.
5. **Contract Administration & Upgrades**:
   - `the_admin_can_rotate_the_resolver`: Admin can change the resolver public key.
   - `the_admin_can_rotate_itself`: Admin can transfer administrative ownership.
   - `pot_and_instance_survive_past_default_ttl`: Storage TTL extension keeps active pots alive.
   - `the_storage_version_starts_at_current_version` & `migrate_is_a_no_op_when_already_current`: Migration safety checks.
6. **Event Logging Parity**:
   - `open_pot_emits_an_open_event`
   - `full_pot_lifecycle_emits_the_documented_events`
   - `refund_emits_a_refund_event`
   - `set_admin_emits_an_admin_event`
   - `set_resolver_emits_a_resolver_event`

## Running Contract Tests

Run tests in the `contracts/` directory using cargo:

```bash
cd contracts && cargo test
```

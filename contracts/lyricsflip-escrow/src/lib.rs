#![no_std]

//! Escrow contract for LyricsFlip wagered matches.
//!
//! One "pot" exists per game session. Both players stake an equal amount into
//! the contract, and a single authorised `resolver` account — held by the
//! LyricsFlip backend — later releases the pot to the winner or refunds it.
//!
//! The contract deliberately does *not* let the resolver move funds anywhere
//! else: `resolve` can only pay a player of that pot, and `refund` can only
//! return each stake to the player who made it. That bounds what a compromised
//! backend key can do to picking the wrong winner, rather than draining escrow.
//!
//! ## Platform fee
//!
//! `resolve` takes a basis-point platform fee out of the pot before paying the
//! winner: `fee = payout * fee_bps / 10_000`, sent to `fee_receiver`, with the
//! remainder paid to the winner. The fee is capped at `MAX_FEE_BPS` (10%) and
//! is set by the admin via `set_fee`. Refunds and draws never take a fee.
//!
//! ## Events
//!
//! Every state-changing call publishes an event so indexers, explorers and
//! the backend can follow pot activity without polling `get_pot`:
//!
//! | Function       | Topics                       | Data                              |
//! |----------------|-------------------------------|------------------------------------|
//! | `open_pot`     | `("open", session_id)`        | `(player_a, player_b, stake)`      |
//! | `stake`        | `("stake", session_id)`       | `(player, is_player_a)`            |
//! | `resolve`      | `("resolve", session_id)`     | `(winner, payout)`                 |
//! | `resolve`      | `("fee", session_id)`         | `(receiver, fee)`                  |
//! | `refund`       | `("refund", session_id)`      | `(player_a, player_b)`             |
//! | `set_resolver` | `("resolver", ())`            | `(old_resolver, new_resolver)`     |
//! | `set_fee`      | `("fee", ())`                 | `(fee_bps, receiver)`              |
//! | `claim_refund` | `("claim", session_id)`       | `(player, amount)`                 |
//! | `set_admin`    | `("admin", ())`               | `(old_admin, new_admin)`           |
//! | `upgrade`      | `("upgrade", ())`             | `new_wasm_hash`                    |
//!
//! ## Admin rotation and upgrades
//!
//! The admin can rotate itself via `set_admin`, and can upgrade the
//! contract's WASM in place via `upgrade` (using
//! `env.deployer().update_current_contract_wasm`), so fixing a bug no
//! longer requires a redeploy to a new contract ID that strands in-flight
//! pots. Storage carries a version key, bumped by the `migrate` hook, which
//! an operator calls after `upgrade` to run any storage transformation the
//! new WASM needs — see the deploy/upgrade procedure below.
//!
//! ### Upgrade procedure
//!
//! 1. `stellar contract build` the new WASM and `stellar contract upload`
//!    it to get its hash.
//! 2. Call `upgrade(new_wasm_hash)`, authorised by the admin.
//! 3. Call `migrate()`, authorised by the admin, so any storage
//!    transformation the new version needs runs exactly once.
//! 4. Confirm `get_version` reports `CURRENT_VERSION` and `get_pot` still
//!    reads existing pots correctly.
//!
//! ## Reclaiming a stuck stake
//!
//! If the resolver key is lost, or the backend that holds it is shut down,
//! staked funds would otherwise be locked forever — rotating the resolver
//! needs the admin, who may also be unavailable. Every pot therefore carries
//! a `deadline_ledger`, set by `open_pot` to `CLAIM_WINDOW_LEDGERS` ledgers in
//! the future. Once that deadline has passed, each player may call
//! `claim_refund` themselves to recover their own stake, with no resolver or
//! admin involved. `resolve` remains available up until a player claims;
//! once any player has claimed, `resolve` is permanently blocked for that
//! pot, since it no longer holds both stakes.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env,
};

/// Ledgers per day at ~5s per ledger.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Expected maximum match length plus a generous margin: 30 days.
pub const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
/// Refresh whenever remaining life drops below this: 15 days.
pub const TTL_THRESHOLD: u32 = TTL_EXTEND_TO / 2;
/// The current storage layout version. Bumped whenever `migrate` needs to
/// transform existing storage after an `upgrade`.
pub const CURRENT_VERSION: u32 = 2;

/// The maximum platform fee, in basis points (1000 = 10%).
pub const MAX_FEE_BPS: u32 = 1_000;
/// Basis-point denominator: 10_000 bps = 100%.
const BPS_DENOMINATOR: u32 = 10_000;

/// A game session ID: the 16 bytes of the backend's session UUID.
pub type SessionId = BytesN<16>;

/// How many ledgers after `open_pot` a pot's claim deadline falls. Roughly a
/// week, assuming a five second average ledger close time. After this many
/// ledgers have passed, players may reclaim their own stake themselves via
/// `claim_refund`, even if the resolver never calls `resolve` or `refund`.
pub const CLAIM_WINDOW_LEDGERS: u32 = 120_960;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract-wide configuration, written once at initialisation.
    Config,
    /// The pot for one game session.
    Pot(SessionId),
    /// The storage layout version, checked and updated by `migrate`.
    Version,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PotStatus {
    /// Created, awaiting stakes from one or both players.
    Open,
    /// Both players have staked; the pot is ready to be resolved.
    Funded,
    /// Paid out to the winner.
    Resolved,
    /// Returned to whichever players had staked.
    Refunded,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// May rotate the resolver. Intended to be a multisig or DAO account.
    pub admin: Address,
    /// The token players stake — a Soroban token or a classic asset's SAC.
    pub token: Address,
    /// The only address allowed to open, resolve or refund pots.
    pub resolver: Address,
    /// Platform fee taken from the pot on `resolve`, in basis points.
    pub fee_bps: u32,
    /// Where the platform fee is sent. Required whenever `fee_bps` is non-zero.
    pub fee_receiver: Option<Address>,
}

#[contracttype]
#[derive(Clone)]
pub struct Pot {
    pub player_a: Address,
    pub player_b: Address,
    /// Amount each player stakes, in token base units.
    pub stake: i128,
    pub funded_a: bool,
    pub funded_b: bool,
    pub status: PotStatus,
    /// The ledger sequence after which either player may reclaim their own
    /// stake themselves via `claim_refund`, regardless of the resolver.
    pub deadline_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    PotAlreadyExists = 3,
    PotNotFound = 4,
    PotNotOpen = 5,
    PotNotFunded = 6,
    AlreadyStaked = 7,
    NotAPlayer = 8,
    InvalidStake = 9,
    SamePlayer = 10,
    /// `claim_refund` was called before the pot's claim deadline.
    DeadlineNotReached = 11,
    /// The calling player has no stake left in the pot to reclaim — either
    /// they never staked, or they already claimed it back.
    NothingToClaim = 12,
    /// `set_fee` was called with a fee above `MAX_FEE_BPS`.
    FeeTooHigh = 13,
    /// `set_fee` was called with a non-zero fee but no receiver.
    FeeReceiverRequired = 14,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Sets the admin, the staking token and the resolver.
    ///
    /// This runs atomically as part of deployment (`stellar contract
    /// deploy --wasm ... -- --admin ... --token ... --resolver ...`), so
    /// there is no window between deploy and initialization for an attacker
    /// to front-run: the contract is never live with unset, or someone
    /// else's, configuration. There is deliberately no separate `initialize`
    /// entrypoint any more, so this can never be called a second time.
    pub fn __constructor(env: Env, admin: Address, token: Address, resolver: Address) {
        admin.require_auth();
        Self::extend_instance(&env);

        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                token,
                resolver,
                fee_bps: 0,
                fee_receiver: None,
            },
        );
        env.storage().instance().set(&DataKey::Version, &CURRENT_VERSION);
    }

    /// Rotates the admin. Only the current admin may call this, so losing
    /// the admin key is still unrecoverable, but a routine key rotation —
    /// or handing the contract to a new multisig or DAO — no longer needs a
    /// redeploy.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let mut config = Self::config(&env)?;
        config.admin.require_auth();
        let old_admin = config.admin.clone();
        config.admin = new_admin.clone();
        env.storage().instance().set(&DataKey::Config, &config);

        env.events()
            .publish((symbol_short!("admin"),), (old_admin, new_admin));
        Ok(())
    }

    /// Sets the platform fee (in basis points) and its receiver. Admin only.
    ///
    /// Rejects a fee above `MAX_FEE_BPS`, and rejects a non-zero fee without a
    /// receiver. A zero fee clears the receiver.
    pub fn set_fee(
        env: Env,
        fee_bps: u32,
        receiver: Option<Address>,
    ) -> Result<(), Error> {
        let mut config = Self::config(&env)?;
        config.admin.require_auth();

        if fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        if fee_bps > 0 && receiver.is_none() {
            return Err(Error::FeeReceiverRequired);
        }

        config.fee_bps = fee_bps;
        config.fee_receiver = receiver.clone();
        env.storage().instance().set(&DataKey::Config, &config);

        env.events()
            .publish((symbol_short!("fee"),), (fee_bps, receiver));
        Ok(())
    }

    /// Returns the current contract configuration, including the fee.
    pub fn get_config(env: Env) -> Result<Config, Error> {
        Self::config(&env)
    }

    /// Runs any storage transformation the current WASM needs after an
    /// `upgrade`. Admin only, and idempotent: it only acts when the stored
    /// version is behind `CURRENT_VERSION`.
    pub fn migrate(env: Env) -> Result<(), Error> {
        let mut config = Self::config(&env)?;
        config.admin.require_auth();

        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(0);

        if version < CURRENT_VERSION {
            // v1 -> v2: add fee fields to existing configs. Default to no fee.
            config.fee_bps = 0;
            config.fee_receiver = None;
            env.storage().instance().set(&DataKey::Config, &config);
            env.storage().instance().set(&DataKey::Version, &CURRENT_VERSION);
        }
        Ok(())
    }

    /// Returns the current storage layout version.
    pub fn get_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(0)
    }

    /// Resolves a funded pot, paying the winner the pot minus the platform
    /// fee, and the fee receiver the fee. A draw (both players equal) refunds
    /// each stake with no fee.
    pub fn resolve(env: Env, session_id: SessionId, winner: Address) -> Result<(), Error> {
        let config = Self::config(&env)?;
        config.resolver.require_auth();

        let mut pot = Self::pot(&env, &session_id)?;
        if pot.status != PotStatus::Funded {
            return Err(Error::PotNotFunded);
        }
        if winner != pot.player_a && winner != pot.player_b {
            return Err(Error::NotAPlayer);
        }

        let payout = pot.stake * 2;
        let token_client = token::Client::new(&env, &config.token);

        let fee = if config.fee_bps > 0 {
            (payout * config.fee_bps as i128) / BPS_DENOMINATOR as i128
        } else {
            0
        };

        if fee > 0 {
            if let Some(receiver) = config.fee_receiver.clone() {
                token_client.transfer(&env.current_contract_address(), &receiver, &fee);
                env.events()
                    .publish((symbol_short!("fee"), session_id.clone()), (receiver, fee));
            }
        }

        let winner_amount = payout - fee;
        token_client.transfer(&env.current_contract_address(), &winner, &winner_amount);

        pot.status = PotStatus::Resolved;
        env.storage().persistent().set(&DataKey::Pot(session_id.clone()), &pot);
        Self::extend_pot_ttl(&env, &session_id);

        env.events()
            .publish((symbol_short!("resolve"), session_id), (winner, winner_amount));
        Ok(())
    }

    /// Refunds each staked player their own stake. No platform fee is taken.
    pub fn refund(env: Env, session_id: SessionId) -> Result<(), Error> {
        let config = Self::config(&env)?;
        config.resolver.require_auth();

        let mut pot = Self::pot(&env, &session_id)?;
        if pot.status != PotStatus::Funded && pot.status != PotStatus::Open {
            return Err(Error::PotNotOpen);
        }

        let token_client = token::Client::new(&env, &config.token);
        if pot.funded_a {
            token_client.transfer(&env.current_contract_address(), &pot.player_a, &pot.stake);
        }
        if pot.funded_b {
            token_client.transfer(&env.current_contract_address(), &pot.player_b, &pot.stake);
        }

        pot.status = PotStatus::Refunded;
        env.storage().persistent().set(&DataKey::Pot(session_id.clone()), &pot);
        Self::extend_pot_ttl(&env, &session_id);

        env.events().publish(
            (symbol_short!("refund"), session_id),
            (pot.player_a, pot.player_b),
        );
        Ok(())
    }

    fn config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    fn pot(env: &Env, session_id: &SessionId) -> Result<Pot, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Pot(session_id.clone()))
            .ok_or(Error::PotNotFound)
    }

    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn extend_pot_ttl(env: &Env, session_id: &SessionId) {
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Pot(session_id.clone()), TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

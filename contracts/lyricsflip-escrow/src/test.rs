#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, BytesN as _},
    token, Address, Env, IntoVal,
};

struct Setup {
    env: Env,
    contract_id: Address,
    client: EscrowContractClient<'static>,
    token: token::Client<'static>,
    resolver: Address,
    player_a: Address,
    player_b: Address,
}

fn setup(initial_balance: i128) -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let resolver = Address::generate(&env);
    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token::Client::new(&env, &token_contract.address());
    let token_admin_client =
        token::StellarAssetClient::new(&env, &token_contract.address());

    token_admin_client.mint(&player_a, &initial_balance);
    token_admin_client.mint(&player_b, &initial_balance);

    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), token_contract.address(), resolver.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    Setup {
        env,
        contract_id,
        client,
        token,
        resolver,
        player_a,
        player_b,
    }
}

fn session(env: &Env) -> SessionId {
    BytesN::random(env)
}

#[test]
fn winner_takes_the_whole_pot() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client
        .open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    assert_eq!(s.client.get_pot(&id).status, PotStatus::Funded);
    assert_eq!(s.token.balance(&s.contract_id), 200);

    let payout = s.client.resolve(&id, &s.player_a);

    assert_eq!(payout, 200);
    assert_eq!(s.token.balance(&s.player_a), 1_100);
    assert_eq!(s.token.balance(&s.player_b), 900);
    assert_eq!(s.token.balance(&s.contract_id), 0);
    assert_eq!(s.client.get_pot(&id).status, PotStatus::Resolved);
}

#[test]
fn refund_returns_each_stake() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    s.client.refund(&id);

    assert_eq!(s.token.balance(&s.player_a), 1_000);
    assert_eq!(s.token.balance(&s.player_b), 1_000);
    assert_eq!(s.client.get_pot(&id).status, PotStatus::Refunded);
}

#[test]
fn refund_handles_a_pot_only_one_player_funded() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);

    s.client.refund(&id);

    assert_eq!(s.token.balance(&s.player_a), 1_000);
    assert_eq!(s.token.balance(&s.player_b), 1_000);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn a_player_cannot_stake_twice() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);

    assert_eq!(
        s.client.try_stake(&id, &s.player_a),
        Err(Ok(Error::AlreadyStaked))
    );
}

#[test]
fn outsiders_cannot_stake() {
    let s = setup(1_000);
    let id = session(&s.env);
    let stranger = Address::generate(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);

    assert_eq!(
        s.client.try_stake(&id, &stranger),
        Err(Ok(Error::NotAPlayer))
    );
}

#[test]
fn the_pot_cannot_be_paid_to_a_non_player() {
    let s = setup(1_000);
    let id = session(&s.env);
    let stranger = Address::generate(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    assert_eq!(
        s.client.try_resolve(&id, &stranger),
        Err(Ok(Error::NotAPlayer))
    );
}

#[test]
fn an_underfunded_pot_cannot_be_resolved() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);

    assert_eq!(
        s.client.try_resolve(&id, &s.player_a),
        Err(Ok(Error::PotNotFunded))
    );
}

#[test]
fn a_pot_cannot_be_resolved_twice() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);
    s.client.resolve(&id, &s.player_a);

    assert_eq!(
        s.client.try_resolve(&id, &s.player_a),
        Err(Ok(Error::PotNotFunded))
    );
}

#[test]
fn sessions_cannot_be_reused() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);

    assert_eq!(
        s.client
            .try_open_pot(&id, &s.player_a, &s.player_b, &100),
        Err(Ok(Error::PotAlreadyExists))
    );
}

#[test]
fn stakes_must_be_positive() {
    let s = setup(1_000);
    let id = session(&s.env);

    assert_eq!(
        s.client.try_open_pot(&id, &s.player_a, &s.player_b, &0),
        Err(Ok(Error::InvalidStake))
    );
}

#[test]
fn the_admin_can_rotate_the_resolver() {
    let s = setup(1_000);
    let new_resolver = Address::generate(&s.env);

    s.client.set_resolver(&new_resolver);

    assert_eq!(s.client.get_config().resolver, new_resolver);
    assert_ne!(s.client.get_config().resolver, s.resolver);
}

#[test]
fn pot_and_instance_survive_past_default_ttl() {
    use soroban_sdk::testutils::Ledger;
    let s = setup(1_000);
    let session = BytesN::<16>::random(&s.env);
    s.client
        .open_pot(&session, &s.player_a, &s.player_b, &100);

    // Advance beyond the extension window's midpoint, then touch the pot.
    let seq = s.env.ledger().sequence();
    s.env.ledger().set_sequence_number(seq + TTL_THRESHOLD + 1);
    assert_eq!(s.client.get_pot(&session).stake, 100);

    // The read refreshed the TTL, so another jump of the same size is fine.
    let seq = s.env.ledger().sequence();
    s.env.ledger().set_sequence_number(seq + TTL_THRESHOLD + 1);
    assert_eq!(s.client.get_pot(&session).stake, 100);
    s.client.get_config();

    s.env.as_contract(&s.contract_id, || {
        let ttl = s
            .env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Pot(session.clone()));
        assert!(ttl >= TTL_THRESHOLD);
    });
}

#[test]
fn open_pot_emits_an_open_event() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);

    let events = s.env.events().all();
    let (contract_id, topics, _data) = events.last().unwrap();
    assert_eq!(contract_id, &s.contract_id);
    assert_eq!(
        topics.get_unchecked(0),
        soroban_sdk::symbol_short!("open").into_val(&s.env)
    );
}

#[test]
fn full_pot_lifecycle_emits_the_documented_events() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);
    s.client.resolve(&id, &s.player_a);

    let events = s.env.events().all();
    let topic_names: std::vec::Vec<_> = events
        .iter()
        .map(|(_, topics, _)| topics.get_unchecked(0))
        .collect();

    assert!(topic_names.contains(&soroban_sdk::symbol_short!("open").into_val(&s.env)));
    assert!(topic_names.contains(&soroban_sdk::symbol_short!("stake").into_val(&s.env)));
    assert!(topic_names.contains(&soroban_sdk::symbol_short!("resolve").into_val(&s.env)));
}

#[test]
fn refund_emits_a_refund_event() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.refund(&id);

    let events = s.env.events().all();
    let (_, topics, _) = events.last().unwrap();
    assert_eq!(
        topics.get_unchecked(0),
        soroban_sdk::symbol_short!("refund").into_val(&s.env)
    );
}

#[test]
fn default_config_has_no_fee() {
    let s = setup(1_000);
    let config = s.client.get_config();

    assert_eq!(config.fee_bps, 0);
    assert_eq!(config.max_fee_bps, MAX_FEE_BPS);
    assert_eq!(config.fee_receiver, None);
}

#[test]
fn zero_fee_pays_the_whole_pot_to_the_winner() {
    let s = setup(1_000);
    let id = session(&s.env);

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    let payout = s.client.resolve(&id, &s.player_a);

    assert_eq!(payout, 200);
    assert_eq!(s.token.balance(&s.player_a), 1_100);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn a_normal_fee_is_split_between_winner_and_receiver() {
    let s = setup(1_000);
    let id = session(&s.env);
    let receiver = Address::generate(&s.env);

    // 2.5% fee.
    s.client.set_fee(&250, &Some(receiver.clone()));

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    let payout = s.client.resolve(&id, &s.player_a);

    // 200 * 250 / 10_000 = 5 fee, 195 to the winner.
    assert_eq!(payout, 195);
    assert_eq!(s.token.balance(&s.player_a), 1_095);
    assert_eq!(s.token.balance(&receiver), 5);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn the_fee_is_capped() {
    let s = setup(1_000);
    let receiver = Address::generate(&s.env);

    assert_eq!(
        s.client.try_set_fee(&(MAX_FEE_BPS + 1), &Some(receiver.clone())),
        Err(Ok(Error::FeeTooHigh))
    );

    // Exactly at the cap is allowed.
    s.client.set_fee(&MAX_FEE_BPS, &Some(receiver.clone()));
    assert_eq!(s.client.get_config().fee_bps, MAX_FEE_BPS);
}

#[test]
fn a_non_zero_fee_requires_a_receiver() {
    let s = setup(1_000);

    assert_eq!(
        s.client.try_set_fee(&250, &None),
        Err(Ok(Error::FeeReceiverRequired))
    );

    // A zero fee with no receiver is fine.
    s.client.set_fee(&0, &None);
    assert_eq!(s.client.get_config().fee_bps, 0);
}

#[test]
fn the_fee_rounds_down() {
    let s = setup(1_000);
    let id = session(&s.env);
    let receiver = Address::generate(&s.env);

    // 1% fee on a 200 pot = 2 exactly; use a stake that produces a remainder.
    s.client.set_fee(&333, &Some(receiver.clone()));

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    let payout = s.client.resolve(&id, &s.player_a);

    // 200 * 333 / 10_000 = 6.66 -> 6 fee, 194 to the winner.
    assert_eq!(payout, 194);
    assert_eq!(s.token.balance(&receiver), 6);
    assert_eq!(s.token.balance(&s.player_a), 1_094);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn refunds_are_never_charged_a_fee() {
    let s = setup(1_000);
    let id = session(&s.env);
    let receiver = Address::generate(&s.env);

    s.client.set_fee(&250, &Some(receiver.clone()));

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);

    s.client.refund(&id);

    assert_eq!(s.token.balance(&s.player_a), 1_000);
    assert_eq!(s.token.balance(&s.player_b), 1_000);
    assert_eq!(s.token.balance(&receiver), 0);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn resolve_emits_a_fee_event() {
    let s = setup(1_000);
    let id = session(&s.env);
    let receiver = Address::generate(&s.env);

    s.client.set_fee(&250, &Some(receiver.clone()));

    s.client.open_pot(&id, &s.player_a, &s.player_b, &100);
    s.client.stake(&id, &s.player_a);
    s.client.stake(&id, &s.player_b);
    s.client.resolve(&id, &s.player_a);

    let events = s.env.events().all();
    let topic_names: std::vec::Vec<_> = events
        .iter()
        .map(|(_, topics, _)| topics.get_unchecked(0))
        .collect();

    assert!(topic_names.contains(&soroban_sdk::symbol_short!("fee").into_val(&s.env)));
}

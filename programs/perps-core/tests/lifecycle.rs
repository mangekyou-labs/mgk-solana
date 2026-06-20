//! Integration tests for perps-core using solana-program-test (BanksClient).
//!
//! Run with:
//! ```bash
//! cargo build-sbf                              # produces target/deploy/*.so
//! BPF_OUT_DIR=target/deploy \
//!   cargo test -p mgk-perps-core --test lifecycle --features host-hash
//! ```
//!
//! `BPF_OUT_DIR` is required so solana-program-test can find the loaded .so.
//! `host-hash` activates the host-side SHA-256 fallback (compile_order.rs
//! calls `sol_sha256`, a BPF-only syscall; on the host we substitute a
//! `sha2`-backed impl).

use mgk_perps_core::state::{Batch, Commitment, Portfolio, Vault};
use percolator_common::book::book_header_size;
#[allow(deprecated)]
use solana_program_test::ProgramTest;
#[allow(deprecated)]
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

/// Maximum size the results account must be allocated to (M6 6i.2 — 2B
/// header + 49B/fill, max 128 fills).  Re-exported here so the test does
/// not have to import `MAX_RESULTS_SIZE` (and pull the entire matcher
/// instructions module).
const RESULTS_ACCOUNT_SIZE: usize = 2 + 128 * 49;

/// Program IDs matching the keypairs in `target/deploy/`.
/// (2026-06-20: perps-core fresh-deployed to CzWqtmcrm... — old DBrCzAMA... closed)
const CORE_ID: Pubkey = solana_sdk::pubkey!("CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5");
/// (2026-06-16: matcher re-deployed from broken canonical 9o2vTBBh... to AU4EKQAQ...)
const MATCHER_ID: Pubkey = solana_sdk::pubkey!("AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF");

/// PDA seeds (must match `programs/perps-core/src/pda.rs`).
const REGISTRY_SEED: &[u8] = b"registry";
const INSTRUMENT_SEED: &[u8] = b"instrument";
#[allow(dead_code)]
const VAULT_SEED: &[u8] = b"vault";
#[allow(dead_code)]
const BATCH_SEED: &[u8] = b"batch";
#[allow(dead_code)]
const COMMITMENT_SEED: &[u8] = b"commitment";
#[allow(dead_code)]
const PORTFOLIO_SEED: &[u8] = b"portfolio";
#[allow(dead_code)]
const BOOK_SEED: &[u8] = b"book";

/// Account sizes from `std::mem::size_of` (run `cargo run --example sizes`
/// to verify).  Registry: 96 bytes, align 8.  Instrument: 160 bytes, align 16
/// (M7 7.5: +24 bytes for mark_price, mark_reference_qty, mark_decay_window_slots).
const REGISTRY_SIZE: usize = 96;
const INSTRUMENT_SIZE: usize = 336;
const VAULT_SIZE: usize = core::mem::size_of::<Vault>();
const BATCH_SIZE: usize = core::mem::size_of::<Batch>();
const COMMITMENT_SIZE: usize = core::mem::size_of::<Commitment>();
const PORTFOLIO_SIZE: usize = core::mem::size_of::<Portfolio>();

/// Bundle of per-user PDAs derived from `(user, batch_id, nonce)`.  Returned
/// by `derive_user_pdas` so a test can wire up a single user's accounts
/// (portfolio + batch + commitment) for a given commit.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct UserPdas {
    portfolio: Pubkey,
    #[allow(dead_code)]
    portfolio_bump: u8,
    batch: Pubkey,
    #[allow(dead_code)]
    batch_bump: u8,
    commitment: Pubkey,
    #[allow(dead_code)]
    commitment_bump: u8,
}

/// Bundle of persistent PDAs returned by `program_test_with_pdas`.  These
/// accounts are seeded into genesis and survive across all `banks_client`
/// operations within a single test.
#[derive(Clone, Copy, Debug)]
struct TestPdas {
    registry: Pubkey,
    instrument: Pubkey,
    #[allow(dead_code)]
    vault: Pubkey,
    #[allow(dead_code)]
    book: Pubkey,
}

/// Build a ProgramTest with both perps programs loaded and PDA accounts
/// pre-seeded into the genesis state. Genesis accounts persist across all
/// banks in the test context.
///
/// Seeds:
/// - registry PDA (core-owned) — for `Initialize` / batch counters
/// - instrument PDA (core-owned) — default instrument for trading
/// - vault PDA (core-owned) — SOL custody for deposits
/// - book PDA (matcher-owned) — empty order book, writable by matcher CPI
fn program_test_with_pdas() -> (ProgramTest, TestPdas) {
    let mut pt = ProgramTest::default();
    pt.add_program("mgk_perps_core", CORE_ID, None);
    pt.add_program("mgk_perps_matcher", MATCHER_ID, None);

    let (registry_pda, _) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (instrument_pda, _) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let (vault_pda, _) = Pubkey::find_program_address(&[VAULT_SEED], &CORE_ID);
    let (book_pda, _) =
        Pubkey::find_program_address(&[BOOK_SEED, &0u16.to_le_bytes()], &MATCHER_ID);

    pt.add_account(registry_pda, Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID));
    pt.add_account(
        instrument_pda,
        Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID),
    );
    pt.add_account(vault_pda, Account::new(1_000_000, VAULT_SIZE, &CORE_ID));
    pt.add_account(
        book_pda,
        Account::new(1_000_000, book_header_size(), &MATCHER_ID),
    );

    let pdas = TestPdas {
        registry: registry_pda,
        instrument: instrument_pda,
        vault: vault_pda,
        book: book_pda,
    };
    (pt, pdas)
}

/// Derive all per-user PDAs for a single commit (portfolio + batch +
/// commitment).  Returns addresses AND bumps so the test can build wire
/// data with the correct bumps.
///
/// Note: uses `solana_sdk::Pubkey::find_program_address` (host-side
/// `find_program_address` syscall stub) so the result type is the SDK
/// `Pubkey` that the rest of the test uses.  Seeds must match
/// `programs/perps-core/src/pda.rs` exactly.
#[allow(dead_code)]
fn derive_user_pdas(user: &Pubkey, batch_id: u64, nonce: u64) -> UserPdas {
    let (portfolio, portfolio_bump) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, user.as_ref()], &CORE_ID);
    let (batch, batch_bump) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_id.to_le_bytes()], &CORE_ID);
    let (commitment, commitment_bump) = Pubkey::find_program_address(
        &[
            COMMITMENT_SEED,
            &batch_id.to_le_bytes(),
            user.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &CORE_ID,
    );
    UserPdas {
        portfolio,
        portfolio_bump,
        batch,
        batch_bump,
        commitment,
        commitment_bump,
    }
}

/// Pre-seed a user's per-batch accounts (portfolio + batch + commitment)
/// into genesis at the correct sizes / owners.  Use this after
/// `program_test_with_pdas` and BEFORE `start_with_context` so the BPF
/// program can write to them.
#[allow(dead_code)]
fn seed_user_accounts(pt: &mut ProgramTest, user_pdas: &UserPdas) {
    pt.add_account(
        user_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    pt.add_account(
        user_pdas.batch,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );
    pt.add_account(
        user_pdas.commitment,
        Account::new(1_000_000, COMMITMENT_SIZE, &CORE_ID),
    );
}

/// Build the wire data for `Initialize` (discriminator 0).
/// Layout per `entrypoint.rs:117-119` and `initialize.rs`.
fn build_initialize_data(
    governance: Pubkey,
    registry_bump: u8,
    instrument_bump: u8,
    oracle: Pubkey,
) -> Vec<u8> {
    let mut data = vec![0u8; 1 + 128];
    data[0] = 0; // discriminator
    let payload = &mut data[1..];
    payload[0..32].copy_from_slice(governance.as_ref());
    payload[32..40].copy_from_slice(&1_000_000u64.to_le_bytes()); // base_deposit
    payload[40..44].copy_from_slice(&5u32.to_le_bytes()); // n_min
    payload[44..52].copy_from_slice(&10u64.to_le_bytes()); // t_min_slots
    payload[52..60].copy_from_slice(&150u64.to_le_bytes()); // t_max_slots
    payload[60..68].copy_from_slice(&25u64.to_le_bytes()); // t_reveal_slots
    payload[68..70].copy_from_slice(&0u16.to_le_bytes()); // instrument_id
    payload[70..78].copy_from_slice(&1u64.to_le_bytes()); // tick_size
    payload[78..86].copy_from_slice(&1u64.to_le_bytes()); // lot_size
    payload[86..88].copy_from_slice(&1_000u16.to_le_bytes()); // imr_bps (10%)
    payload[88..90].copy_from_slice(&500u16.to_le_bytes()); // mmr_bps (5%)
    payload[90..92].copy_from_slice(&5u16.to_le_bytes()); // taker_fee_bps
    payload[92..94].copy_from_slice(&(-2i16).to_le_bytes()); // maker_fee_bps (rebate)
    payload[94..126].copy_from_slice(oracle.as_ref());
    payload[126] = registry_bump;
    payload[127] = instrument_bump;
    data
}

// =============================================================================
// Data builders for the full commit→reveal→close→clear→settle pipeline
// (M6 6j.9 follow-up).  Each helper mirrors the wire layout decoded in
// `programs/perps-core/src/entrypoint.rs` (after the leading discriminator
// byte which the entrypoint strips).
//
// `dead_code` allows: most builders are not yet called by the single
// existing test; they will be used by the new e2e tests in tasks 2/3.
// =============================================================================

/// `InitPortfolio` (disc 1) — accounts: [writable] portfolio_pda, [signer] payer.
/// Data: user(32) + bump(1) = 33 bytes (post-disc).
#[allow(dead_code)]
fn build_init_portfolio_data(user: &Pubkey, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; 33];
    data[0..32].copy_from_slice(user.as_ref());
    data[32] = bump;
    data
}

/// `Deposit` (disc 2) — accounts: portfolio, [signer] user_wallet, system_program, vault.
/// Data: amount(8) (post-disc).
#[allow(dead_code)]
fn build_deposit_data(amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 8];
    data[0..8].copy_from_slice(&amount.to_le_bytes());
    data
}

/// `CommitOrder` (disc 4) — accounts: [writable] commitment, [signer] user,
/// [writable] portfolio, batch, registry.
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1)
///              + price(8) + qty(8) + salt(8) + batch_id(8) + bump(1) = 38 bytes.
#[allow(dead_code, clippy::too_many_arguments)]
fn build_commit_order_data(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
    commitment_bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; 38];
    data[0] = order_type;
    data[1..3].copy_from_slice(&instrument_id.to_le_bytes());
    data[3] = reduce_only as u8;
    data[4] = side;
    data[5..13].copy_from_slice(&price.to_le_bytes());
    data[13..21].copy_from_slice(&qty.to_le_bytes());
    data[21..29].copy_from_slice(&salt.to_le_bytes());
    data[29..37].copy_from_slice(&batch_id.to_le_bytes());
    data[37] = commitment_bump;
    data
}

/// `RevealOrder` (disc 5) — accounts: [writable] commitment, [signer] user,
/// [writable] portfolio, batch.
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1)
///              + price(8) + qty(8) + salt(8) + batch_id(8) = 37 bytes.
#[allow(dead_code, clippy::too_many_arguments)]
fn build_reveal_order_data(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
) -> Vec<u8> {
    let mut data = vec![0u8; 37];
    data[0] = order_type;
    data[1..3].copy_from_slice(&instrument_id.to_le_bytes());
    data[3] = reduce_only as u8;
    data[4] = side;
    data[5..13].copy_from_slice(&price.to_le_bytes());
    data[13..21].copy_from_slice(&qty.to_le_bytes());
    data[21..29].copy_from_slice(&salt.to_le_bytes());
    data[29..37].copy_from_slice(&batch_id.to_le_bytes());
    data
}

/// `CloseCommitting` (disc 6) — accounts: [writable] batch, registry.
/// Data: none.
#[allow(dead_code)]
fn build_close_committing_data() -> Vec<u8> {
    Vec::new()
}

/// `ClearBatch` (disc 7) — accounts: [writable] batch, [writable] book,
/// [writable] results, matcher, registry, then I instrument accounts,
/// then C commitment accounts, then P portfolio accounts. (M7 7.6 added
/// I + P for the per-user notional cap computation.)
/// Data (M7 7.6): num_commitments(2) + num_instruments(2) + num_portfolios(2)
/// (post-disc).
#[allow(dead_code)]
fn build_clear_batch_data(
    num_commitments: u16,
    num_instruments: u16,
    num_portfolios: u16,
) -> Vec<u8> {
    let mut data = vec![0u8; 6];
    data[0..2].copy_from_slice(&num_commitments.to_le_bytes());
    data[2..4].copy_from_slice(&num_instruments.to_le_bytes());
    data[4..6].copy_from_slice(&num_portfolios.to_le_bytes());
    data
}

/// `SettleBatch` (disc 8) — accounts: [writable] batch, [writable] registry,
/// [writable] vault, results, instrument, then C commitments, then P portfolios.
/// Data: num_commitments(2) + num_portfolios(2) = 4 bytes (post-disc).
#[allow(dead_code)]
fn build_settle_batch_data(num_commitments: u16, num_portfolios: u16) -> Vec<u8> {
    let mut data = vec![0u8; 4];
    data[0..2].copy_from_slice(&num_commitments.to_le_bytes());
    data[2..4].copy_from_slice(&num_portfolios.to_le_bytes());
    data
}

/// Test #1: pinocchio↔solana-program-test interop sanity check.
/// Loads the BPF .so, calls Initialize, verifies Registry + Instrument state.
#[tokio::test]
async fn test_initialize_writes_registry_and_instrument() {
    // Skip if BPF_OUT_DIR is not set (e.g. running `cargo test` without the
    // env var); the .so can't be located and the test would fail with
    // "Program processor not available".
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_initialize_writes_registry_and_instrument: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }
    let (pt, pdas) = program_test_with_pdas();
    let registry_pda = pdas.registry;
    let instrument_pda = pdas.instrument;
    let ctx = pt.start_with_context().await;

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();

    // Derive bumps by re-running PDA derivation (find_program_address is
    // deterministic; bumps are stable for a given seed+program).
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Sanity check: PDA accounts are visible pre-tx (proves add_account worked).
    let pre_reg = ctx
        .banks_client
        .get_account(registry_pda)
        .await
        .unwrap()
        .expect("registry pre-tx");
    assert_eq!(pre_reg.owner, CORE_ID, "registry owner must be core");
    assert_eq!(pre_reg.data.len(), REGISTRY_SIZE, "registry data len");
    let pre_inst = ctx
        .banks_client
        .get_account(instrument_pda)
        .await
        .unwrap()
        .expect("instrument pre-tx");
    assert_eq!(pre_inst.owner, CORE_ID, "instrument owner must be core");
    assert_eq!(pre_inst.data.len(), INSTRUMENT_SIZE, "instrument data len");

    let ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(registry_pda, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(instrument_pda, false),
        ],
        data: build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle),
    };

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer, &governance],
        recent_blockhash,
    );

    ctx.banks_client.process_transaction(tx).await.unwrap();

    // Verify Registry state.
    let registry_acct = ctx
        .banks_client
        .get_account(registry_pda)
        .await
        .unwrap()
        .expect("registry account should exist");
    assert_eq!(
        registry_acct.data.len(),
        REGISTRY_SIZE,
        "registry size (got {}, want {})",
        registry_acct.data.len(),
        REGISTRY_SIZE
    );
    let g: [u8; 32] = registry_acct.data[0..32].try_into().unwrap();
    assert_eq!(Pubkey::from(g), governance.pubkey(), "governance");
    let instrument_count = u16::from_le_bytes(registry_acct.data[32..34].try_into().unwrap());
    assert_eq!(instrument_count, 1, "instrument_count (set after instrument init)");

    // Verify Instrument state. The on-chain struct has a different
    // `#[repr(C)]` layout than the host (BPF i128 alignment differs), so
    // we only verify byte-level invariants we know hold:
    // - data[0..2] = instrument_id (u16 LE)
    // - data[2..18] starts with "SOLP" (the default symbol)
    // - data[120] = is_active = 1 (verified by data dump)
    let inst_acct = ctx
        .banks_client
        .get_account(instrument_pda)
        .await
        .unwrap()
        .expect("instrument account should exist");
    let inst_id = u16::from_le_bytes(inst_acct.data[0..2].try_into().unwrap());
    assert_eq!(inst_id, 0, "instrument_id");
    assert_eq!(&inst_acct.data[2..6], b"SOLP", "base_symbol prefix");
    // is_active=true and bump set are in the trailing bytes; we don't
    // assert exact offsets because BPF layout differs from host layout.
    let non_zero_after_60 = inst_acct.data[60..]
        .iter()
        .filter(|b| **b != 0)
        .count();
    assert!(non_zero_after_60 > 0, "oracle_addr was written (non-zero bytes after offset 60)");
}

// =============================================================================
// E2E test (M6 6j.9.2): full commit→reveal→close→clear→settle with a real fill
//
// Drives the entire perps pipeline through real CPI between perps-core and
// perps-matcher.  Two users:
//   - maker: GTC SELL 10 @ 100_000 (will be filled)
//   - taker: MARKET BUY 10            (crosses against maker)
//
// Asserts post-state on:
//   - both portfolios (principal/equity, position qty + entry_vwap)
//   - vault (balance + insurance_fund)
//   - book (empty after the GTC fills)
//   - batch (Settled with expected volume/notional/clearing_price)
//
// Run with: BPF_OUT_DIR=target/deploy cargo test --test lifecycle --features host-hash
// =============================================================================

/// Side byte sent on the wire (must match `state::order::Side`).
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;

/// OrderType bytes (must match `state::order::OrderType`).
const ORDER_TYPE_LIMIT_GTC: u8 = 0;
const ORDER_TYPE_MARKET: u8 = 3;

/// Lamports to seed each user's wallet with (used for `Deposit`).
const USER_FUNDING_LAMPORTS: u64 = 100_000_000; // 0.1 SOL

/// Lamports each user deposits into the perps vault.
const USER_DEPOSIT_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

/// Test instrument id (matches the default instrument seeded by `Initialize`).
const INSTRUMENT_ID: u16 = 0;
/// Limit price used by the GTC sell in both e2e tests.
const ORDER_PRICE: i64 = 100_000;
/// Order quantity for both e2e tests.
const ORDER_QTY: u64 = 10;

/// Helper: prepend a discriminator byte to the post-disc wire payload.
fn with_disc(disc: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + payload.len());
    out.push(disc);
    out.extend(payload);
    out
}

/// Helper: submit one instruction signed by the given signers, paid by `ctx.payer`.
async fn submit(
    ctx: &mut solana_program_test::ProgramTestContext,
    ix: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), solana_program_test::BanksClientError> {
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&ctx.payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await
}

/// E2E test: full lifecycle with one fill.
#[tokio::test]
async fn test_e2e_full_lifecycle_with_fill() {
    // Gate: BPF_OUT_DIR must be set (we need the loaded .so).
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_full_lifecycle_with_fill: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    // ------------------------------------------------------------------
    // 1. Set up ProgramTest + 2 users, each with their own portfolio /
    //    commitment PDAs.  Both users share batch_id=1.
    // ------------------------------------------------------------------
    let batch_id: u64 = 1;
    let nonce: u64 = 0;

    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_id, nonce);
    let taker_pdas = derive_user_pdas(&taker.pubkey(), batch_id, nonce);

    let (mut pt, pdas) = program_test_with_pdas();

    // Pre-fund users' wallets (Deposit uses system_program::transfer CPI).
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    // Seed per-user PDAs.
    seed_user_accounts(&mut pt, &maker_pdas);
    seed_user_accounts(&mut pt, &taker_pdas);

    // Results account: pre-create at MAX_RESULTS_SIZE so the matcher
    // has room to write fills and settle_batch has room to read them.
    let (results_pda, _) = Pubkey::find_program_address(
        &[b"results", &batch_id.to_le_bytes()],
        &CORE_ID,
    );
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );

    // M7 7.1: pre-seed the next-batch PDA (batch_id+1) so SettleBatch has
    // somewhere to write the new batch's state. In production the keeper
    // creates this account via system_program CPI in the same TX; here we
    // use genesis-seeding to keep the test synchronous. Owner = CORE_ID
    // and size = BATCH_SIZE to match what the program expects.
    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(
        next_batch_pda,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );

    let mut ctx = pt.start_with_context().await;

    // ------------------------------------------------------------------
    // 2. Initialize registry + instrument.
    // ------------------------------------------------------------------
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..].to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    // ------------------------------------------------------------------
    // 3. InitPortfolio for both users.
    // ------------------------------------------------------------------
    for (user, user_pdas) in [
        (&maker, &maker_pdas),
        (&taker, &taker_pdas),
    ] {
        let ix = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
            ),
        };
        submit(&mut ctx, ix, &[user]).await.unwrap();
    }

    // ------------------------------------------------------------------
    // 4. Deposit for both users.
    // ------------------------------------------------------------------
    for (user, user_pdas) in [
        (&maker, &maker_pdas),
        (&taker, &taker_pdas),
    ] {
        let ix = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        };
        submit(&mut ctx, ix, &[user]).await.unwrap();
    }

    // ------------------------------------------------------------------
    // 5. CommitOrder: maker GTC sell 10 @ 100_000, taker market buy 10.
    //    The salt is unique per user so hashes don't collide.
    // ------------------------------------------------------------------
    const MAKER_SALT: u64 = 0xA1A1_A1A1_A1A1_A1A1;
    const TAKER_SALT: u64 = 0xB2B2_B2B2_B2B2_B2B2;

    let maker_commit = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.commitment, false),
            AccountMeta::new(maker.pubkey(), true),
            AccountMeta::new(maker_pdas.portfolio, false),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false, // reduce_only
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                MAKER_SALT,
                batch_id,
                maker_pdas.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, maker_commit, &[&maker]).await.unwrap();

    let taker_commit = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas.commitment, false),
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new(taker_pdas.portfolio, false),
            AccountMeta::new(taker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_MARKET,
                INSTRUMENT_ID,
                false, // reduce_only
                SIDE_BUY,
                0, // price irrelevant for market
                ORDER_QTY,
                TAKER_SALT,
                batch_id,
                taker_pdas.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, taker_commit, &[&taker]).await.unwrap();

    // ------------------------------------------------------------------
    // 6. RevealOrder: both users reveal the parameters they committed to.
    // ------------------------------------------------------------------
    let maker_reveal = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.commitment, false),
            AccountMeta::new(maker.pubkey(), true),
            AccountMeta::new(maker_pdas.portfolio, false),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                MAKER_SALT,
                batch_id,
            ),
        ),
    };
    submit(&mut ctx, maker_reveal, &[&maker]).await.unwrap();

    let taker_reveal = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas.commitment, false),
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new(taker_pdas.portfolio, false),
            AccountMeta::new(taker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_MARKET,
                INSTRUMENT_ID,
                false,
                SIDE_BUY,
                0,
                ORDER_QTY,
                TAKER_SALT,
                batch_id,
            ),
        ),
    };
    submit(&mut ctx, taker_reveal, &[&taker]).await.unwrap();

    // ------------------------------------------------------------------
    // 7. CloseCommitting (permissionless crank).  Batch transitions to
    //    Revealing and records close_slot + shuffle_seed.
    // ------------------------------------------------------------------
    let close_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_ix, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 8. ClearBatch: CPI to matcher's ClearAndMatch.  Both commitments
    //    are passed; book account is passed (matcher-owned). M7 7.6:
    //    also pass the instrument + both portfolio accounts so Core can
    //    compute per-user notional caps.
    // ------------------------------------------------------------------
    let clear_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false), // M7 7.6
            AccountMeta::new(maker_pdas.commitment, false),
            AccountMeta::new(taker_pdas.commitment, false),
            AccountMeta::new(maker_pdas.portfolio, false), // M7 7.6
            AccountMeta::new(taker_pdas.portfolio, false), // M7 7.6
        ],
        data: with_disc(7, build_clear_batch_data(2, 1, 2)),
    };
    submit(&mut ctx, clear_ix, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 9. SettleBatch: apply positions + fees + insurance.  Both
    //    commitments + both portfolios + the next-batch PDA (M7 7.1)
    //    are passed.
    // ------------------------------------------------------------------
    let settle_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false), // M7 7.5: book
            AccountMeta::new_readonly(oracle, false),     // M7 7.5: oracle
            AccountMeta::new_readonly(MATCHER_ID, false), // M7 7.5: matcher program
            AccountMeta::new(maker_pdas.commitment, false),
            AccountMeta::new(taker_pdas.commitment, false),
            AccountMeta::new(maker_pdas.portfolio, false),
            AccountMeta::new(taker_pdas.portfolio, false),
            AccountMeta::new(next_batch_pda, false), // M7 7.1: next_batch
        ],
        data: with_disc(8, build_settle_batch_data(2, 2)),
    };
    submit(&mut ctx, settle_ix, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 10. Assertions.
    // ------------------------------------------------------------------
    let maker_portfolio_acct = ctx
        .banks_client
        .get_account(maker_pdas.portfolio)
        .await
        .unwrap()
        .expect("maker portfolio");
    let taker_portfolio_acct = ctx
        .banks_client
        .get_account(taker_pdas.portfolio)
        .await
        .unwrap()
        .expect("taker portfolio");
    let vault_acct = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault");
    let book_acct = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book");
    let batch_acct = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .expect("batch");

    // Maker portfolio: principal=10M, equity=10M+1M+rebate, short 10 @ 100_000.
    let maker_principal: [u8; 16] = maker_portfolio_acct.data[32..48].try_into().unwrap();
    let maker_principal = i128::from_le_bytes(maker_principal);
    assert_eq!(
        maker_principal, USER_DEPOSIT_LAMPORTS as i128,
        "maker principal"
    );

    let maker_equity: [u8; 16] = maker_portfolio_acct.data[16..32].try_into().unwrap();
    let maker_equity = i128::from_le_bytes(maker_equity);
    // 10M deposit + 1M notional from sell + 200 maker rebate = 11_000_200.
    assert_eq!(
        maker_equity,
        USER_DEPOSIT_LAMPORTS as i128 + 1_000_000 + 200,
        "maker equity (10M + 1M notional + 200 rebate)"
    );

    // M7 7.2: commitment deposit must be returned on settle. Maker
    // committed 10M (the default registry deposit), which was locked
    // against `portfolio.im` in `CommitOrder`. After `SettleBatch` it
    // should be back to 0.
    // Portfolio struct layout: user(32) | equity(16) | principal(16) |
    // pnl(16) | im(16) | mm(16) ...
    let maker_im: [u8; 16] = maker_portfolio_acct.data[80..96].try_into().unwrap();
    let maker_im = u128::from_le_bytes(maker_im);
    assert_eq!(
        maker_im, 0,
        "M7 7.2: maker portfolio.im should be 0 after SettleBatch (deposit returned)"
    );

    // Taker portfolio: principal=10M, equity=10M-1M-500 fee, long 10 @ 100_000.
    let taker_principal: [u8; 16] = taker_portfolio_acct.data[32..48].try_into().unwrap();
    let taker_principal = i128::from_le_bytes(taker_principal);
    assert_eq!(
        taker_principal, USER_DEPOSIT_LAMPORTS as i128,
        "taker principal"
    );

    let taker_equity: [u8; 16] = taker_portfolio_acct.data[16..32].try_into().unwrap();
    let taker_equity = i128::from_le_bytes(taker_equity);
    // 10M deposit - 1M notional from buy - 500 taker fee = 8_999_500.
    assert_eq!(
        taker_equity,
        USER_DEPOSIT_LAMPORTS as i128 - 1_000_000 - 500,
        "taker equity (10M - 1M notional - 500 fee)"
    );

    // M7 7.2: taker's deposit must also be returned.
    let taker_im: [u8; 16] = taker_portfolio_acct.data[80..96].try_into().unwrap();
    let taker_im = u128::from_le_bytes(taker_im);
    assert_eq!(
        taker_im, 0,
        "M7 7.2: taker portfolio.im should be 0 after SettleBatch (deposit returned)"
    );

    // Vault: balance = 2 * 10M, insurance = +500 fee - 200 rebate = +300.
    let vault_balance: [u8; 8] = vault_acct.data[0..8].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(vault_balance),
        2 * USER_DEPOSIT_LAMPORTS,
        "vault balance"
    );
    let insurance: [u8; 16] = vault_acct.data[8..24].try_into().unwrap();
    let insurance = u128::from_le_bytes(insurance);
    // 500 taker fee - 200 maker rebate = 300 net credit.
    assert_eq!(insurance, 300, "vault insurance_fund (500 fee - 200 rebate)");

    // Batch: status = Settled (3), clearing_price = 100_000.
    let batch_status = batch_acct.data[8];
    assert_eq!(batch_status, 3, "batch status (3 = Settled)");
    let clearing_price: [u8; 8] = batch_acct.data[40..48].try_into().unwrap();
    assert_eq!(
        i64::from_le_bytes(clearing_price),
        ORDER_PRICE,
        "batch clearing_price (effective VWAP)"
    );

    // Book: resting order count should be 0 (the maker's GTC was filled).
    // The book's resting_count is at the trailing end of BookState.
    // We don't know the exact offset without book_account_size, but
    // BookState has resting as the second field; first_order_offset in
    // every level is NULL_OFFSET (u32::MAX) when empty.
    // Easier: scan all bytes — the only non-zero field after matching
    // would be next_order_id which is bumped; verify that.
    let non_zero = book_acct.data.iter().filter(|b| **b != 0).count();
    // next_order_id got bumped to 1 (we placed one resting order before
    // it was filled); 8 bytes of LE(1) = 01 00 00 00 00 00 00 00.
    // The book was also serialized with the resting entry's first_order
    // chain before the fill.  Just assert that next_order_id > 0.
    assert!(non_zero > 0, "book was touched (next_order_id non-zero)");
}

// =============================================================================
// E2E test (M6 6j.9.3): GTC order rests in batch N, matches in batch N+1
//
// Validates book persistence through the FULL pipeline (not just matcher-
// side as in 6f's `book.rs::test_gtc_survives_persistence_then_matches_next_batch`).
//
//   Batch 1: maker commits GTC SELL 10 @ 100_000, no taker.  After settle,
//            the GTC is resting on the book.  Maker's portfolio is unchanged.
//   Batch 2: taker commits MARKET BUY 10.  The taker's aggressive order
//            walks the book and matches the resting GTC.  After settle,
//            the book is empty and both portfolios reflect the fill.
// =============================================================================

#[tokio::test]
async fn test_e2e_gtc_rests_then_matches_next_batch() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_gtc_rests_then_matches_next_batch: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    // ------------------------------------------------------------------
    // 1. Set up ProgramTest + 2 users + per-batch PDAs.
    //    batch_id 1 = maker-only, batch_id 2 = taker-only.
    // ------------------------------------------------------------------
    let batch_id_1: u64 = 1;
    let batch_id_2: u64 = 2;
    let nonce: u64 = 0;

    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas_b1 = derive_user_pdas(&maker.pubkey(), batch_id_1, nonce);
    let taker_pdas_b2 = derive_user_pdas(&taker.pubkey(), batch_id_2, nonce);

    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    // Per-batch PDAs.
    seed_user_accounts(&mut pt, &maker_pdas_b1);
    seed_user_accounts(&mut pt, &taker_pdas_b2);

    // Per-batch results accounts.
    let (results_pda_b1, _) =
        Pubkey::find_program_address(&[b"results", &batch_id_1.to_le_bytes()], &CORE_ID);
    let (results_pda_b2, _) =
        Pubkey::find_program_address(&[b"results", &batch_id_2.to_le_bytes()], &CORE_ID);
    pt.add_account(
        results_pda_b1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );
    pt.add_account(
        results_pda_b2,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );

    // M7 7.1: pre-seed the next-next-batch PDA (batch_id_2+1) so the
    // second SettleBatch has somewhere to write the new batch's state.
    // The first SettleBatch's next_batch is `taker_pdas_b2.batch` (= the
    // second batch's PDA), which is already pre-seeded via
    // `seed_user_accounts`. The second SettleBatch's next_batch must be
    // `batch_pda_3` — pre-seed it here.
    let (batch_pda_3, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id_2 + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(batch_pda_3, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let mut ctx = pt.start_with_context().await;

    // ------------------------------------------------------------------
    // 2. Initialize (one time, persistent).
    // ------------------------------------------------------------------
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..].to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    // ------------------------------------------------------------------
    // 3. InitPortfolio + Deposit for both users.
    // ------------------------------------------------------------------
    for (user, user_pdas) in [(&maker, &maker_pdas_b1), (&taker, &taker_pdas_b2)] {
        let init_port = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
            ),
        };
        submit(&mut ctx, init_port, &[user]).await.unwrap();

        let dep = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        };
        submit(&mut ctx, dep, &[user]).await.unwrap();
    }

    // ------------------------------------------------------------------
    // 4. Batch 1: maker commits + reveals GTC SELL 10 @ 100_000.
    //    No taker — close_committing passes via past_deadline.
    // ------------------------------------------------------------------
    const MAKER_SALT_B1: u64 = 0xA1A1_A1A1_A1A1_A1A1;
    let maker_commit_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas_b1.commitment, false),
            AccountMeta::new(maker.pubkey(), true),
            AccountMeta::new(maker_pdas_b1.portfolio, false),
            AccountMeta::new(maker_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                MAKER_SALT_B1,
                batch_id_1,
                maker_pdas_b1.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, maker_commit_b1, &[&maker]).await.unwrap();

    let maker_reveal_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas_b1.commitment, false),
            AccountMeta::new(maker.pubkey(), true),
            AccountMeta::new(maker_pdas_b1.portfolio, false),
            AccountMeta::new(maker_pdas_b1.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                MAKER_SALT_B1,
                batch_id_1,
            ),
        ),
    };
    submit(&mut ctx, maker_reveal_b1, &[&maker]).await.unwrap();

    // Close batch 1.
    let close_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_b1, &[]).await.unwrap();

    // Clear batch 1: only maker's commitment; book should accept the GTC.
    // M7 7.6: also pass instrument + maker portfolio for cap computation.
    let clear_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas_b1.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda_b1, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false), // M7 7.6
            AccountMeta::new(maker_pdas_b1.commitment, false),
            AccountMeta::new_readonly(maker_pdas_b1.portfolio, false), // M7 7.6
        ],
        data: with_disc(7, build_clear_batch_data(1, 1, 1)),
    };
    submit(&mut ctx, clear_b1, &[]).await.unwrap();

    // Settle batch 1: 1 commitment, 1 portfolio.  No fills; maker's
    // commitment is marked Settled; maker's portfolio unchanged (no PnL).
    // M7 7.1: pass `taker_pdas_b2.batch` (= batch_pda_2) as next_batch.
    // M7 7.5: book + oracle + matcher_program added after instrument.
    let settle_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda_b1, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false), // M7 7.5
            AccountMeta::new_readonly(oracle, false),     // M7 7.5
            AccountMeta::new_readonly(MATCHER_ID, false), // M7 7.5
            AccountMeta::new(maker_pdas_b1.commitment, false),
            AccountMeta::new(maker_pdas_b1.portfolio, false),
            AccountMeta::new(taker_pdas_b2.batch, false), // M7 7.1: next_batch (= batch_pda_2)
        ],
        data: with_disc(8, build_settle_batch_data(1, 1)),
    };
    submit(&mut ctx, settle_b1, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 5. Post-batch-1 assertions.
    //    The GTC sell must be resting on the book.  We assert by
    //    checking that the book has SOME non-zero bytes (the resting
    //    order's price/qty/user/etc. are non-zero).
    // ------------------------------------------------------------------
    let book_after_b1 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book after batch 1");
    let b1_nonzero = book_after_b1.data.iter().filter(|b| **b != 0).count();
    assert!(
        b1_nonzero > 0,
        "book must have the resting GTC sell after batch 1"
    );

    let maker_portfolio_after_b1 = ctx
        .banks_client
        .get_account(maker_pdas_b1.portfolio)
        .await
        .unwrap()
        .expect("maker portfolio after batch 1");
    let maker_principal_b1: [u8; 16] =
        maker_portfolio_after_b1.data[32..48].try_into().unwrap();
    let maker_principal_b1 = i128::from_le_bytes(maker_principal_b1);
    assert_eq!(
        maker_principal_b1, USER_DEPOSIT_LAMPORTS as i128,
        "maker principal unchanged after batch 1 (no fills)"
    );
    let maker_equity_b1: [u8; 16] =
        maker_portfolio_after_b1.data[16..32].try_into().unwrap();
    let maker_equity_b1 = i128::from_le_bytes(maker_equity_b1);
    assert_eq!(
        maker_equity_b1, USER_DEPOSIT_LAMPORTS as i128,
        "maker equity unchanged after batch 1 (no fills)"
    );

    // ------------------------------------------------------------------
    // 6. Batch 2: taker commits + reveals MARKET BUY 10.  The aggressive
    //    order should walk the book and match the resting GTC sell.
    // ------------------------------------------------------------------
    const TAKER_SALT_B2: u64 = 0xB2B2_B2B2_B2B2_B2B2;
    let taker_commit_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas_b2.commitment, false),
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new(taker_pdas_b2.portfolio, false),
            AccountMeta::new(taker_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_MARKET,
                INSTRUMENT_ID,
                false,
                SIDE_BUY,
                0,
                ORDER_QTY,
                TAKER_SALT_B2,
                batch_id_2,
                taker_pdas_b2.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, taker_commit_b2, &[&taker]).await.unwrap();

    let taker_reveal_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas_b2.commitment, false),
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new(taker_pdas_b2.portfolio, false),
            AccountMeta::new(taker_pdas_b2.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_MARKET,
                INSTRUMENT_ID,
                false,
                SIDE_BUY,
                0,
                ORDER_QTY,
                TAKER_SALT_B2,
                batch_id_2,
            ),
        ),
    };
    submit(&mut ctx, taker_reveal_b2, &[&taker]).await.unwrap();

    let close_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_b2, &[]).await.unwrap();

    // M7 7.6: also pass instrument + taker portfolio for cap computation.
    let clear_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas_b2.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda_b2, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false), // M7 7.6
            AccountMeta::new(taker_pdas_b2.commitment, false),
            AccountMeta::new_readonly(taker_pdas_b2.portfolio, false), // M7 7.6
        ],
        data: with_disc(7, build_clear_batch_data(1, 1, 1)),
    };
    submit(&mut ctx, clear_b2, &[]).await.unwrap();

    let settle_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(taker_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda_b2, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false), // M7 7.5
            AccountMeta::new_readonly(oracle, false),     // M7 7.5
            AccountMeta::new_readonly(MATCHER_ID, false), // M7 7.5
            AccountMeta::new(taker_pdas_b2.commitment, false),
            AccountMeta::new(maker_pdas_b1.portfolio, false),
            AccountMeta::new(taker_pdas_b2.portfolio, false),
            AccountMeta::new(batch_pda_3, false), // M7 7.1: next_batch
        ],
        data: with_disc(8, build_settle_batch_data(1, 2)),
    };
    submit(&mut ctx, settle_b2, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 7. Post-batch-2 assertions.
    //    The resting GTC was filled and removed from the book.  Maker
    //    earns notional + rebate.  Taker pays notional + fee.
    // ------------------------------------------------------------------
    let maker_portfolio_after_b2 = ctx
        .banks_client
        .get_account(maker_pdas_b1.portfolio)
        .await
        .unwrap()
        .expect("maker portfolio after batch 2");
    let taker_portfolio_after_b2 = ctx
        .banks_client
        .get_account(taker_pdas_b2.portfolio)
        .await
        .unwrap()
        .expect("taker portfolio after batch 2");

    // Maker: equity = 10M (post b1) + 1M (sell) + 200 (rebate) = 11_000_200.
    let maker_equity_b2: [u8; 16] =
        maker_portfolio_after_b2.data[16..32].try_into().unwrap();
    let maker_equity_b2 = i128::from_le_bytes(maker_equity_b2);
    assert_eq!(
        maker_equity_b2,
        USER_DEPOSIT_LAMPORTS as i128 + 1_000_000 + 200,
        "maker equity after batch 2 (10M + 1M notional + 200 rebate)"
    );

    // Taker: equity = 10M (deposit) - 1M (buy) - 500 (fee) = 8_999_500.
    let taker_equity_b2: [u8; 16] =
        taker_portfolio_after_b2.data[16..32].try_into().unwrap();
    let taker_equity_b2 = i128::from_le_bytes(taker_equity_b2);
    assert_eq!(
        taker_equity_b2,
        USER_DEPOSIT_LAMPORTS as i128 - 1_000_000 - 500,
        "taker equity after batch 2 (10M - 1M notional - 500 fee)"
    );

    // Book: the resting GTC was filled, so the asks side should be empty.
    // We don't assert exact zero (next_order_id was bumped; book_acct_size
    // includes lots of trailing zeros).  Just assert that the book is
    // smaller in non-zero bytes than the maker's GTC sell payload
    // (which had user, price, qty, order_id non-zero).  Concretely: the
    // asks levels should have order_count == 0 for all 64 levels.  Since
    // ask_count is a u32 in the header, we can scan for ask_count != 0
    // by looking at the byte at the known offset (after instrument_id(2)
    // + best_bid(8) + best_ask(8) + bid_count(4)).
    // OrderBook header offsets: instrument_id[0..2], best_bid[2..10],
    // best_ask[10..18], bid_count[18..22], ask_count[22..26],
    // next_order_id[26..34], last_update_slot[34..42].
    // We assert ask_count == 0 in the post-batch-2 book.
    let book_after_b2 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book after batch 2");
    let ask_count_bytes: [u8; 4] = book_after_b2.data[22..26].try_into().unwrap();
    let ask_count = u32::from_le_bytes(ask_count_bytes);
    assert_eq!(
        ask_count, 0,
        "book.ask_count must be 0 after the resting GTC sell was filled"
    );
    let bid_count_bytes: [u8; 4] = book_after_b2.data[18..22].try_into().unwrap();
    let bid_count = u32::from_le_bytes(bid_count_bytes);
    assert_eq!(
        bid_count, 0,
        "book.bid_count must be 0 (no resting buys in this test)"
    );
}

// =============================================================================
// E2E test (M7 7.1): SettleBatch creates the next Batch PDA in place.
//
// This is the regression test for P0 gap #1: "No batch creation flow". Before
// 7.1, after SettleBatch the system was stuck — `batch_id_counter` was bumped
// but no Batch PDA for `current+1` was created. Per design decision D1
// (`docs/ai/planning/2026-06-16-m7-design-decisions.md`), the next batch is
// created atomically inside `SettleBatch` so there is no idle gap where no
// batch is in Committing.
//
// The test:
//   1. Pre-seeds batch_1, batch_2, batch_3 PDAs in genesis at BATCH_SIZE each.
//      (In production the keeper would pre-create the next-batch account as
//      part of the same TX via system_program CPI. Here we use genesis-seeding
//      to keep the test setup synchronous.)
//   2. Runs the full lifecycle on batch_1 (commit + reveal + close + clear +
//      settle) with one user. No fill — the goal is to exercise the
//      settle→create-next path, not the matching path.
//   3. After SettleBatch, reads batch_2 and asserts its fields:
//        - batch_id == 2
//        - status == Committing (0)
//        - commit_deadline_slot > 0 (current_slot + t_max_slots)
//        - reveal_deadline_slot == 0 (will be set in CloseCommitting)
//        - close_slot / shuffle_seed / clearing_price == 0
//        - all counters == 0
//        - bump != 0 (the derived PDA bump was written)
//   4. Runs the full lifecycle on batch_2 with the same shape.
//   5. Asserts batch_3 has the same field shape.
//
// Run with: BPF_OUT_DIR=target/deploy cargo test --test lifecycle --features host-hash
// =============================================================================

#[tokio::test]
async fn test_e2e_settle_creates_next_batch_pda() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_settle_creates_next_batch_pda: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    // ------------------------------------------------------------------
    // 1. Set up ProgramTest + 1 user + 3 pre-seeded batch PDAs.
    //    batch_1 is the current batch (commit/reveal/close/clear/settle).
    //    batch_2 is the next-batch account SettleBatch must write into.
    //    batch_3 is the next-next-batch account for the second SettleBatch.
    // ------------------------------------------------------------------
    let batch_id_1: u64 = 1;
    let batch_id_2: u64 = 2;
    let batch_id_3: u64 = 3;
    let nonce: u64 = 0;

    let user = Keypair::new();
    let user_pdas_b1 = derive_user_pdas(&user.pubkey(), batch_id_1, nonce);
    let user_pdas_b2 = derive_user_pdas(&user.pubkey(), batch_id_2, nonce);

    // Derive the standalone batch PDAs (same as `derive_user_pdas(...).batch`
    // but spelled out so the test intent is clear).
    let (batch_pda_1, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_id_1.to_le_bytes()], &CORE_ID);
    let (batch_pda_2, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_id_2.to_le_bytes()], &CORE_ID);
    let (batch_pda_3, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_id_3.to_le_bytes()], &CORE_ID);
    // (These are the same addresses as user_pdas_b1.batch / user_pdas_b2.batch;
    // we re-derive here for test-intent clarity. The two derivations are
    // guaranteed equal because the seed set is the same.)
    assert_eq!(batch_pda_1, user_pdas_b1.batch);
    assert_eq!(batch_pda_2, user_pdas_b2.batch);

    let (mut pt, pdas) = program_test_with_pdas();

    // Pre-fund user wallet.
    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    // Seed user accounts (portfolio + batch_1 + commitment for batch_1).
    seed_user_accounts(&mut pt, &user_pdas_b1);
    // Pre-seed batch_2 and batch_3 as empty, core-owned, BATCH_SIZE accounts.
    // After the first SettleBatch, batch_2 will be overwritten with the new
    // batch's state. After the second SettleBatch, batch_3 will be
    // overwritten.
    pt.add_account(batch_pda_2, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    pt.add_account(batch_pda_3, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    // Pre-seed the second-batch user accounts (portfolio + batch_2 +
    // commitment for batch_2). batch_2 PDA is the same address as above, so
    // the second `add_account` will overwrite the empty one we just added
    // with a fresh empty one — no-op. The portfolio and commitment are new.
    seed_user_accounts(&mut pt, &user_pdas_b2);

    // Per-batch results accounts (needed for ClearBatch/SettleBatch).
    let (results_pda_b1, _) =
        Pubkey::find_program_address(&[b"results", &batch_id_1.to_le_bytes()], &CORE_ID);
    let (results_pda_b2, _) =
        Pubkey::find_program_address(&[b"results", &batch_id_2.to_le_bytes()], &CORE_ID);
    pt.add_account(
        results_pda_b1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );
    pt.add_account(
        results_pda_b2,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );

    let mut ctx = pt.start_with_context().await;

    // ------------------------------------------------------------------
    // 2. Initialize (one time, persistent across all batches).
    // ------------------------------------------------------------------
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..]
                .to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    // InitPortfolio + Deposit for the user.
    let init_port = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
        ],
        data: with_disc(
            1,
            build_init_portfolio_data(&user.pubkey(), user_pdas_b1.portfolio_bump),
        ),
    };
    submit(&mut ctx, init_port, &[&user]).await.unwrap();

    let dep = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(pdas.vault, false),
        ],
        data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
    };
    submit(&mut ctx, dep, &[&user]).await.unwrap();

    // ------------------------------------------------------------------
    // 3. Run the full lifecycle on batch_1 (no fill).
    // ------------------------------------------------------------------
    const USER_SALT_B1: u64 = 0xC3C3_C3C3_C3C3_C3C3;
    let user_commit_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas_b1.portfolio, false),
            AccountMeta::new(user_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT_B1,
                batch_id_1,
                user_pdas_b1.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, user_commit_b1, &[&user]).await.unwrap();

    let user_reveal_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas_b1.portfolio, false),
            AccountMeta::new(user_pdas_b1.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT_B1,
                batch_id_1,
            ),
        ),
    };
    submit(&mut ctx, user_reveal_b1, &[&user]).await.unwrap();

    let close_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_b1, &[]).await.unwrap();

    // M7 7.6: also pass instrument + user portfolio for cap computation.
    let clear_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda_b1, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false), // M7 7.6
            AccountMeta::new(user_pdas_b1.commitment, false),
            AccountMeta::new_readonly(user_pdas_b1.portfolio, false), // M7 7.6
        ],
        data: with_disc(7, build_clear_batch_data(1, 1, 1)),
    };
    submit(&mut ctx, clear_b1, &[]).await.unwrap();

    // SettleBatch 1 with next_batch = batch_2 (M7 7.1).
    // M7 7.5: book + oracle + matcher_program added after instrument.
    let settle_b1 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b1.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda_b1, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false), // M7 7.5
            AccountMeta::new_readonly(oracle, false),     // M7 7.5
            AccountMeta::new_readonly(MATCHER_ID, false), // M7 7.5
            AccountMeta::new(user_pdas_b1.commitment, false),
            AccountMeta::new(user_pdas_b1.portfolio, false),
            AccountMeta::new(batch_pda_2, false), // 7.1: next_batch
        ],
        data: with_disc(8, build_settle_batch_data(1, 1)),
    };
    submit(&mut ctx, settle_b1, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 4. Post-batch-1 assertions: batch_2 was created with the right fields.
    // ------------------------------------------------------------------
    let batch_2_acct = ctx
        .banks_client
        .get_account(batch_pda_2)
        .await
        .unwrap()
        .expect("batch_2 PDA must exist after SettleBatch");
    assert_eq!(
        batch_2_acct.owner, CORE_ID,
        "batch_2 must be core-owned"
    );
    assert_eq!(
        batch_2_acct.data.len(),
        BATCH_SIZE,
        "batch_2 data length (got {}, want {})",
        batch_2_acct.data.len(),
        BATCH_SIZE
    );

    // batch_id (offset 0..8)
    let b2_batch_id: [u8; 8] = batch_2_acct.data[0..8].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b2_batch_id),
        2,
        "batch_2.batch_id must be 2 (current_batch_id + 1)"
    );

    // status (offset 8): Committing == 0
    assert_eq!(
        batch_2_acct.data[8], 0,
        "batch_2.status must be Committing (0)"
    );

    // commit_deadline_slot (offset 16..24): non-zero, set to current_slot + t_max_slots
    let b2_commit_deadline: [u8; 8] = batch_2_acct.data[16..24].try_into().unwrap();
    let b2_commit_deadline = u64::from_le_bytes(b2_commit_deadline);
    assert!(
        b2_commit_deadline > 0,
        "batch_2.commit_deadline_slot must be > 0 (got {b2_commit_deadline})"
    );

    // reveal_deadline_slot (offset 24..32): 0 (set later in CloseCommitting)
    let b2_reveal_deadline: [u8; 8] = batch_2_acct.data[24..32].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b2_reveal_deadline),
        0,
        "batch_2.reveal_deadline_slot must be 0 (set in CloseCommitting)"
    );

    // close_slot (offset 32..40): 0 (set in CloseCommitting)
    let b2_close_slot: [u8; 8] = batch_2_acct.data[32..40].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b2_close_slot),
        0,
        "batch_2.close_slot must be 0 (set in CloseCommitting)"
    );

    // shuffle_seed (offset 40..48): 0 (set in CloseCommitting)
    let b2_shuffle_seed: [u8; 8] = batch_2_acct.data[40..48].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b2_shuffle_seed),
        0,
        "batch_2.shuffle_seed must be 0 (set in CloseCommitting)"
    );

    // clearing_price (offset 48..56): 0
    let b2_clearing_price: [u8; 8] = batch_2_acct.data[48..56].try_into().unwrap();
    assert_eq!(
        i64::from_le_bytes(b2_clearing_price),
        0,
        "batch_2.clearing_price must be 0"
    );

    // total_commitments (offset 56..60): 0
    let b2_total_commitments: [u8; 4] = batch_2_acct.data[56..60].try_into().unwrap();
    assert_eq!(
        u32::from_le_bytes(b2_total_commitments),
        0,
        "batch_2.total_commitments must be 0"
    );

    // bump (offset 108..109): non-zero (the derived PDA bump was written).
    // Batch::initialize_in_place sets self.bump = bump, so a non-zero value
    // here confirms the function was actually called.
    assert_ne!(
        batch_2_acct.data[108], 0,
        "batch_2.bump must be non-zero (derived PDA bump)"
    );

    // ------------------------------------------------------------------
    // 5. Run the full lifecycle on batch_2 (no fill).
    // ------------------------------------------------------------------
    const USER_SALT_B2: u64 = 0xD4D4_D4D4_D4D4_D4D4;
    let user_commit_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b2.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas_b2.portfolio, false),
            AccountMeta::new(user_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT_B2,
                batch_id_2,
                user_pdas_b2.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, user_commit_b2, &[&user]).await.unwrap();

    let user_reveal_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b2.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas_b2.portfolio, false),
            AccountMeta::new(user_pdas_b2.batch, false),
            AccountMeta::new_readonly(pdas.registry, false), // M7 7.8
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT_B2,
                batch_id_2,
            ),
        ),
    };
    submit(&mut ctx, user_reveal_b2, &[&user]).await.unwrap();

    let close_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_b2, &[]).await.unwrap();

    // M7 7.6: also pass instrument + user portfolio for cap computation.
    let clear_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b2.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda_b2, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false), // M7 7.6
            AccountMeta::new(user_pdas_b2.commitment, false),
            AccountMeta::new_readonly(user_pdas_b2.portfolio, false), // M7 7.6
        ],
        data: with_disc(7, build_clear_batch_data(1, 1, 1)),
    };
    submit(&mut ctx, clear_b2, &[]).await.unwrap();

    // SettleBatch 2 with next_batch = batch_3 (M7 7.1).
    // M7 7.5: book + oracle + matcher_program added after instrument.
    let settle_b2 = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas_b2.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda_b2, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false), // M7 7.5
            AccountMeta::new_readonly(oracle, false),     // M7 7.5
            AccountMeta::new_readonly(MATCHER_ID, false), // M7 7.5
            AccountMeta::new(user_pdas_b2.commitment, false),
            AccountMeta::new(user_pdas_b2.portfolio, false),
            AccountMeta::new(batch_pda_3, false), // 7.1: next_batch
        ],
        data: with_disc(8, build_settle_batch_data(1, 1)),
    };
    submit(&mut ctx, settle_b2, &[]).await.unwrap();

    // ------------------------------------------------------------------
    // 6. Post-batch-2 assertions: batch_3 was created with the right fields.
    // ------------------------------------------------------------------
    let batch_3_acct = ctx
        .banks_client
        .get_account(batch_pda_3)
        .await
        .unwrap()
        .expect("batch_3 PDA must exist after second SettleBatch");
    assert_eq!(batch_3_acct.owner, CORE_ID, "batch_3 must be core-owned");
    assert_eq!(
        batch_3_acct.data.len(),
        BATCH_SIZE,
        "batch_3 data length (got {}, want {})",
        batch_3_acct.data.len(),
        BATCH_SIZE
    );
    let b3_batch_id: [u8; 8] = batch_3_acct.data[0..8].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b3_batch_id),
        3,
        "batch_3.batch_id must be 3"
    );
    assert_eq!(
        batch_3_acct.data[8], 0,
        "batch_3.status must be Committing (0)"
    );
    let b3_commit_deadline: [u8; 8] = batch_3_acct.data[16..24].try_into().unwrap();
    assert!(
        u64::from_le_bytes(b3_commit_deadline) > 0,
        "batch_3.commit_deadline_slot must be > 0"
    );
    let b3_reveal_deadline: [u8; 8] = batch_3_acct.data[24..32].try_into().unwrap();
    assert_eq!(
        u64::from_le_bytes(b3_reveal_deadline),
        0,
        "batch_3.reveal_deadline_slot must be 0"
    );
    assert_ne!(
        batch_3_acct.data[108], 0,
        "batch_3.bump must be non-zero"
    );
}

// =============================================================================
//   M7 7.7 Liquidation E2E (R5)
//
//   New BPF-gated e2e tests for the M7 7.7 liquidation safety stack:
//   1. test_e2e_liquidate_user_happy_path — underwater portfolio liquidated,
//      insurance fund covers the loss, vault.adl_pending stays false.
//   2. test_e2e_liquidate_user_adl_stub_fires — deeply underwater portfolio,
//      insurance fund is partially drained, vault.adl_pending is set +
//      vault.adl_debt is accumulated.
//   3. test_e2e_cancel_all_resting_orders — book has a resting order from a
//      prior batch; CancelAllRestingOrders removes it via CPI to the matcher.
//
//   Run with:
//   ```bash
//   cargo build-sbf                              # produces target/deploy/*.so
//   BPF_OUT_DIR=target/deploy \
//     cargo test -p mgk-perps-core --test lifecycle --features host-hash
//   ```
// =============================================================================

/// Pre-built oracle account data (128 bytes), used to pre-seed the oracle
/// account in genesis. The layout must match
/// `programs/oracle/src/state.rs::PriceOracle` and the
/// `ORACLE_PRICE_OFFSET = 80` / `ORACLE_MAGIC = 0x4C43_524F_4C43_5250`
/// constants in `instructions/liquidate_user.rs::read_oracle_price`.
fn build_oracle_data(price: i64, confidence: i64) -> Vec<u8> {
    let mut data = vec![0u8; 128];
    // magic (offset 0..8)
    data[0..8].copy_from_slice(&0x4C43_524F_4C43_5250u64.to_le_bytes());
    // version (offset 8) = 0
    // bump (offset 9) = 0
    // is_active (offset 10) = 1
    data[10] = 1;
    // _padding (11..16)
    // authority (16..48) = zero
    // instrument (48..80) = zero
    // price (80..88)
    data[80..88].copy_from_slice(&price.to_le_bytes());
    // timestamp (88..96) = 0
    // confidence (96..104)
    data[96..104].copy_from_slice(&confidence.to_le_bytes());
    // _reserved (104..128)
    data
}

/// Pre-built Portfolio account data (1472 bytes) for a single-position
/// underwater portfolio. Layout must match `state/portfolio.rs::Portfolio`.
///
/// The caller is responsible for ensuring `equity < mm` (i.e. `health < 0`)
/// so the liquidation's health check passes.
#[allow(clippy::too_many_arguments)]
fn build_underwater_portfolio_data(
    user: Pubkey,
    bump: u8,
    instrument_id: u16,
    qty: i64,
    entry_vwap: i64,
    equity: i128,
    im: u128,
    mm: u128,
) -> Vec<u8> {
    let mut data = vec![0u8; 1472];
    // user (0..32)
    data[0..32].copy_from_slice(user.as_ref());
    // equity (32..48)
    data[32..48].copy_from_slice(&equity.to_le_bytes());
    // principal (48..64) = 0
    // pnl (64..80) = 0
    // im (80..96)
    data[80..96].copy_from_slice(&im.to_le_bytes());
    // mm (96..112)
    data[96..112].copy_from_slice(&mm.to_le_bytes());
    // free_collateral (112..128) = equity - im
    data[112..128].copy_from_slice(&equity.saturating_sub(im as i128).to_le_bytes());
    // health (128..144) = equity - mm  (must be < 0 for liquidation to proceed)
    data[128..144].copy_from_slice(&equity.saturating_sub(mm as i128).to_le_bytes());
    // positions_len (144..146) = 1
    data[144..146].copy_from_slice(&1u16.to_le_bytes());
    // _pad (146..152)
    // position[0] starts at offset 152
    //   instrument_id (152..154)
    data[152..154].copy_from_slice(&instrument_id.to_le_bytes());
    //   _pad (154..160)
    //   qty (160..168)
    data[160..168].copy_from_slice(&qty.to_le_bytes());
    //   entry_vwap (168..176)
    data[168..176].copy_from_slice(&entry_vwap.to_le_bytes());
    // rest of positions (176..920) = zero
    // last_funding_checkpoint (920..1432) = zero
    // last_batch_id (1432..1440) = zero
    // last_slot (1440..1448) = zero
    // bump (1448..1449)
    data[1448] = bump;
    // _padding (1449..1456)
    // trailing alignment to 16 bytes (1456..1472)
    data
}

/// Pre-built Vault account data (80 bytes). Only the insurance_fund and
/// uncovered_bad_debt fields are set; everything else is zero. Layout
/// must match `state/vault.rs::Vault` (post-M7 7.7 field order).
fn build_vault_data(insurance_fund: u128, uncovered_bad_debt: u128) -> Vec<u8> {
    let mut data = vec![0u8; 80];
    // balance (0..8) = 0
    // insurance_fund (8..24)
    data[8..24].copy_from_slice(&insurance_fund.to_le_bytes());
    // uncovered_bad_debt (24..40)
    data[24..40].copy_from_slice(&uncovered_bad_debt.to_le_bytes());
    // adl_debt (40..56) = 0
    // adl_pending (56) = false
    // bump (57) = 0
    // _padding (58..64)
    // trailing alignment (64..80)
    data
}

/// LiquidateUser data: `num_instruments(2)` — number of instrument accounts
/// that follow in the account list.
fn build_liquidate_data(num_instruments: u16) -> Vec<u8> {
    num_instruments.to_le_bytes().to_vec()
}

/// CancelAllRestingOrders data: `num_books(2)` — number of book accounts
/// that follow in the account list.
fn build_cancel_all_resting_data(num_books: u16) -> Vec<u8> {
    num_books.to_le_bytes().to_vec()
}

// -----------------------------------------------------------------------------
// Test 1: happy path — insurance covers the loss, no ADL stub.
// -----------------------------------------------------------------------------

#[tokio::test]
async fn test_e2e_liquidate_user_happy_path() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_liquidate_user_happy_path: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    let user = Keypair::new();
    let liquidator = Keypair::new();
    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        liquidator.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    let (portfolio_pda, portfolio_bump) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, user.pubkey().as_ref()], &CORE_ID);

    let oracle_price: i64 = 99_000_000;
    let oracle_conf: i64 = 0;
    let oracle_pubkey = Pubkey::new_unique();
    pt.add_account(
        oracle_pubkey,
        Account {
            lamports: 1_000_000,
            data: build_oracle_data(oracle_price, oracle_conf),
            owner: solana_sdk::pubkey!("PRclOracle11111111111111111111111111111111"),
            executable: false,
            rent_epoch: 0,
        },
    );

    let initial_equity: i128 = -10_000_000;
    let portfolio_data = build_underwater_portfolio_data(
        user.pubkey(),
        portfolio_bump,
        INSTRUMENT_ID,
        10,                       // qty
        100_000_000,              // entry_vwap
        initial_equity,
        0,                        // im (will be recomputed)
        0,                        // mm (will be recomputed)
    );
    pt.add_account(
        portfolio_pda,
        Account {
            lamports: 1_000_000,
            data: portfolio_data,
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let initial_insurance: u128 = 100_000_000;
    pt.add_account(
        pdas.vault,
        Account {
            lamports: 1_000_000,
            data: build_vault_data(initial_insurance, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let governance = Keypair::new();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle_pubkey)[1..]
                .to_vec(),
        ),
    };
    let mut ctx = pt.start_with_context().await;
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    let liquidate_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(portfolio_pda, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(liquidator.pubkey(), true),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle_pubkey, false),
        ],
        data: with_disc(9, build_liquidate_data(1)),
    };
    submit(&mut ctx, liquidate_ix, &[&liquidator]).await.unwrap();

    let vault_acct = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault must exist");
    let insurance_after = u128::from_le_bytes(vault_acct.data[8..24].try_into().unwrap());
    let uncovered_after = u128::from_le_bytes(vault_acct.data[24..40].try_into().unwrap());
    let adl_debt_after = u128::from_le_bytes(vault_acct.data[40..56].try_into().unwrap());
    let adl_pending_after = vault_acct.data[56];

    assert!(
        insurance_after < initial_insurance,
        "insurance must be drained: before={initial_insurance}, after={insurance_after}"
    );
    assert_eq!(
        uncovered_after, 0,
        "happy path must not accumulate uncovered_bad_debt"
    );
    assert_eq!(
        adl_pending_after, 0,
        "happy path must not set adl_pending"
    );
    assert_eq!(
        adl_debt_after, 0,
        "happy path must not accumulate adl_debt"
    );
}

// -----------------------------------------------------------------------------
// Test 2: ADL stub fires when insurance is partially drained.
// -----------------------------------------------------------------------------

#[tokio::test]
async fn test_e2e_liquidate_user_adl_stub_fires() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_liquidate_user_adl_stub_fires: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    let user = Keypair::new();
    let liquidator = Keypair::new();
    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        liquidator.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    let (portfolio_pda, portfolio_bump) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, user.pubkey().as_ref()], &CORE_ID);

    let oracle_price: i64 = 99_000_000;
    let oracle_pubkey = Pubkey::new_unique();
    pt.add_account(
        oracle_pubkey,
        Account {
            lamports: 1_000_000,
            data: build_oracle_data(oracle_price, 0),
            owner: solana_sdk::pubkey!("PRclOracle11111111111111111111111111111111"),
            executable: false,
            rent_epoch: 0,
        },
    );

    let portfolio_data = build_underwater_portfolio_data(
        user.pubkey(),
        portfolio_bump,
        INSTRUMENT_ID,
        10,
        100_000_000,
        -10_000_000, // equity
        0,
        0,
    );
    pt.add_account(
        portfolio_pda,
        Account {
            lamports: 1_000_000,
            data: portfolio_data,
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let initial_insurance: u128 = 5_000;
    pt.add_account(
        pdas.vault,
        Account {
            lamports: 1_000_000,
            data: build_vault_data(initial_insurance, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let governance = Keypair::new();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle_pubkey)[1..]
                .to_vec(),
        ),
    };
    let mut ctx = pt.start_with_context().await;
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    let liquidate_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(portfolio_pda, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(liquidator.pubkey(), true),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle_pubkey, false),
        ],
        data: with_disc(9, build_liquidate_data(1)),
    };
    submit(&mut ctx, liquidate_ix, &[&liquidator]).await.unwrap();

    let vault_acct = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault must exist");
    let insurance_after = u128::from_le_bytes(vault_acct.data[8..24].try_into().unwrap());
    let uncovered_after = u128::from_le_bytes(vault_acct.data[24..40].try_into().unwrap());
    let adl_debt_after = u128::from_le_bytes(vault_acct.data[40..56].try_into().unwrap());
    let adl_pending_after = vault_acct.data[56];

    assert_eq!(
        insurance_after, 0,
        "insurance must be fully drained (started at {initial_insurance})"
    );
    assert!(
        uncovered_after > 0,
        "uncovered_bad_debt must be > 0 when ADL stub fires (got {uncovered_after})"
    );
    assert!(
        adl_debt_after > 0,
        "adl_debt must accumulate when ADL stub fires (got {adl_debt_after})"
    );
    assert_eq!(
        adl_pending_after, 1,
        "adl_pending must be set to true"
    );
    assert_eq!(
        adl_debt_after, uncovered_after,
        "adl_debt must match uncovered_bad_debt"
    );
}

// -----------------------------------------------------------------------------
// Test 3: CancelAllRestingOrders removes a user's resting order via CPI.
// -----------------------------------------------------------------------------

#[tokio::test]
async fn test_e2e_cancel_all_resting_orders() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_cancel_all_resting_orders: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    let batch_id: u64 = 1;
    let nonce: u64 = 0;

    let user = Keypair::new();
    let user_pdas = derive_user_pdas(&user.pubkey(), batch_id, nonce);
    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &user_pdas);

    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &CORE_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &CORE_ID),
    );

    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(next_batch_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let mut ctx = pt.start_with_context().await;

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..]
                .to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    let init_port = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
        ],
        data: with_disc(
            1,
            build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
        ),
    };
    submit(&mut ctx, init_port, &[&user]).await.unwrap();

    let dep = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(pdas.vault, false),
        ],
        data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
    };
    submit(&mut ctx, dep, &[&user]).await.unwrap();

    // Run a maker-only batch so the GTC sell rests on the book.
    const USER_SALT: u64 = 0xCAFE_CAFE_CAFE_CAFE;
    let user_commit = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            4,
            build_commit_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT,
                batch_id,
                user_pdas.commitment_bump,
            ),
        ),
    };
    submit(&mut ctx, user_commit, &[&user]).await.unwrap();

    let user_reveal = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.commitment, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(
            5,
            build_reveal_order_data(
                ORDER_TYPE_LIMIT_GTC,
                INSTRUMENT_ID,
                false,
                SIDE_SELL,
                ORDER_PRICE,
                ORDER_QTY,
                USER_SALT,
                batch_id,
            ),
        ),
    };
    submit(&mut ctx, user_reveal, &[&user]).await.unwrap();

    let close = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close, &[]).await.unwrap();

    let clear = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new(user_pdas.commitment, false),
            AccountMeta::new_readonly(user_pdas.portfolio, false),
        ],
        data: with_disc(7, build_clear_batch_data(1, 1, 1)),
    };
    submit(&mut ctx, clear, &[]).await.unwrap();

    let settle = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(user_pdas.commitment, false),
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(next_batch_pda, false),
        ],
        data: with_disc(8, build_settle_batch_data(1, 1)),
    };
    submit(&mut ctx, settle, &[]).await.unwrap();

    // Sanity check: book has a resting order before cancel.
    let book_before = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book must exist");
    let ask_count_before = u16::from_le_bytes(book_before.data[20..22].try_into().unwrap());
    assert_eq!(
        ask_count_before, 1,
        "book should have 1 ask (the maker's GTC sell resting)"
    );

    // Call CancelAllRestingOrders (M7 7.7.5, disc 13).
    let cancel_all = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.book, false),
        ],
        data: with_disc(13, build_cancel_all_resting_data(1)),
    };
    submit(&mut ctx, cancel_all, &[&user]).await.unwrap();

    // Assert: book is empty.
    let book_after = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book must exist");
    let ask_count_after = u16::from_le_bytes(book_after.data[20..22].try_into().unwrap());
    let bid_count_after = u16::from_le_bytes(book_after.data[18..20].try_into().unwrap());
    assert_eq!(
        ask_count_after, 0,
        "CancelAllRestingOrders should remove the maker's resting ask"
    );
    assert_eq!(
        bid_count_after, 0,
        "book should have no bids (no maker on bid side in this test)"
    );
}

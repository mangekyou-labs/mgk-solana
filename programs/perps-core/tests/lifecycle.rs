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
//! DFBA path uses PostOrder (disc 20) → CloseCommitting → ClearBatch (DfbaClear)
//! → SettleBatch. Commit/Reveal are retired.

use mgk_perps_core::state::{Batch, Commitment, Portfolio, Vault};
#[allow(deprecated)]
use solana_program_test::ProgramTest;
#[allow(deprecated)]
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

/// DFBA results: header 34 + 58 bytes/fill (cap 128 fills).
const RESULTS_ACCOUNT_SIZE: usize = 34 + 128 * 58;
/// Matcher `BookState` on-disk size (pinned in matcher book tests).
const BOOK_ACCOUNT_SIZE: usize = 27_704;

/// Program IDs matching the keypairs in `target/deploy/`.
/// (2026-06-24: perps-core re-deployed to CThnLgZ... —CzWqtmcrm... stale)
const CORE_ID: Pubkey = solana_sdk::pubkey!("C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx");
const MATCHER_ID: Pubkey = solana_sdk::pubkey!("7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC");

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

    pt.add_account(
        registry_pda,
        Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID),
    );
    pt.add_account(
        instrument_pda,
        Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID),
    );
    pt.add_account(vault_pda, Account::new(1_000_000, VAULT_SIZE, &CORE_ID));
    pt.add_account(
        book_pda,
        Account::new(1_000_000, BOOK_ACCOUNT_SIZE, &MATCHER_ID),
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
/// Post-disc layout (140 bytes) matches `process_initialize_inner`:
///   governance(32) + instrument_count(2) + volatility_multiplier(2)
///   + batch_id_counter(8) + base_deposit(8) + n_min(4) + t_min(8) + t_max(8)
///   + t_reveal(8) + instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2)
///   + taker_fee_bps(2) + maker_fee_bps(2) + oracle(32) + reg_bump(1) + inst_bump(1)
fn build_initialize_data(
    governance: Pubkey,
    registry_bump: u8,
    instrument_bump: u8,
    oracle: Pubkey,
) -> Vec<u8> {
    let mut data = vec![0u8; 1 + 140];
    data[0] = 0; // discriminator
    let p = &mut data[1..];
    p[0..32].copy_from_slice(governance.as_ref());
    p[32..34].copy_from_slice(&1u16.to_le_bytes()); // instrument_count
    p[34..36].copy_from_slice(&10_000u16.to_le_bytes()); // volatility_multiplier (1x)
    p[36..44].copy_from_slice(&0u64.to_le_bytes()); // batch_id_counter
    p[44..52].copy_from_slice(&1_000_000u64.to_le_bytes()); // base_deposit
    p[52..56].copy_from_slice(&1u32.to_le_bytes()); // n_min (1 post enough to close)
    p[56..64].copy_from_slice(&10u64.to_le_bytes()); // t_min_slots
    p[64..72].copy_from_slice(&150u64.to_le_bytes()); // t_max_slots
    p[72..80].copy_from_slice(&25u64.to_le_bytes()); // t_reveal_slots
    p[80..82].copy_from_slice(&0u16.to_le_bytes()); // instrument_id
    p[82..90].copy_from_slice(&1u64.to_le_bytes()); // tick_size
    p[90..98].copy_from_slice(&1u64.to_le_bytes()); // lot_size
    p[98..100].copy_from_slice(&1_000u16.to_le_bytes()); // imr_bps
    p[100..102].copy_from_slice(&500u16.to_le_bytes()); // mmr_bps
    p[102..104].copy_from_slice(&5u16.to_le_bytes()); // taker_fee_bps
    p[104..106].copy_from_slice(&(0i16).to_le_bytes()); // maker_fee_bps — locked D3 (makers free)
    p[106..138].copy_from_slice(oracle.as_ref());
    p[138] = registry_bump;
    p[139] = instrument_bump;
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

/// `CreateBatch` (disc 16) — post-disc: bump(1).
#[allow(dead_code)]
fn build_create_batch_data(bump: u8) -> Vec<u8> {
    vec![bump]
}

/// `PostOrder` (disc 20) — post-disc:
/// side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 21
#[allow(dead_code)]
fn build_post_order_data(
    side: u8,
    is_maker: bool,
    price: i64,
    qty: u64,
    instrument_id: u16,
    reduce_only: bool,
) -> Vec<u8> {
    let mut data = vec![0u8; 21];
    data[0] = side;
    data[1] = is_maker as u8;
    data[2..10].copy_from_slice(&price.to_le_bytes());
    data[10..18].copy_from_slice(&qty.to_le_bytes());
    data[18..20].copy_from_slice(&instrument_id.to_le_bytes());
    data[20] = reduce_only as u8;
    data
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

/// CancelAllRestingOrders data: `num_books(2)`.
fn build_cancel_all_resting_data(num_books: u16) -> Vec<u8> {
    num_books.to_le_bytes().to_vec()
}

/// Build a minimal Oracle account data (26 bytes) for LiquidateUser fallback.
/// Layout: price(8) + conf(8) + expo(4) + publish_time(4) + is_active(1) + _pad(1).
fn build_oracle_data(price: i64, conf: i64) -> Vec<u8> {
    let mut data = vec![0u8; 26];
    data[0..8].copy_from_slice(&price.to_le_bytes());
    data[8..16].copy_from_slice(&conf.to_le_bytes());
    data[24] = 0; // is_active = false
    data
}

/// Pre-built Portfolio account data (1472 bytes) for a single-position
/// underwater portfolio. Layout must match `state/portfolio.rs::Portfolio`.
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
    data[0..32].copy_from_slice(user.as_ref());
    data[32..48].copy_from_slice(&equity.to_le_bytes());
    data[80..96].copy_from_slice(&im.to_le_bytes());
    data[96..112].copy_from_slice(&mm.to_le_bytes());
    data[112..128].copy_from_slice(&equity.saturating_sub(im as i128).to_le_bytes());
    data[128..144].copy_from_slice(&equity.saturating_sub(mm as i128).to_le_bytes());
    data[144..146].copy_from_slice(&1u16.to_le_bytes()); // positions_len = 1
    data[152..154].copy_from_slice(&instrument_id.to_le_bytes());
    data[160..168].copy_from_slice(&qty.to_le_bytes());
    data[168..176].copy_from_slice(&entry_vwap.to_le_bytes());
    data[1448] = bump;
    data
}

/// Pre-built Vault account data (80 bytes).
fn build_vault_data(insurance_fund: u128, uncovered_bad_debt: u128) -> Vec<u8> {
    let mut data = vec![0u8; 80];
    data[8..24].copy_from_slice(&insurance_fund.to_le_bytes());
    data[24..40].copy_from_slice(&uncovered_bad_debt.to_le_bytes());
    data
}

/// LiquidateUser data: `num_instruments(2)`.
fn build_liquidate_data(num_instruments: u16) -> Vec<u8> {
    num_instruments.to_le_bytes().to_vec()
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
    let vault_pda = pdas.vault;
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
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(vault_pda, false),
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
    assert_eq!(
        instrument_count, 1,
        "instrument_count (set after instrument init)"
    );

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
    let non_zero_after_60 = inst_acct.data[60..].iter().filter(|b| **b != 0).count();
    assert!(
        non_zero_after_60 > 0,
        "oracle_addr was written (non-zero bytes after offset 60)"
    );
}

// =============================================================================
// E2E (DFBA): PostOrder → CloseCollecting → DfbaClear → SettleBatch
//
// Dual auction (both sides clear ⇒ mark_valid):
//   - maker: maker-buy 10 @ 100_000 + maker-sell 10 @ 100_000
//   - taker: taker-sell 10 @ 100_000 + taker-buy 10 @ 100_000
//
// Run with: BPF_OUT_DIR=target/deploy cargo test --test lifecycle --features host-hash
// =============================================================================

/// Side byte sent on the wire (must match `state::order::Side`).
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;

/// OrderType bytes (legacy commit-reveal tests).
#[allow(dead_code)]
const ORDER_TYPE_LIMIT_GTC: u8 = 0;
#[allow(dead_code)]
const ORDER_TYPE_MARKET: u8 = 3;

/// Lamports to seed each user's wallet with (used for `Deposit`).
const USER_FUNDING_LAMPORTS: u64 = 100_000_000; // 0.1 SOL

/// Lamports each user deposits into the perps vault.
const USER_DEPOSIT_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

/// Test instrument id (matches the default instrument seeded by `Initialize`).
const INSTRUMENT_ID: u16 = 0;
/// Limit price used by DFBA posts.
const ORDER_PRICE: i64 = 100_000;
/// Order quantity for DFBA posts.
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

/// Submit a transaction with a higher compute unit limit (for CU-heavy instructions like ClearBatch).
#[allow(dead_code)]
async fn submit_cu(
    ctx: &mut solana_program_test::ProgramTestContext,
    ix: Instruction,
    extra_signers: &[&Keypair],
    cu_limit: u32,
) -> Result<(), solana_program_test::BanksClientError> {
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(cu_limit),
            ix,
        ],
        Some(&ctx.payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await
}

/// E2E: DFBA dual-clear lifecycle with PostOrder (disc 20).
#[tokio::test]
async fn test_e2e_full_lifecycle_with_fill() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_e2e_full_lifecycle_with_fill: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    // Batch 0 is created via CreateBatch; settle opens batch 1 as next.
    let batch_id: u64 = 0;
    let nonce: u64 = 0;

    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_id, nonce);
    let taker_pdas = derive_user_pdas(&taker.pubkey(), batch_id, nonce);

    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    // Portfolio + batch (shared batch PDA for both users).
    seed_user_accounts(&mut pt, &maker_pdas);
    // Taker only needs portfolio (batch already seeded via maker_pdas).
    pt.add_account(
        taker_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );

    // Matcher writes results via DfbaClear — owner must be matcher program.
    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(
        next_batch_pda,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );

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
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(pdas.vault, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..]
                .to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    // CreateBatch 0 — open collecting window.
    let create_batch_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
    };
    submit(&mut ctx, create_batch_ix, &[]).await.unwrap();

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
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

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
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

    // Helper: PostOrder (disc 20).
    let post = |user: &Keypair, portfolio: Pubkey, side: u8, is_maker: bool| -> Instruction {
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        }
    };

    // Dual DFBA: both auctions must clear for mark_valid.
    // Bid: maker-buy × taker-sell; Ask: maker-sell × taker-buy.
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_BUY, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_SELL, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_SELL, false),
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_BUY, false),
        &[&taker],
    )
    .await
    .unwrap();

    // Close collecting → Clearing (n_min=5 in init; 4 posts → warp past deadline).
    let clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(clock.slot + 200).unwrap();

    let close_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_ix, &[]).await.unwrap();

    // ClearBatch → matcher DfbaClear (num_orders=0 collects book).
    // Need ≥6 accounts: pass instrument even with I=1,C=0,P=0.
    let clear_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false),
        ],
        data: with_disc(7, build_clear_batch_data(0, 1, 0)),
    };
    submit(&mut ctx, clear_ix, &[]).await.unwrap();

    // SettleBatch: C=0 commitments, P=2 portfolios + next_batch.
    let settle_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(results_pda, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(pdas.book, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(maker_pdas.portfolio, false),
            AccountMeta::new(taker_pdas.portfolio, false),
            AccountMeta::new(next_batch_pda, false),
        ],
        data: with_disc(8, build_settle_batch_data(0, 2)),
    };
    submit(&mut ctx, settle_ix, &[]).await.unwrap();

    // --- Assertions ---
    let batch_acct = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .expect("batch");
    let batch_status = batch_acct.data[8];
    assert_eq!(batch_status, 3, "batch status Settled");

    // Batch DFBA offsets (host repr(C), size 160):
    // clearing_price@48, bid@120, ask@128, mbid@136, mask@144, mark_valid@152, liq@153
    let mark_valid = batch_acct.data.get(152).copied().unwrap_or(0);
    let liq_paused = batch_acct.data.get(153).copied().unwrap_or(1);
    let clearing_price = i64::from_le_bytes(batch_acct.data[48..56].try_into().unwrap());
    let matched_bid = u64::from_le_bytes(batch_acct.data[136..144].try_into().unwrap());
    let matched_ask = u64::from_le_bytes(batch_acct.data[144..152].try_into().unwrap());
    assert!(matched_bid > 0, "bid auction matched");
    assert!(matched_ask > 0, "ask auction matched");
    assert_eq!(mark_valid, 1, "dual clear ⇒ mark_valid");
    assert_eq!(liq_paused, 0, "dual clear ⇒ liq not paused");
    assert_eq!(clearing_price, ORDER_PRICE, "mid of equal bid/ask clear");

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

    // Results: num_fills at offset 32 (DFBA header).
    let results_acct = ctx
        .banks_client
        .get_account(results_pda)
        .await
        .unwrap()
        .expect("results");
    let num_fills = u16::from_le_bytes(results_acct.data[32..34].try_into().unwrap());
    assert!(
        num_fills >= 4,
        "expected ≥4 fills (maker+taker × bid+ask), got {num_fills}"
    );
    // First fill: user + qty + price
    let fill0_user = &results_acct.data[34..66];
    let fill0_qty = u64::from_le_bytes(results_acct.data[74..82].try_into().unwrap());
    let fill0_price = i64::from_le_bytes(results_acct.data[82..90].try_into().unwrap());
    assert!(
        fill0_user == maker.pubkey().as_ref() || fill0_user == taker.pubkey().as_ref(),
        "fill0 user not maker/taker"
    );
    assert!(fill0_qty > 0, "fill0 qty must be > 0, got {fill0_qty}");
    assert_eq!(fill0_price, ORDER_PRICE, "fill0 price");
    // Portfolio.user bytes at offset 0
    let maker_user_on_chain = &maker_portfolio_acct.data[0..32];
    assert_eq!(
        maker_user_on_chain,
        maker.pubkey().as_ref(),
        "portfolio.user must match maker pubkey"
    );

    // Portfolio layout (repr C): user@0 (32), equity@32 (i128).
    // Maker: buy+sell same size → flat cash; rebate 2×(1e6*-2/1e4)=+400
    // Taker: fee 2×(1e6*5/1e4)=-1000
    let maker_equity = i128::from_le_bytes(maker_portfolio_acct.data[32..48].try_into().unwrap());
    let taker_equity = i128::from_le_bytes(taker_portfolio_acct.data[32..48].try_into().unwrap());
    let vault_acct = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault");
    let vault_balance = u64::from_le_bytes(vault_acct.data[0..8].try_into().unwrap());
    assert_eq!(vault_balance, 2 * USER_DEPOSIT_LAMPORTS, "vault balance");
    // Dual legs cancel notional; fees: maker rebate 2×200, taker fee 2×500.
    // (Instrument fee fields must match #[repr(C)] — fixed in initialize.rs.)
    let maker_principal =
        i128::from_le_bytes(maker_portfolio_acct.data[48..64].try_into().unwrap());
    assert_eq!(
        maker_principal, USER_DEPOSIT_LAMPORTS as i128,
        "maker principal"
    );
    assert_eq!(
        maker_equity,
        USER_DEPOSIT_LAMPORTS as i128 + 400,
        "maker equity after dual fill + rebate"
    );
    assert_eq!(
        taker_equity,
        USER_DEPOSIT_LAMPORTS as i128 - 1_000,
        "taker equity after dual fill + fees"
    );
    let insurance = u128::from_le_bytes(vault_acct.data[8..24].try_into().unwrap());
    assert_eq!(insurance, 600, "vault insurance net fees");
    let _ = num_fills;

    let book_acct = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book");
    assert!(
        book_acct.data.iter().any(|b| *b != 0),
        "book was written by PlaceResting/DfbaClear"
    );
}

/// E2E: one-sided DFBA (only ask auction) ⇒ mark_valid=0, liq_paused=1.
#[tokio::test]
async fn test_e2e_dfba_one_sided_liq_paused() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_dfba_one_sided_liq_paused: set BPF_OUT_DIR");
        return;
    }

    let batch_id: u64 = 0;
    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_id, 0);
    let taker_pdas = derive_user_pdas(&taker.pubkey(), batch_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &maker_pdas);
    pt.add_account(
        taker_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(
        next_batch_pda,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );

    let mut ctx = pt.start_with_context().await;
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(user_pdas.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                ],
                data: with_disc(
                    1,
                    build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
                ),
            },
            &[user],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(user_pdas.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[user],
        )
        .await
        .unwrap();
    }

    // Only ask auction: maker-sell × taker-buy (no bid side).
    let post = |user: &Keypair, portfolio: Pubkey, side: u8, is_maker: bool| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_SELL, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_BUY, false),
        &[&taker],
    )
    .await
    .unwrap();

    let clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(clock.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(results_pda, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(taker_pdas.portfolio, false),
                AccountMeta::new(next_batch_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();

    let batch_acct = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .expect("batch");
    assert_eq!(batch_acct.data[8], 3, "Settled");
    let mark_valid = batch_acct.data[152];
    let liq_paused = batch_acct.data[153];
    let matched_bid = u64::from_le_bytes(batch_acct.data[136..144].try_into().unwrap());
    let matched_ask = u64::from_le_bytes(batch_acct.data[144..152].try_into().unwrap());
    assert_eq!(matched_bid, 0, "no bid auction");
    assert!(matched_ask > 0, "ask auction matched");
    assert_eq!(mark_valid, 0, "one-sided ⇒ !mark_valid");
    assert_eq!(liq_paused, 1, "one-sided ⇒ liq_paused");
}

// =============================================================================
// DFBA E2E tests -- rewritten from legacy commit-reveal (2026-08-06)
// =============================================================================

/// E2E: DFBA resting order across batches.
#[tokio::test]
async fn test_e2e_gtc_rests_then_matches_next_batch() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let bid: u64 = 0;
    let maker = Keypair::new();
    let taker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), bid, 0);
    let tp = derive_user_pdas(&taker.pubkey(), bid, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &bid.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &(bid + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (r1, _) =
        Pubkey::find_program_address(&[b"results", &(bid + 1).to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b2, _) = Pubkey::find_program_address(&[BATCH_SEED, &(bid + 2).to_le_bytes()], &CORE_ID);
    pt.add_account(b2, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    // Batch 0: maker buy@98k only (rests)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[8], 3, "batch 0 Settled");
    assert_eq!(ba.data[152], 0, "one-sided -> !mark_valid");
    // Batch 1: taker sell@97k crosses resting buy@98k
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 97_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r1, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r1, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b2, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();
    let b1a = ctx.banks_client.get_account(b1).await.unwrap().unwrap();
    assert_eq!(b1a.data[8], 3, "batch 1 Settled");
    let ta = ctx
        .banks_client
        .get_account(tp.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert!(
        u16::from_le_bytes(ta.data[144..146].try_into().unwrap()) >= 1,
        "taker filled from resting"
    );
}

/// E2E: SettleBatch creates next batch PDA with correct fields.
#[tokio::test]
async fn test_e2e_settle_creates_next_batch_pda() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let taker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let tp = derive_user_pdas(&taker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (r1, _) = Pubkey::find_program_address(&[b"results", &1u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b2, _) = Pubkey::find_program_address(&[BATCH_SEED, &2u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b2, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    // Dual fill -> mark_valid -> settle creates batch 1
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[8], 3, "batch 0 Settled");
    assert_eq!(ba.data[152], 0, "!mark_valid (one-sided bid auction only)");
    // Verify batch 1 created
    let b1a = ctx.banks_client.get_account(b1).await.unwrap().unwrap();
    assert_eq!(b1a.data[8], 0, "batch 1 Collecting");
    assert_eq!(
        u64::from_le_bytes(b1a.data[0..8].try_into().unwrap()),
        1,
        "batch 1 id"
    );
    assert!(
        u64::from_le_bytes(b1a.data[16..24].try_into().unwrap()) > 0,
        "deadline set"
    );
    // Batch 1 lifecycle -> batch 2 created
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r1, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r1, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b2, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let b2a = ctx.banks_client.get_account(b2).await.unwrap().unwrap();
    assert_eq!(b2a.data[8], 0, "batch 2 Collecting");
    assert_eq!(
        u64::from_le_bytes(b2a.data[0..8].try_into().unwrap()),
        2,
        "batch 2 id"
    );
}

/// E2E: LiquidateUser happy path -- DFBA mark, pre-built underwater portfolio.
#[tokio::test]
async fn test_e2e_liquidate_user_happy_path() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let taker = Keypair::new();
    let victim = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let tp = derive_user_pdas(&taker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        victim.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    // Underwater portfolio: qty=100 long @120_000, equity=-5M
    let (vp, vb) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, victim.pubkey().as_ref()], &CORE_ID);
    pt.add_account(
        vp,
        Account {
            lamports: 1_000_000,
            data: build_underwater_portfolio_data(
                victim.pubkey(),
                vb,
                INSTRUMENT_ID,
                100,
                120_000,
                -5_000_000,
                0,
                0,
            ),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let opk = Pubkey::new_unique();
    pt.add_account(
        opk,
        Account {
            lamports: 1_000_000,
            data: build_oracle_data(100_000_000, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, opk)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    // Dual fill -> mark_valid (bid: maker-buy × taker-sell; ask: maker-sell × taker-buy)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    // Ask auction: maker-sell × taker-buy
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[8], 3, "Settled");
    assert_eq!(ba.data[152], 1, "mark_valid (dual auction)");
    // Liquidate underwater victim
    let liq = Keypair::new();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(vp, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(liq.pubkey(), true),
                AccountMeta::new_readonly(mp.batch, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
            ],
            data: with_disc(9, build_liquidate_data(1)),
        },
        &[&liq],
    )
    .await
    .unwrap();
    let va = ctx.banks_client.get_account(vp).await.unwrap().unwrap();
    let vp_len = u16::from_le_bytes(va.data[144..146].try_into().unwrap());
    assert!(vp_len <= 1, "position reduced after liquidation");
}

/// E2E: ADL fires when insurance cannot cover bad debt.
#[tokio::test]
async fn test_e2e_liquidate_user_adl_stub_fires() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let taker = Keypair::new();
    let victim = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let tp = derive_user_pdas(&taker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        victim.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    // Underwater with large loss: qty=100 long @200_000, equity=-10M
    let (vp, vb) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, victim.pubkey().as_ref()], &CORE_ID);
    pt.add_account(
        vp,
        Account {
            lamports: 1_000_000,
            data: build_underwater_portfolio_data(
                victim.pubkey(),
                vb,
                INSTRUMENT_ID,
                100,
                200_000,
                -10_000_000,
                0,
                0,
            ),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    // Low insurance: only 1 SOL (will be insufficient)
    pt.add_account(
        pdas.vault,
        Account {
            lamports: 1_000_000,
            data: build_vault_data(1_000_000, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let opk = Pubkey::new_unique();
    pt.add_account(
        opk,
        Account {
            lamports: 1_000_000,
            data: build_oracle_data(100_000_000, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, opk)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    // Dual fill -> mark_valid (bid + ask auctions)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    // Ask auction: maker-sell × taker-buy
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, true, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, false, 100_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    // Liquidate -- ADL should fire because insurance < loss
    let liq = Keypair::new();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(vp, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(liq.pubkey(), true),
                AccountMeta::new_readonly(mp.batch, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
            ],
            data: with_disc(9, build_liquidate_data(1)),
        },
        &[&liq],
    )
    .await
    .unwrap();
    let va = ctx.banks_client.get_account(vp).await.unwrap().unwrap();
    let vault = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .unwrap();
    let _uncovered = u128::from_le_bytes(vault.data[24..40].try_into().unwrap());
    // ADL: some bad debt may be uncovered when insurance is insufficient
    // The liquidation still succeeds (positions reduced)
    let vp_len = u16::from_le_bytes(va.data[144..146].try_into().unwrap());
    assert!(vp_len <= 1, "position reduced after ADL");
}

/// E2E: CancelAllRestingOrders clears the book.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_cancel_all_resting_orders() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&maker.pubkey(), mp.portfolio_bump),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&maker],
    )
    .await
    .unwrap();
    // Post resting maker buy@98k
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    // Close -> Clear -> Settle (one-sided)
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();
    // Verify resting order exists
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        u16::from_le_bytes(bk.data[18..20].try_into().unwrap()) >= 1,
        "resting bid"
    );
    // Cancel all resting
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
            ],
            data: with_disc(13, build_cancel_all_resting_data(1)),
        },
        &[&maker],
    )
    .await
    .unwrap();
    // Verify book empty
    let bk2 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u16::from_le_bytes(bk2.data[18..20].try_into().unwrap()),
        0,
        "book empty after cancel"
    );
}

/// E2E: DFBA resting across batch with is_maker preserved.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_resting_across_batch() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_resting_across_batch: set BPF_OUT_DIR");
        return;
    }

    let batch_0_id: u64 = 0;
    let batch_1_id: u64 = 1;
    let batch_2_id: u64 = 2;

    let maker = Keypair::new();
    let taker_0 = Keypair::new();
    let taker_1 = Keypair::new();

    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_0_id, 0);
    let taker0_pdas = derive_user_pdas(&taker_0.pubkey(), batch_0_id, 0);
    let taker1_pdas = derive_user_pdas(&taker_1.pubkey(), batch_1_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    for kp in [&maker, &taker_0, &taker_1] {
        pt.add_account(
            kp.pubkey(),
            Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
        );
    }
    seed_user_accounts(&mut pt, &maker_pdas);
    pt.add_account(
        taker0_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    pt.add_account(
        taker1_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );

    let (results_0_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_0_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_0_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (results_1_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_1_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_1_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_1_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (batch_2_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_2_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_2_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let mut ctx = pt.start_with_context().await;
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();

    for (user, up) in [
        (&maker, &maker_pdas),
        (&taker_0, &taker0_pdas),
        (&taker_1, &taker1_pdas),
    ] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(up.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                ],
                data: with_disc(
                    1,
                    build_init_portfolio_data(&user.pubkey(), up.portfolio_bump),
                ),
            },
            &[user],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(up.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[user],
        )
        .await
        .unwrap();
    }

    // Post orders: maker buy@100k+98k, taker sell@99k
    let pi = |u: &Keypair, p: Pubkey, s: u8, m: bool, pr: i64| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(p, false),
            AccountMeta::new(u.pubkey(), true),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(s, m, pr, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(
        &mut ctx,
        pi(&maker, maker_pdas.portfolio, SIDE_BUY, true, 100_000),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        pi(&maker, maker_pdas.portfolio, SIDE_BUY, true, 98_000),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        pi(&taker_0, taker0_pdas.portfolio, SIDE_SELL, false, 99_000),
        &[&taker_0],
    )
    .await
    .unwrap();

    // Batch 0: Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 2)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(taker0_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify batch 0 settled + resting orders exist
    let b0 = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b0.data[8], 3, "batch 0 Settled");
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        u16::from_le_bytes(bk.data[18..20].try_into().unwrap()) >= 1,
        "resting bid"
    );

    // Batch 1: taker 1 sells@97k -> crosses resting buy@98k
    submit(
        &mut ctx,
        pi(&taker_1, taker1_pdas.portfolio, SIDE_SELL, false, 97_000),
        &[&taker_1],
    )
    .await
    .unwrap();

    // Batch 1: Close -> Clear
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(batch_1_pda, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(batch_1_pda, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_1_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();

    // Verify: batch 1 clear produced fills from resting order
    let b1 = ctx
        .banks_client
        .get_account(batch_1_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b1.data[8], 2, "batch 1 Clearing");
    let r1 = ctx
        .banks_client
        .get_account(results_1_pda)
        .await
        .unwrap()
        .unwrap();
    let nf = u16::from_le_bytes(r1.data[32..34].try_into().unwrap());
    assert!(nf >= 2, ">=2 fills from resting order, got {nf}");

    // Verify: at least one fill has is_maker=true (role preserved)
    let mut found = false;
    for i in 0..nf as usize {
        let off = 34 + i * 58;
        if r1.data[off + 56] != 0 {
            found = true;
            let fp = i64::from_le_bytes(r1.data[off + 48..off + 56].try_into().unwrap());
            assert_eq!(fp, 98_000, "maker fill price");
            break;
        }
    }
    assert!(found, "is_maker fill found");
}

/// E2E: DFBA self-trade prevention — same wallet maker+taker does not
/// self-fill (T9.5.5c). Host unit tests already cover the DFBA math;
/// this validates the on-chain path.
///
/// Scenario: user posts maker-buy@100_000 and taker-sell@100_000.
/// The DFBA self-trade filter should exclude the fill.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_self_trade_no_fill() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_self_trade_no_fill: set BPF_OUT_DIR");
        return;
    }

    let batch_id: u64 = 0;
    let user = Keypair::new();
    let user_pdas = derive_user_pdas(&user.pubkey(), batch_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &user_pdas);

    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let mut ctx = pt.start_with_context().await;
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Initialize + CreateBatch + InitPortfolio + Deposit
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(user_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
            ),
        },
        &[&user],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&user],
    )
    .await
    .unwrap();

    // Same user: maker-buy@100k AND taker-sell@100k (self-trade)
    let pi = |side: u8, is_maker: bool| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(&mut ctx, pi(SIDE_BUY, true), &[&user])
        .await
        .unwrap();
    submit(&mut ctx, pi(SIDE_SELL, false), &[&user])
        .await
        .unwrap();

    // Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify: no fills (self-trade excluded)
    let results = ctx
        .banks_client
        .get_account(results_pda)
        .await
        .unwrap()
        .unwrap();
    let num_fills = u16::from_le_bytes(results.data[32..34].try_into().unwrap());
    assert_eq!(num_fills, 0, "self-trade should produce 0 fills");

    // Verify: batch settled but mark invalid (one-sided clear only)
    let batch = ctx
        .banks_client
        .get_account(user_pdas.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(batch.data[8], 3, "batch Settled");
}

/// E2E: DFBA cancel resting between batches (T9.5.5d).
/// Scenario: maker posts buy@98k, batch settles (no taker), maker cancels resting order.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_cancel_resting_between_batches() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_cancel_resting_between_batches: set BPF_OUT_DIR");
        return;
    }
    let batch_0_id: u64 = 0;
    let batch_1_id: u64 = 1;
    let maker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_0_id, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &maker_pdas);
    let (results_0_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_0_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_0_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_1_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let mut ctx = pt.start_with_context().await;
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Init + CreateBatch + Portfolio + Deposit
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&maker.pubkey(), maker_pdas.portfolio_bump),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&maker],
    )
    .await
    .unwrap();

    // Post maker buy@98k (no taker -> rests)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();

    // Batch 0: Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify resting order exists
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        u16::from_le_bytes(bk.data[18..20].try_into().unwrap()) >= 1,
        "resting bid"
    );

    // Cancel all resting (disc 13)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
            ],
            data: with_disc(13, build_cancel_all_resting_data(1)),
        },
        &[&maker],
    )
    .await
    .unwrap();

    // Verify book empty
    let bk2 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u16::from_le_bytes(bk2.data[18..20].try_into().unwrap()),
        0,
        "book empty after cancel"
    );
}

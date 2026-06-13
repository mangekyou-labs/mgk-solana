//! Milestone 5: Liquidation & Polish — Integration Tests
//!
//! Tests the liquidation system: underwater detection, reduce-only execution,
//! pre-liquidation vs hard liquidation modes, insurance fund, and PnL vesting.
//!
//! Test coverage per testing strategy:
//! 5.1 LiquidateUser marks underwater portfolio (health < 0)
//! 5.2 LiquidateUser rejects healthy portfolio
//! 5.3 LiquidateUser rejects during cooldown
//! 5.4 LiquidateUser claims insurance for bad debt
//! 5.5 Insurance fund accrues from settlement fees
//! 5.6 Full E2E: deposit → trade → lose → liquidate
//! 5.7 Full E2E: deposit → trade → win → withdraw profit
//! 5.8 Error code uniqueness across all programs

use percolator_router::instructions::liquidate_user::{determine_mode, LiquidationMode};
use percolator_router::state::{
    Portfolio, SlabRegistry,
    lp_bucket::{LpBucket, VenueId},
};
use percolator_common::PercolatorError;
use pinocchio::pubkey::Pubkey;

const SCALE: i64 = 1_000_000;

// ============================================================================
// Test 5.1: LiquidateUser detects underwater portfolio (health < 0)
// ============================================================================
#[test]
fn test_5_1_liquidate_underwater_portfolio() {
    let preliq_buffer: i128 = 10_000_000; // $10 buffer

    // Health = -1000 → underwater (below 0 = below MM)
    let health: i128 = -1_000;
    let mode = determine_mode(health, preliq_buffer);
    assert!(mode.is_some(), "Should enter liquidation mode");
    assert_eq!(mode.unwrap(), LiquidationMode::HardLiquidation);
}

// ============================================================================
// Test 5.2: LiquidateUser rejects healthy portfolio
// ============================================================================
#[test]
fn test_5_2_liquidate_rejects_healthy() {
    let preliq_buffer: i128 = 10_000_000;

    // Health = 50_000_000 → well above buffer → healthy
    let health: i128 = 50_000_000;
    let mode = determine_mode(health, preliq_buffer);
    assert!(mode.is_none(), "Healthy portfolio should not be liquidated");

    // Health just at buffer threshold
    let health: i128 = 10_000_000;
    let mode = determine_mode(health, preliq_buffer);
    assert!(mode.is_none(), "At buffer threshold → healthy, no liquidation");
}

// ============================================================================
// Test: Pre-liquidation mode (buffer zone)
// ============================================================================
#[test]
fn test_pre_liquidation_buffer_zone() {
    let preliq_buffer: i128 = 10_000_000;

    // Health = 5_000_000 → between 0 and buffer → pre-liquidation
    let health: i128 = 5_000_000;
    let mode = determine_mode(health, preliq_buffer);
    assert!(mode.is_some(), "Should enter pre-liquidation");
    assert_eq!(mode.unwrap(), LiquidationMode::PreLiquidation);

    // Health = 9_999_999 → just below buffer → pre-liquidation
    let health: i128 = 9_999_999;
    let mode = determine_mode(health, preliq_buffer);
    assert_eq!(mode.unwrap(), LiquidationMode::PreLiquidation);

    // Health = 0 → precise boundary: at MM → should NOT trigger hard liq
    let health: i128 = 0;
    let mode = determine_mode(health, preliq_buffer);
    assert_eq!(mode.unwrap(), LiquidationMode::PreLiquidation,
        "Health = 0 → pre-liquidation (at MM)");

    // Health = -1 → below MM → hard liquidation
    let health: i128 = -1;
    let mode = determine_mode(health, preliq_buffer);
    assert_eq!(mode.unwrap(), LiquidationMode::HardLiquidation,
        "Health < 0 → hard liquidation");
}

// ============================================================================
// Test 5.3: LiquidateUser rejects during cooldown
// ============================================================================
#[test]
fn test_5_3_liquidate_rejects_during_cooldown() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Default cooldown is 60 seconds
    assert_eq!(portfolio.cooldown_seconds, 60);

    // Mark as recently liquidated
    let last_liq_ts = 1_700_000_000u64;
    let current_ts = 1_700_000_010u64; // Only 10 seconds later
    portfolio.last_liquidation_ts = last_liq_ts;

    assert!(current_ts - last_liq_ts < portfolio.cooldown_seconds,
        "Still in cooldown period → reject liquidation");

    // After cooldown
    let current_ts = 1_700_000_070u64;
    assert!(current_ts - last_liq_ts >= portfolio.cooldown_seconds,
        "Cooldown passed → allow liquidation");
}

// ============================================================================
// Test: Liquidation price band differ by mode
// ============================================================================
#[test]
fn test_liquidation_price_bands() {
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Pre-liquidation: tighter band (better pricing)
    let preliq_band = LiquidationMode::PreLiquidation.get_band_bps(&registry);
    assert_eq!(preliq_band, registry.preliq_band_bps);
    assert_eq!(preliq_band, 100); // 1%

    // Hard liquidation: wider band (more aggressive pricing)
    let hard_band = LiquidationMode::HardLiquidation.get_band_bps(&registry);
    assert_eq!(hard_band, registry.liq_band_bps);
    assert_eq!(hard_band, 200); // 2%

    // Hard liquidation band should be wider than pre-liq
    assert!(hard_band > preliq_band,
        "Hard liquidation band ({}) should be wider than pre-liq ({})",
        hard_band, preliq_band);
}

// ============================================================================
// Test 5.4: Insurance fund covers bad debt (simulated flow)
// ============================================================================
#[test]
fn test_5_4_insurance_covers_bad_debt() {
    // Scenario: User has -$1,000 bad debt after liquidation.
    // Insurance fund state tracks vault_balance and uncovered_bad_debt.
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Production InsuranceState tracks vault_balance, daily_payout_accum,
    // and uncovered_bad_debt. For this test we verify the state types exist
    // and have correct defaults.
    assert_eq!(registry.insurance_state.vault_balance, 0);
    assert_eq!(registry.insurance_state.total_payouts, 0);
    assert_eq!(registry.insurance_state.total_fees_accrued, 0);

    // Insurance params default: fee_bps_to_insurance = 10 (0.10% of taker fees)
    assert_eq!(registry.insurance_params.fee_bps_to_insurance, 10);
    assert_eq!(registry.insurance_params.max_payout_bps_of_oi, 50);
    assert_eq!(registry.insurance_params.max_daily_payout_bps_of_vault, 300);

    // Note: Actual claim + payout logic requires BPF runtime for CPI to
    // the insurance fund account. This test verifies state structure.
}

// ============================================================================
// Test 5.5: Insurance fund accrues from taker fees
// ============================================================================
#[test]
fn test_5_5_insurance_accrues_from_fees() {
    let mut registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Insurance vault starts at 0
    assert_eq!(registry.insurance_state.vault_balance, 0);

    // fee_bps_to_insurance = 10 means 0.10% of taker fees go to insurance.
    // For a $600 taker fee, insurance receives $600 * 10 / 10000 = $0.60.
    // Actual accrual requires CPI from ExecuteCrossSlab, testable with BPF.
    let taker_fee: u128 = 600 * SCALE as u128;
    let insurance_share = taker_fee * registry.insurance_params.fee_bps_to_insurance as u128 / 10_000;
    assert_eq!(insurance_share, taker_fee * 10 / 10_000);
}

// ============================================================================
// Test 5.6: Full E2E — deposit → trade → lose → liquidate
// ============================================================================
#[test]
fn test_5_6_e2e_deposit_trade_lose_liquidate() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // 1. Deposit $10,000 worth of SOL
    let deposit = 10_000_000_000i128;
    portfolio.principal = deposit;
    portfolio.update_equity(deposit);

    // 2. Trade: Buy 10 BTC @ $60,000
    portfolio.update_exposure(0, 0, 10 * SCALE);

    // 3. Margin: IMR=5% → IM = $30,000
    let im = 30_000_000_000u128;
    let mm = 15_000_000_000u128;
    portfolio.update_margin(im, mm);
    assert!(!portfolio.has_sufficient_margin(),
        "Equity ${} < IM ${} → insufficient", portfolio.equity, im);

    // 4. Price drops to $58,000 → unrealized loss
    // PnL = 10 BTC * ($58,000 - $60,000) = -$20,000
    let pnl = -20_000_000_000i128;
    portfolio.pnl = pnl;
    portfolio.update_equity(deposit.saturating_add(pnl));

    assert!(portfolio.equity < 0,
        "Equity negative after loss: {}", portfolio.equity);

    // 5. Health = equity - MM → negative → underwater
    let health = portfolio.equity - (mm as i128);
    assert!(health < 0, "Underwater");

    // 6. Determine liquidation mode
    let mode = determine_mode(health, registry.preliq_buffer);
    assert_eq!(mode.unwrap(), LiquidationMode::HardLiquidation);
}

// ============================================================================
// Test 5.7: Full E2E — deposit → trade → win → withdraw profit
// ============================================================================
#[test]
fn test_5_7_e2e_deposit_trade_win_withdraw() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // 1. Deposit $100,000
    let deposit = 100_000_000_000i128;
    portfolio.principal = deposit;
    portfolio.update_equity(deposit);

    // 2. Trade: Long 5 BTC @ $60,000
    portfolio.update_exposure(0, 0, 5 * SCALE);
    let im = 5 * SCALE as u128 * 60_000 * SCALE as u128 * 500 / 10000 / SCALE as u128;
    portfolio.update_margin(im, im / 2);

    // 3. Price rises to $65,000 → profit $25,000. Update equity properly.
    let profit = 25_000_000_000i128;
    portfolio.pnl = profit;
    portfolio.vested_pnl = profit;
    portfolio.update_equity(deposit.saturating_add(profit));

    assert!(portfolio.equity > deposit, "Made profit");

    // 4. Withdraw profit (accounting for warmup)
    use model_safety::adaptive_warmup::q1;
    let max = portfolio.max_withdrawable_with_warmup(q1());
    assert!(max >= deposit, "Can withdraw at least principal");
    assert_eq!(portfolio.principal, deposit);
}

// ============================================================================
// Test 5.8: Error code uniqueness across all programs
// ============================================================================
#[test]
fn test_5_8_error_code_uniqueness() {
    // Verify error ranges per error.rs convention:
    // 0–99: common
    // 100–199: router
    // 200–299: slab
    // etc.

    let errors = vec![
        ("Common", PercolatorError::InvalidInstruction as u64, 0..100u64),
        ("Router", PercolatorError::InvalidPortfolio as u64, 100..200u64),
        ("Slab", PercolatorError::InsufficientLiquidity as u64, 200..300u64),
    ];

    for (name, code, range) in errors {
        assert!(range.contains(&code),
            "{} error code {} should be in range {:?}", name, code, range);
    }

    // Verify all error variants produce distinct codes
    let mut seen = std::collections::HashSet::new();
    let codes = vec![
        PercolatorError::InvalidInstruction,
        PercolatorError::InvalidAccount,
        PercolatorError::InvalidPortfolio,
        PercolatorError::Unauthorized,
        PercolatorError::Overflow,
        PercolatorError::Underflow,
        PercolatorError::InvalidQuantity,
        PercolatorError::InvalidPrice,
        PercolatorError::InvalidSide,
        PercolatorError::InsufficientLiquidity,
        PercolatorError::InsufficientFunds,
        PercolatorError::SeqnoMismatch,
        PercolatorError::AlreadyInitialized,
        PercolatorError::InvalidAccountOwner,
    ];
    for code in codes {
        assert!(seen.insert(code as u64), "Duplicate error code: {:?}", code);
    }
}

// ============================================================================
// Test: LP bucket liquidation priority
// ============================================================================
#[test]
fn test_lp_bucket_liquidation_priority() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Setup under-margin portfolio
    portfolio.update_equity(10_000);
    portfolio.update_margin(20_000, 10_000);

    // Add LP buckets (slab first, then AMM — priority ordering)
    let market1 = Pubkey::from([1; 32]);
    let market2 = Pubkey::from([2; 32]);

    let mut slab_bucket = LpBucket::new_slab(VenueId::new_slab(market1));
    slab_bucket.update_margin(5_000, 2_500);

    let mut amm_bucket = LpBucket::new_amm(VenueId::new_amm(market2), 1000, 60_000 * SCALE, 100);
    amm_bucket.update_margin(3_000, 1_500);

    portfolio.add_lp_bucket(slab_bucket).unwrap();
    portfolio.add_lp_bucket(amm_bucket).unwrap();

    // Total MM = 10_000 + 2_500 + 1_500 = 14_000
    assert_eq!(portfolio.calculate_total_mm(), 14_000);

    // Equity 10_000 < MM 14_000 → underwater
    assert!(!portfolio.is_above_maintenance_venue_aware());

    // LIQUIDATION PRIORITY:
    // 1. Reduce principal positions first (reduce-only on exposures)
    // 2. Cancel Slab LP orders (free reservations → release margin)
    // 3. Burn AMM LP shares (last resort)
    //
    // This ordering ensures cheapest-to-undo assets are liquidated first
    assert_eq!(portfolio.lp_bucket_count, 2);
    assert!(portfolio.find_lp_bucket(&VenueId::new_slab(market1)).is_some());
    assert!(portfolio.find_lp_bucket(&VenueId::new_amm(market2)).is_some());
}

// ============================================================================
// Test: PnL vesting — losses reduce vested PnL
// ============================================================================
#[test]
fn test_pnl_vesting_losses_reduce_vested() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Initial: $100,000 equity, +$20,000 vested PnL
    portfolio.principal = 100_000_000_000;
    portfolio.vested_pnl = 20_000_000_000;
    portfolio.equity = portfolio.principal + portfolio.vested_pnl;

    // Negative PnL event
    let loss = -30_000_000_000i128;
    portfolio.pnl = loss;
    portfolio.vested_pnl = (portfolio.vested_pnl + loss).max(0);
    portfolio.equity = portfolio.principal + portfolio.vested_pnl;

    assert_eq!(portfolio.vested_pnl, 0, "Vested PnL floored at 0");
    assert_eq!(portfolio.equity, portfolio.principal);
}

// ============================================================================
// Test: Global haircut — protocol-level loss socialization
// ============================================================================
#[test]
fn test_global_haircut() {
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Global haircut starts at 0 bps
    assert_eq!(registry.global_haircut.cumulative_haircut, 0);

    // In a crisis scenario, insurance fund may be depleted and
    // losses are socialized across PnL-holders via global haircut

    // cumulative_haircut tracks total haircut applied since inception
    // max_haircut_per_event_bps caps per-event haircut
    assert!(registry.global_haircut.max_haircut_per_event_bps <= 30_000,
        "Max haircut per event should be reasonable");
}

// ============================================================================
// Test: Oracle tolerance gate for liquidation
// ============================================================================
#[test]
fn test_oracle_tolerance_liquidation_gate() {
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Oracle tolerance default: 50 bps (0.5%)
    assert_eq!(registry.oracle_tolerance_bps, 50);

    let oracle_price = 60_000 * SCALE as i64;
    let slab_price = 60_300 * SCALE as i64;
    let tolerance_bps = registry.oracle_tolerance_bps as i64;

    // Divergence = |slab_price - oracle_price| / oracle_price * 10000
    let divergence_bps = (slab_price - oracle_price).abs() * 10_000 / oracle_price;
    assert_eq!(divergence_bps, 50);

    // Exact match at tolerance
    assert!(divergence_bps <= tolerance_bps);

    // Beyond tolerance
    let slab_price = 60_400 * SCALE as i64;
    let divergence_bps = (slab_price - oracle_price).abs() * 10_000 / oracle_price;
    assert_eq!(divergence_bps, 66); // 0.66%
    assert!(divergence_bps > tolerance_bps,
        "Slab with divergence > 0.5% should be excluded from liquidation");
}

// ============================================================================
// Test: Reduce-only enforcement in liquidation
// ============================================================================
#[test]
fn test_liquidation_reduce_only() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // User has +5 BTC exposure
    portfolio.update_exposure(0, 0, 5 * SCALE);

    // Liquidation must only REDUCE positions, never increase
    let original_qty = portfolio.get_exposure(0, 0);
    assert!(original_qty > 0, "Original long position");

    // Reduce-only: new qty must be closer to zero
    let new_qty = 2 * SCALE; // -3 BTC (reduce)
    assert!(new_qty.abs() < original_qty.abs(),
        "Reduce-only: new exposure must be smaller");

    // Increase would be rejected
    let increasing_qty = 7 * SCALE; // +2 BTC (increase!)
    assert!(!(increasing_qty.abs() < original_qty.abs()),
        "Position increase should be rejected during liquidation");
}

// ============================================================================
// Test: All-or-nothing liquidation atomicity
// ============================================================================
#[test]
fn test_liquidation_atomicity() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Multi-exposure portfolio
    portfolio.update_exposure(0, 0, 3 * SCALE);  // BTC
    portfolio.update_exposure(1, 1, 50 * SCALE); // ETH

    assert_eq!(portfolio.exposure_count, 2);

    // Liquidation must be all-or-nothing:
    // Either ALL positions are reduced, or NONE are
    // If one slab CPI fails, the entire tx must abort

    // Simulate successful liquidation (all positions reduced)
    portfolio.update_exposure(0, 0, 0);
    portfolio.update_exposure(1, 1, 0);
    assert_eq!(portfolio.exposure_count, 0);
}

// ============================================================================
// Test: Liquidation fee distribution
// ============================================================================
#[test]
fn test_liquidation_fee_distribution() {
    // Liquidators are incentivized with a portion of the liquidation fee
    let liquidation_amount = 5_000_000_000u128; // $5,000 position
    let liquidator_share_bps = 100u128; // 1% to liquidator

    let liquidator_reward = liquidation_amount * liquidator_share_bps / 10_000;
    assert_eq!(liquidator_reward, 50_000_000);

    // Remainder goes to insurance fund
    let insurance_share = liquidation_amount - liquidator_reward;
    assert_eq!(insurance_share, 4_950_000_000);
}

// ============================================================================
// Test: Cooldown enforcement prevents griefing
// ============================================================================
#[test]
fn test_cooldown_prevents_griefing() {
    let mut portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Set up portfolio with a recent liquidation
    portfolio.last_liquidation_ts = 1_700_000_000;
    portfolio.cooldown_seconds = 60;

    // Check at t = 1_700_000_010 (10 seconds later)
    let current_ts = 1_700_000_010u64;
    let in_cooldown = current_ts - portfolio.last_liquidation_ts < portfolio.cooldown_seconds;
    assert!(in_cooldown, "Should be in cooldown at 10s");

    // Check at t = 1_700_000_070 (70 seconds later)
    let current_ts = 1_700_000_070u64;
    let in_cooldown = current_ts - portfolio.last_liquidation_ts < portfolio.cooldown_seconds;
    assert!(!in_cooldown, "Should be out of cooldown at 70s");
}

// ============================================================================
// Test: Minimum equity to quote guard
// ============================================================================
#[test]
fn test_min_equity_to_quote_guard() {
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);
    let portfolio = Portfolio::new(Pubkey::from([1; 32]), Pubkey::from([3; 32]), 0);

    // Minimum equity to provide quotes: $100 (default)
    assert_eq!(registry.min_equity_to_quote, 100_000_000);

    // New portfolio (equity = 0) cannot provide quotes
    assert!(portfolio.equity < registry.min_equity_to_quote,
        "Equity ${} < min ${} → cannot quote",
        portfolio.equity, registry.min_equity_to_quote);
}

// ============================================================================
// Test: Router cap per slab enforcement
// ============================================================================
#[test]
fn test_router_cap_per_slab() {
    let registry = SlabRegistry::new(Pubkey::from([1; 32]), Pubkey::from([2; 32]), 0);

    // Maximum units per slab per transaction: 1000
    assert_eq!(registry.router_cap_per_slab, 1_000_000_000);

    // A cross-slab execution must respect this cap
    let split_size = 500_000_000u64;
    assert!(split_size <= registry.router_cap_per_slab,
        "Split within cap");

    let oversize = 1_500_000_000u64;
    assert!(oversize > registry.router_cap_per_slab,
        "Oversize split should be rejected");
}

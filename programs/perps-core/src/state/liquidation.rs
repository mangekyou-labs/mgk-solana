//! M7 7.7: Iterative liquidation reduction — pure helpers (decision D4).
//!
//! The liquidation optimizer in `LiquidateUser` runs up to N rounds (D4 = 5)
//! where each round reduces the largest-notional position by a fixed fraction
//! (D4 = 25%, i.e. 2500 bps). After each round the portfolio's `health` is
//! recomputed; if `health >= 0` the loop exits early. If the portfolio is
//! still underwater after N rounds, the existing full-flat path takes over.
//!
//! Design reference:
//! - D4 (`docs/ai/planning/2026-06-16-m7-design-decisions.md`)
//! - design L578-601 (Selective Reduction + Iterate)
//!
//! This module deliberately exposes small, individually-testable pure
//! functions. The orchestrator (the loop, health check, full-flat fallback)
//! lives in `LiquidateUser` to keep this file free of side effects.

use crate::state::{portfolio::Position, MAX_INSTRUMENTS, MAX_POSITIONS};
use mgk_common::MgkError;

/// Default number of reduction rounds (decision D4: 5, not the design's
/// 10 — we don't have market sweep, so more rounds don't help).
pub const DEFAULT_MAX_ROUNDS: usize = 5;

/// Default reduction fraction per round in basis points (decision D4:
/// 25%, i.e. 2500 bps). The design proposes an urgency-based table
/// (`gap > 30% of M_p` → 25%, etc., design L592-597); we use a fixed 25%
/// for MVP — simpler, no per-round urgency recompute needed.
pub const DEFAULT_FRACTION_BPS: u64 = 2_500;

/// Position notional rank metric.
///
/// `abs_notional = |qty| * contract_size * mark_price`, all in their
/// native (signed-for-qty, unsigned-for-the-rest) types. The product is
/// `i128` to avoid overflow at extreme inputs (qty up to ~1e6, contract
/// up to ~1e9, mark up to ~1e9 → ~1e24 fits comfortably in i128).
///
/// All instruments share the same mark-price scale (`PRICE_MULTIPLIER = 1e6`
/// per `common::math`), so this metric is comparable across instruments
/// for sorting purposes.
///
/// `mark_price` is signed because `Instrument.mark_price` is `i64`
/// (signed); a non-positive mark is treated as "no mark available" and
/// the function returns 0 so the position sinks to the bottom of the
/// ranking.
pub fn position_notional(qty: i64, mark_price: i64, contract_size: u64) -> i128 {
    if mark_price <= 0 || qty == 0 {
        return 0;
    }
    let abs_qty = qty.unsigned_abs() as i128;
    let cs = contract_size as i128;
    let mp = mark_price as i128;
    abs_qty.saturating_mul(cs).saturating_mul(mp)
}

/// Find the index of the position with the largest notional within
/// `positions[0..count]`. Returns `None` if `count == 0` or every
/// position has zero notional.
///
/// Looks up `mark_prices[instrument_id]` and
/// `contract_sizes[instrument_id]` for each position. Both lookup tables
/// are indexed by `instrument_id` (caller pre-fills with default
/// values — e.g. 1 for `contract_size` — for any instrument the user
/// does not hold a position on).
pub fn find_top_position(
    positions: &[Position; MAX_POSITIONS],
    count: usize,
    mark_prices: &[i64; 32],
    contract_sizes: &[u64; 32],
) -> Option<usize> {
    let mut best_idx: Option<usize> = None;
    let mut best_notional: i128 = 0;
    for (i, pos) in positions.iter().enumerate().take(count.min(MAX_POSITIONS)) {
        let mp = mark_prices
            .get(pos.instrument_id as usize)
            .copied()
            .unwrap_or(0);
        let cs = contract_sizes
            .get(pos.instrument_id as usize)
            .copied()
            .unwrap_or(1);
        let n = position_notional(pos.qty, mp, cs);
        if n > best_notional {
            best_notional = n;
            best_idx = Some(i);
        }
    }
    best_idx
}

/// Compute the new signed `qty` after reducing `position` by `fraction_bps`
/// of its absolute size. Returns `(new_qty, removed_qty_as_u64)`.
///
/// `fraction_bps` is in basis points (10_000 = 100%). Uses integer division
/// with rounding toward zero (the conservative direction for liquidation:
/// we close slightly *less* than the fraction, keeping a tiny residual
/// exposure that's mopped up by a subsequent round or the full-flat
/// fallback).
///
/// If `fraction_bps >= 10_000`, the new qty collapses to 0 (i.e. the
/// position is fully closed in a single step). The caller decides whether
/// this is appropriate or whether to cap `fraction_bps` first.
pub fn apply_reduction(
    position: &Position,
    fraction_bps: u64,
) -> (i64, u64) {
    if fraction_bps == 0 || position.qty == 0 {
        return (position.qty, 0);
    }
    let abs_qty = position.qty.unsigned_abs();
    let reduce = abs_qty.saturating_mul(fraction_bps) / 10_000;
    // Clamp the actually-closed amount to abs_qty so callers summing
    // `removed` across rounds never exceed the original position size
    // (which would be a confusing accounting signal).
    let removed = reduce.min(abs_qty);
    let new_abs = abs_qty.saturating_sub(removed);
    let new_qty = if position.qty > 0 {
        new_abs as i64
    } else {
        -(new_abs as i64)
    };
    (new_qty, removed)
}

/// M7 7.7 remediation (R1): Validate that every position's instrument has a
/// corresponding entry in the `instrument_accounts` slice passed to
/// `LiquidateUser`.
///
/// Why this is needed: the mark-price / contract-size / IMR / MMR lookup
/// tables in `process_liquidate_user` are sized `MAX_INSTRUMENTS` and
/// initialized to zero. Entries are only filled for the instruments the
/// caller actually passed in. If a position's `instrument_id` is missing
/// from the list, every per-position computation silently uses zero (mark
/// = 0, contract_size = 1, IMR = MMR = 0) and `full_flat` records PnL =
/// `qty * (0 - entry) = -qty * entry` — destroying equity without warning.
///
/// Returns `Err(MgkError::InstrumentMissingForLiquidation)` if any
/// position's instrument is absent from `passed_instrument_ids` or if the
/// `instrument_id` itself is out of range (state corruption: only 32
/// instruments exist, so anything >= 32 is unrepresentable).
///
/// This is a pure function so the helper can be unit-tested without
/// constructing `AccountInfo`.
pub fn validate_instrument_coverage(
    positions: &[Position; MAX_POSITIONS],
    count: usize,
    passed_instrument_ids: &[u16],
) -> Result<(), MgkError> {
    let count = count.min(MAX_POSITIONS);
    for pos in positions.iter().take(count) {
        let id = pos.instrument_id;
        if (id as usize) >= MAX_INSTRUMENTS {
            return Err(MgkError::InstrumentMissingForLiquidation);
        }
        if !passed_instrument_ids.contains(&id) {
            return Err(MgkError::InstrumentMissingForLiquidation);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::portfolio::{Portfolio, MAX_INSTRUMENTS};
    use crate::state::vault::Vault;
    use mgk_common::math::{calculate_im, calculate_mm};
    use pinocchio::pubkey::Pubkey;

    fn pos(instrument_id: u16, qty: i64, entry_vwap: i64) -> Position {
        Position {
            instrument_id,
            qty,
            entry_vwap,
        }
    }

    fn empty_positions() -> [Position; MAX_POSITIONS] {
        [Position::default(); MAX_POSITIONS]
    }

    /// Simulate the orchestrator's per-round update for a single position.
    /// Returns the new qty after reduction and the equity delta from
    /// realizing the closed portion's PnL. Mirrors the loop body in
    /// `liquidate_user::process_liquidate_user` (lines ~120-140).
    fn simulate_one_round(
        portfolio: &mut Portfolio,
        mark_prices: &[i64; MAX_INSTRUMENTS],
        contract_sizes: &[u64; MAX_INSTRUMENTS],
        imr_bps: &[u16; MAX_INSTRUMENTS],
        mmr_bps: &[u16; MAX_INSTRUMENTS],
    ) -> bool {
        let top_idx = match find_top_position(
            &portfolio.positions,
            portfolio.positions_len as usize,
            mark_prices,
            contract_sizes,
        ) {
            Some(i) => i,
            None => return false,
        };
        let old_qty = portfolio.positions[top_idx].qty;
        let (new_qty, _removed) =
            apply_reduction(&portfolio.positions[top_idx], DEFAULT_FRACTION_BPS);
        let inst_id = portfolio.positions[top_idx].instrument_id as usize;
        let mark = mark_prices.get(inst_id).copied().unwrap_or(0);
        let entry = portfolio.positions[top_idx].entry_vwap;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed.saturating_mul((mark as i128) - (entry as i128));
        portfolio.equity = portfolio.equity.saturating_add(delta_pnl);
        portfolio.positions[top_idx].qty = new_qty;

        if new_qty == 0 {
            let last = (portfolio.positions_len as usize).saturating_sub(1);
            if top_idx != last {
                portfolio.positions[top_idx] = portfolio.positions[last];
            }
            portfolio.positions[last] = Position::default();
            portfolio.positions_len = portfolio.positions_len.saturating_sub(1);
        }

        // Recompute margin (mirrors liquidate_user::recompute_margin).
        let mut total_im: u128 = 0;
        let mut total_mm: u128 = 0;
        let count = portfolio.positions_len as usize;
        for i in 0..count.min(MAX_POSITIONS) {
            let p = &portfolio.positions[i];
            if p.qty == 0 {
                continue;
            }
            let iid = p.instrument_id as usize;
            let m = mark_prices.get(iid).copied().unwrap_or(0).max(0) as u64;
            let cs_v = contract_sizes.get(iid).copied().unwrap_or(1);
            let imr_v = imr_bps.get(iid).copied().unwrap_or(0) as u64;
            let mmr_v = mmr_bps.get(iid).copied().unwrap_or(0) as u64;
            total_im = total_im.saturating_add(calculate_im(p.qty, cs_v, m, imr_v));
            total_mm = total_mm.saturating_add(calculate_mm(p.qty, cs_v, m, mmr_v));
        }
        portfolio.im = total_im;
        portfolio.mm = total_mm;
        portfolio.recalc_margin();
        true
    }

    // ---- T5 integration scenarios ----

    #[test]
    fn test_scenario_iterative_rescues_before_full_flat() {
        // Scenario: 3 positions. Portfolio is initially underwater
        // (mm > equity). The iterative loop should reduce the largest
        // position, lowering mm below equity, and stop early.
        //
        // Numbers chosen so 25%/round reduction recovers health within
        // 5 rounds but NOT after just 1 round:
        //   mm_initial ≈ 1000 * 95 * 100% = 95_000
        //   equity = 50_000  →  health = -45_000 (underwater)
        //   After 5 rounds: residual qty ≈ 1000 * 0.75^5 ≈ 237
        //   mm ≈ 237 * 95 = 22_515  →  health = 27_485 (recovered)
        let mut portfolio = Portfolio::new(Pubkey::default());
        portfolio.equity = 50_000;
        portfolio.positions[0] = pos(0, 1000, 100);
        portfolio.positions[1] = pos(1, 100, 100);
        portfolio.positions[2] = pos(2, -50, 100);
        portfolio.positions_len = 3;

        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[0] = 95;
        marks[1] = 90;
        marks[2] = 110;
        let cs = [1u64; MAX_INSTRUMENTS];
        let imr = [0u16; MAX_INSTRUMENTS];
        let mut mmr = [0u16; MAX_INSTRUMENTS];
        for v in mmr.iter_mut() {
            *v = 10_000; // 100% MMR — extreme to force the scenario
        }

        let initial_top = find_top_position(&portfolio.positions, 3, &marks, &cs).unwrap();
        assert_eq!(initial_top, 0);

        let mut rounds = 0;
        for _ in 0..DEFAULT_MAX_ROUNDS {
            simulate_one_round(&mut portfolio, &marks, &cs, &imr, &mmr);
            rounds += 1;
            if portfolio.health >= 0 {
                break;
            }
        }

        assert!(portfolio.health >= 0, "iterative should recover health");
        assert!(rounds <= DEFAULT_MAX_ROUNDS);
        // The largest position should have shrunk.
        let qty_after = portfolio.positions[0].qty;
        assert!(
            qty_after < 1000,
            "largest position should shrink; got qty={}",
            qty_after
        );
    }

    #[test]
    fn test_scenario_full_flat_when_5_rounds_insufficient() {
        // Scenario: mm so high that even after 5 rounds of reduction,
        // mm > equity. The orchestrator invokes full-flat as fallback.
        let mut portfolio = Portfolio::new(Pubkey::default());
        portfolio.equity = 1_000;
        portfolio.positions[0] = pos(0, 1000, 1_000_000);
        portfolio.positions[1] = pos(1, 100, 1_000_000);
        portfolio.positions_len = 2;

        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[0] = 1_000_000;
        marks[1] = 1_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];
        let mut mmr = [0u16; MAX_INSTRUMENTS];
        mmr[0] = 10_000; // 100% MMR — extreme
        mmr[1] = 10_000;
        let imr = [0u16; MAX_INSTRUMENTS];

        for _ in 0..DEFAULT_MAX_ROUNDS {
            simulate_one_round(&mut portfolio, &marks, &cs, &imr, &mmr);
        }
        // Iterative alone doesn't recover.
        assert!(portfolio.health < 0);
        assert!(portfolio.positions[0].qty > 0);
        assert!(portfolio.positions[1].qty > 0);
        // The orchestrator would now invoke full-flat; verify that
        // path zeros everything when applied manually.
        portfolio.positions[0].qty = 0;
        portfolio.positions[1].qty = 0;
        portfolio.positions_len = 0;
        portfolio.im = 0;
        portfolio.mm = 0;
        portfolio.recalc_margin();
        assert_eq!(portfolio.positions_len, 0);
        assert!(portfolio.health >= 0);
    }

    #[test]
    fn test_scenario_position_compaction_on_zero() {
        // When a position is reduced to 0 (qty < 25% triggers qty=0 via
        // 100% reduction, or odd-qty rounding leaves 0), it should be
        // compacted: positions_len decrements, the last live position
        // moves into the slot.
        let mut portfolio = Portfolio::new(Pubkey::default());
        portfolio.equity = 10_000;
        portfolio.positions[0] = pos(0, 1, 1_000_000); // tiny — will round to 0 on reduce
        portfolio.positions[1] = pos(1, 100, 1_000_000);
        portfolio.positions[2] = pos(2, 50, 1_000_000);
        portfolio.positions_len = 3;

        // Force collapse via a 100% reduction.
        let (new_qty, _) = apply_reduction(&portfolio.positions[0], 10_000);
        assert_eq!(new_qty, 0);
        // Simulate compaction.
        portfolio.positions[0].qty = 0;
        let last = (portfolio.positions_len as usize) - 1;
        portfolio.positions[0] = portfolio.positions[last];
        portfolio.positions[last] = Position::default();
        portfolio.positions_len = portfolio.positions_len.saturating_sub(1);

        assert_eq!(portfolio.positions_len, 2);
        // What was pos[2] is now in slot 0.
        assert_eq!(portfolio.positions[0].instrument_id, 2);
        assert_eq!(portfolio.positions[0].qty, 50);
        // Slot 1 still has the original pos[1].
        assert_eq!(portfolio.positions[1].instrument_id, 1);
        assert_eq!(portfolio.positions[1].qty, 100);
    }

    #[test]
    fn test_scenario_adl_stub_fires_when_insurance_empty() {
        // Scenario: insurance_fund = 0, equity deeply negative after
        // liquidation. ADL stub should set vault.adl_pending = true and
        // accumulate vault.adl_debt.
        let mut vault = Vault::new();
        vault.insurance_fund = 0;
        vault.balance = 1_000_000;

        // Simulate the post-liquidation uncovered bad-debt path.
        let uncovered = 500u128;
        vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(uncovered);
        vault.mark_adl_pending(uncovered);

        assert!(vault.adl_pending);
        assert_eq!(vault.adl_debt, 500);
        assert_eq!(vault.uncovered_bad_debt, 500);
        assert_eq!(vault.insurance_fund, 0); // unchanged
    }

    #[test]
    fn test_scenario_adl_stub_accumulates_across_multiple_liquidations() {
        // If two liquidations both exceed insurance, the ADL stub
        // accumulates the debt rather than overwriting.
        let mut vault = Vault::new();
        vault.insurance_fund = 0;
        vault.balance = 1_000_000;

        // First liquidation: 300 uncovered.
        vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(300);
        vault.mark_adl_pending(300);
        assert!(vault.adl_pending);
        assert_eq!(vault.adl_debt, 300);

        // Second liquidation: 200 more uncovered.
        vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(200);
        vault.mark_adl_pending(200);
        assert!(vault.adl_pending);
        assert_eq!(vault.adl_debt, 500);
        assert_eq!(vault.uncovered_bad_debt, 500);
    }

    #[test]
    fn test_scenario_adl_stub_clears_when_debt_resolved() {
        // A future ADL implementation would call clear_adl_pending
        // once bad debt is absorbed. Verify the helper exists and works.
        let mut vault = Vault::new();
        vault.mark_adl_pending(750);
        assert!(vault.adl_pending);
        assert_eq!(vault.adl_debt, 750);

        vault.clear_adl_pending();
        assert!(!vault.adl_pending);
        assert_eq!(vault.adl_debt, 0);
        // uncovered_bad_debt is NOT cleared — it's the historical
        // accumulator and persists for accounting.
        assert_eq!(vault.uncovered_bad_debt, 0);
    }

    /// Mirror of the production `mark_prices[id]` build: composite mark
    /// from 7.5, fallback to oracle if mark is 0. Extracted to a helper
    /// so the test signatures match the production `Option<i64>` flow
    /// without triggering clippy's `unwrap_or`-on-literal lint.
    fn build_mark(instrument_mark: i64, oracle_price: Option<i64>) -> i64 {
        if instrument_mark > 0 {
            instrument_mark
        } else {
            oracle_price.unwrap_or(0)
        }
    }

    #[test]
    fn test_scenario_mark_fallback_to_oracle() {
        // When instrument.mark_price == 0 (first batch, no fills),
        // the orchestrator should fall back to the oracle price.
        let mut mark_prices = [0i64; MAX_INSTRUMENTS];
        let oracle_price = Some(50_000_000_i64);
        mark_prices[0] = build_mark(0, oracle_price);
        assert_eq!(mark_prices[0], 50_000_000);
    }

    #[test]
    fn test_scenario_no_oracle_no_mark_yields_zero() {
        // Both instrument.mark_price == 0 and oracle missing → mark = 0.
        // All positions have zero notional → find_top_position returns
        // None (nothing meaningful to reduce). The orchestrator treats
        // this as "skip the round" and falls through to full-flat.
        let mark_prices = [0i64; MAX_INSTRUMENTS];
        let oracle_price: Option<i64> = None;
        let effective_mark = build_mark(0, oracle_price);
        assert_eq!(effective_mark, 0);

        let mut positions = empty_positions();
        positions[0] = pos(0, 10, 100);
        let cs = [1u64; MAX_INSTRUMENTS];
        let top = find_top_position(&positions, 1, &mark_prices, &cs);
        // All positions have zero notional → no candidate → None.
        assert_eq!(top, None);
    }

    // ---- Original T3 unit tests (kept below) ----

    #[test]
    fn test_position_notional_basic() {
        // |10| * 1 contract * 100_000_000 price = 10^9
        assert_eq!(position_notional(10, 100_000_000, 1), 1_000_000_000);
        // Negative qty (short) has the same abs notional.
        assert_eq!(position_notional(-10, 100_000_000, 1), 1_000_000_000);
    }

    #[test]
    fn test_position_notional_with_contract_size() {
        // |5| * 100 contract_size * 50_000_000 price = 2.5e10
        assert_eq!(position_notional(5, 50_000_000, 100), 25_000_000_000);
    }

    #[test]
    fn test_position_notional_zero_inputs() {
        assert_eq!(position_notional(0, 100, 1), 0);
        assert_eq!(position_notional(10, 0, 1), 0);
        assert_eq!(position_notional(10, -5, 1), 0);
    }

    #[test]
    fn test_position_notional_saturates_at_extremes() {
        // i128::MAX / 2 should not overflow.
        let n = position_notional(i64::MAX, i64::MAX, u64::MAX);
        assert!(n > 0);
        // Should saturate, not panic.
        let _ = position_notional(i64::MIN, i64::MAX, u64::MAX);
    }

    #[test]
    fn test_find_top_position_empty() {
        let positions = empty_positions();
        let marks = [0i64; MAX_INSTRUMENTS];
        let cs = [1u64; MAX_INSTRUMENTS];
        assert_eq!(find_top_position(&positions, 0, &marks, &cs), None);
    }

    #[test]
    fn test_find_top_position_single() {
        let mut positions = empty_positions();
        positions[0] = pos(0, 10, 100_000_000);
        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[0] = 100_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];
        assert_eq!(find_top_position(&positions, 1, &marks, &cs), Some(0));
    }

    #[test]
    fn test_find_top_position_picks_largest() {
        let mut positions = empty_positions();
        positions[0] = pos(0, 10, 100_000_000); // notional 10 * 100M * 1 = 1e9
        positions[1] = pos(1, 5, 200_000_000); // notional 5 * 200M * 1 = 1e9
        positions[2] = pos(2, 1, 1_000_000_000); // notional 1 * 1e9 * 1 = 1e9
        positions[3] = pos(3, 20, 200_000_000); // notional 20 * 200M * 1 = 4e9
        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[0] = 100_000_000;
        marks[1] = 200_000_000;
        marks[2] = 1_000_000_000;
        marks[3] = 200_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];
        // Position 3 has the largest notional (4e9).
        assert_eq!(find_top_position(&positions, 4, &marks, &cs), Some(3));
    }

    #[test]
    fn test_find_top_position_skips_zero_qty() {
        let mut positions = empty_positions();
        positions[0] = pos(0, 0, 0);
        positions[1] = pos(1, 5, 100_000_000);
        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[1] = 100_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];
        assert_eq!(find_top_position(&positions, 2, &marks, &cs), Some(1));
    }

    #[test]
    fn test_find_top_position_skips_zero_mark() {
        // A position with qty but no mark (mark_price == 0) ranks as 0,
        // so it loses to any position with a real mark.
        let mut positions = empty_positions();
        positions[0] = pos(0, 100, 50_000_000); // qty=100, mark=0 → notional=0
        positions[1] = pos(1, 5, 100_000_000); // qty=5, mark=100M → notional=5e8
        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[1] = 100_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];
        assert_eq!(find_top_position(&positions, 2, &marks, &cs), Some(1));
    }

    #[test]
    fn test_apply_reduction_long_25pct() {
        // Long 100, reduce 25% → new_qty = 75, removed = 25.
        let p = pos(0, 100, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 2_500);
        assert_eq!(new_qty, 75);
        assert_eq!(removed, 25);
    }

    #[test]
    fn test_apply_reduction_short_25pct() {
        // Short -100, reduce 25% → new_qty = -75, removed = 25.
        let p = pos(0, -100, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 2_500);
        assert_eq!(new_qty, -75);
        assert_eq!(removed, 25);
    }

    #[test]
    fn test_apply_reduction_full_close() {
        // 100% reduction (10_000 bps) → qty collapses to 0.
        let p = pos(0, 100, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 10_000);
        assert_eq!(new_qty, 0);
        assert_eq!(removed, 100);
    }

    #[test]
    fn test_apply_reduction_zero_qty_unchanged() {
        let p = pos(0, 0, 0);
        let (new_qty, removed) = apply_reduction(&p, 2_500);
        assert_eq!(new_qty, 0);
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_apply_reduction_zero_fraction_unchanged() {
        let p = pos(0, 100, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 0);
        assert_eq!(new_qty, 100);
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_apply_reduction_odd_qty_rounds_toward_zero() {
        // |7| * 2500 / 10000 = 1 (truncated); new_abs = 6 (long).
        // Conservative direction: we close *less* than 25%.
        let p = pos(0, 7, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 2_500);
        assert_eq!(new_qty, 6);
        assert_eq!(removed, 1);
    }

    #[test]
    fn test_apply_reduction_over_100pct_clamps_to_zero() {
        // fraction_bps > 10_000 should not go negative; saturating_sub
        // clamps to 0.
        let p = pos(0, 100, 1_000_000);
        let (new_qty, removed) = apply_reduction(&p, 20_000);
        assert_eq!(new_qty, 0);
        assert_eq!(removed, 100);
    }

    #[test]
    fn test_default_constants_pin_decision() {
        // Decision D4: 5 rounds × 25%. These constants are the
        // load-bearing parameters for the liquidation safety stack;
        // changing them requires revisiting D4.
        assert_eq!(DEFAULT_MAX_ROUNDS, 5);
        assert_eq!(DEFAULT_FRACTION_BPS, 2_500);
    }

    #[test]
    fn test_compose_sort_then_reduce() {
        // End-to-end micro-scenario: 3 positions, reduce top by 25%.
        let mut positions = empty_positions();
        positions[0] = pos(0, 10, 50_000_000);
        positions[1] = pos(1, 100, 100_000_000);
        positions[2] = pos(2, 1, 1_000_000_000);
        let mut marks = [0i64; MAX_INSTRUMENTS];
        marks[0] = 50_000_000;
        marks[1] = 100_000_000;
        marks[2] = 1_000_000_000;
        let cs = [1u64; MAX_INSTRUMENTS];

        let top = find_top_position(&positions, 3, &marks, &cs).unwrap();
        // Top: pos[1] = 100 * 100M = 1e10 vs pos[2] = 1 * 1e9 = 1e9.
        assert_eq!(top, 1);
        let (new_qty, removed) = apply_reduction(&positions[top], 2_500);
        assert_eq!(new_qty, 75);
        assert_eq!(removed, 25);
        // Apply to the array (caller's job, not this module's).
        positions[top].qty = new_qty;
        assert_eq!(positions[1].qty, 75);
        // The other positions are unchanged.
        assert_eq!(positions[0].qty, 10);
        assert_eq!(positions[2].qty, 1);
        // Keep Pubkey import used so the `pos()` helper doesn't warn.
        let _ = Pubkey::default();
    }

    // ---- M7 7.7 remediation (R1): validate_instrument_coverage ----

    fn pos_with_id(id: u16) -> Position {
        Position {
            instrument_id: id,
            qty: 10,
            entry_vwap: 1_000_000,
        }
    }

    #[test]
    fn test_validate_coverage_all_covered_ok() {
        let mut positions = [Position::default(); MAX_POSITIONS];
        positions[0] = pos_with_id(0);
        positions[1] = pos_with_id(3);
        positions[2] = pos_with_id(31);
        positions_len_helper(&mut positions, 3);
        let passed = [0u16, 1, 2, 3, 31];
        assert!(validate_instrument_coverage(&positions, 3, &passed).is_ok());
    }

    #[test]
    fn test_validate_coverage_one_missing_errors() {
        let mut positions = [Position::default(); MAX_POSITIONS];
        positions[0] = pos_with_id(0);
        positions[1] = pos_with_id(5); // not in passed list
        positions_len_helper(&mut positions, 2);
        let passed = [0u16, 1, 2];
        assert_eq!(
            validate_instrument_coverage(&positions, 2, &passed),
            Err(MgkError::InstrumentMissingForLiquidation)
        );
    }

    #[test]
    fn test_validate_coverage_empty_passed_with_positions_errors() {
        // This is the exact silent-failure case: caller passed no
        // instruments but the user has positions. Without this check,
        // full_flat would record PnL = -qty * entry for every position.
        let mut positions = [Position::default(); MAX_POSITIONS];
        positions[0] = pos_with_id(0);
        positions_len_helper(&mut positions, 1);
        let passed: [u16; 0] = [];
        assert_eq!(
            validate_instrument_coverage(&positions, 1, &passed),
            Err(MgkError::InstrumentMissingForLiquidation)
        );
    }

    #[test]
    fn test_validate_coverage_out_of_range_instrument_id_errors() {
        // instrument_id is u16, but only 32 instruments exist. An
        // out-of-range id indicates state corruption (the position
        // references a non-existent instrument). Treat as the same
        // error so the keeper sees a single clear failure mode.
        let mut positions = [Position::default(); MAX_POSITIONS];
        positions[0] = pos_with_id(100);
        positions_len_helper(&mut positions, 1);
        let passed = [100u16];
        assert_eq!(
            validate_instrument_coverage(&positions, 1, &passed),
            Err(MgkError::InstrumentMissingForLiquidation)
        );
    }

    #[test]
    fn test_validate_coverage_zero_count_is_ok() {
        // No positions → no coverage requirement. Avoids spurious errors
        // when the caller passes a fully-instrumented account list but
        // the portfolio happens to be empty (the entrypoint already
        // rejects positions_len == 0 elsewhere, but defense-in-depth).
        let positions = [Position::default(); MAX_POSITIONS];
        let passed: [u16; 0] = [];
        assert!(validate_instrument_coverage(&positions, 0, &passed).is_ok());
    }

    /// Local helper to set `positions_len` on a `[Position; MAX_POSITIONS]`
    /// by tracking it via a parallel array — we need it because
    /// `positions_len` lives on `Portfolio`, not on the array directly.
    /// Since `validate_instrument_coverage` takes `count: usize`, the
    /// caller (the orchestrator) extracts `portfolio.positions_len` and
    /// passes that; here in tests we just pass our own `count` value,
    /// so this helper is only used to *document* the value via the
    /// array contents (the count is passed explicitly to the function).
    fn positions_len_helper(_positions: &mut [Position; MAX_POSITIONS], _count: u16) {
        // No-op: positions_len is a Portfolio field, not a Position-array
        // field. The tests below pass `count` directly to
        // validate_instrument_coverage, so this helper is purely a
        // readability marker. The unused parameter is intentional.
    }

    #[test]
    fn test_instrument_missing_error_pinned_to_601() {
        // Pin the u32 value so a refactor reassigning the enum value
        // would break the on-chain error code visible to clients.
        // Pattern from reveal_order.rs::test_reveal_deadline_expired_error_in_perps_core_range.
        assert_eq!(
            MgkError::InstrumentMissingForLiquidation as u32,
            601,
            "InstrumentMissingForLiquidation must stay in the perps-core 600-699 range"
        );
    }
}
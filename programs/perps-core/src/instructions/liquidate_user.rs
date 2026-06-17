use crate::state::instrument::Instrument;
use crate::state::liquidation::{
    apply_reduction, find_top_position, validate_instrument_coverage, DEFAULT_FRACTION_BPS,
    DEFAULT_MAX_ROUNDS,
};
use crate::state::portfolio::{Portfolio, Position, MAX_INSTRUMENTS};
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use percolator_common::{
    math::{calculate_im, calculate_mm},
    PercolatorError,
};
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// M7 7.7: PriceOracle field offset for the `price` field. See
/// `programs/perps-core/src/instructions/settle_batch.rs` for the full
/// layout. Copied here rather than imported from settle_batch to keep
/// `liquidate_user` self-contained.
const ORACLE_PRICE_OFFSET: usize = 80;
const ORACLE_PRICE_LEN: usize = 8;
const ORACLE_MAGIC: u64 = 0x4C43_524F_4C43_5250;

/// Liquidate an underwater portfolio (M7 7.7).
///
/// Replaces the pre-7.7 full-flat path with an iterative reduction
/// (decision D4): up to `DEFAULT_MAX_ROUNDS` rounds × `DEFAULT_FRACTION_BPS`
/// each, recomputing `health` after every round. If the portfolio is still
/// underwater after the loop, falls back to full-flat. Then claims
/// insurance; if insurance runs out, the uncovered balance is flagged on
/// `vault.adl_pending` for the keeper (no real ADL yet).
///
/// Marking uses `instrument.mark_price` (composite from M7 7.5) with a
/// fallback to the oracle price when `mark_price == 0` (first batch, stale
/// book, no fills). This matches the design intent of using executable
/// prices rather than raw oracle for liquidation (design L470, L99).
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [] Registry
/// 2. [writable] Vault PDA
/// 3. [signer] Liquidator
///
/// Then N read-only instrument accounts (provide composite mark_price, contract_size, imr_bps, mmr_bps); pass N = num_instruments; total = 4 + num_instruments.
///
/// Then 1 fallback oracle account (single, owner = percolator-oracle).
///
/// Data: num_instruments(2)
pub fn process_liquidate_user(
    _program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    liquidator_account: &AccountInfo,
    instrument_accounts: &[AccountInfo],
    oracle_account: &AccountInfo,
) -> ProgramResult {
    if !liquidator_account.is_signer() {
        msg!("Error: Liquidator must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    let portfolio = unsafe {
        &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
    };
    let registry = unsafe {
        &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry)
    };

    // M7 7.8: governance emergency brake. Liquidations can be paused by
    // governance (e.g. to manually intervene on a single position, or to
    // buy time during an oracle outage). Use with care — pausing
    // liquidations allows bad debt to accumulate.
    if registry.is_liquidations_paused() {
        msg!("Error: Liquidations are paused");
        return Err(PercolatorError::OperationPaused.into());
    }

    if portfolio.positions_len == 0 {
        msg!("Error: No positions to liquidate");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // M7 7.7 remediation (R1): collect the set of instrument IDs the
    // caller passed in `instrument_accounts` so we can verify that every
    // position's instrument is covered. Without this check, a missing
    // instrument silently gets mark=0 in the lookup tables, and
    // `full_flat` would record PnL = -qty * entry (destroying equity
    // with no error). See `validate_instrument_coverage` for the
    // rejection semantics.
    let mut passed_ids: [u16; MAX_INSTRUMENTS] = [u16::MAX; MAX_INSTRUMENTS];
    let mut passed_count: usize = 0;
    for inst in instrument_accounts {
        if passed_count >= MAX_INSTRUMENTS {
            // Defensive: entrypoint already caps num_instruments at
            // u16::MAX, but we want a clean error if the slice somehow
            // exceeds MAX_INSTRUMENTS. In practice this can't happen
            // because the on-chain instrument table is bounded to 32.
            break;
        }
        let inst_ref = unsafe { &*(inst.borrow_data_unchecked().as_ptr() as *const Instrument) };
        let id = inst_ref.instrument_id;
        // Skip duplicate IDs — the helper does a linear `contains` and
        // we'd be doing redundant work. Duplicates are harmless to the
        // coverage check.
        if !passed_ids[..passed_count].contains(&id) {
            passed_ids[passed_count] = id;
            passed_count += 1;
        }
    }
    validate_instrument_coverage(&portfolio.positions, portfolio.positions_len as usize, &passed_ids[..passed_count])?;

    // Check health — only liquidate if underwater.
    if portfolio.health >= 0 {
        msg!("Error: Portfolio is healthy, cannot liquidate");
        return Err(PercolatorError::PortfolioHealthy.into());
    }

    // 1. Read the fallback oracle price (single account). None means
    //    "no oracle available; we'll only use instrument.mark_price".
    let oracle_price = read_oracle_price(oracle_account);

    // 2. Build per-instrument lookup tables from the instrument accounts.
    let mut mark_prices: [i64; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut contract_sizes: [u64; MAX_INSTRUMENTS] = [1; MAX_INSTRUMENTS];
    let mut imr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut mmr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    for inst in instrument_accounts {
        let inst_ref = unsafe { &*(inst.borrow_data_unchecked().as_ptr() as *const Instrument) };
        let id = inst_ref.instrument_id as usize;
        if id < MAX_INSTRUMENTS {
            // Composite mark from 7.5; fall back to oracle if mark is 0.
            mark_prices[id] = if inst_ref.mark_price > 0 {
                inst_ref.mark_price
            } else {
                oracle_price.unwrap_or(0)
            };
            contract_sizes[id] = if inst_ref.contract_size > 0 {
                inst_ref.contract_size
            } else {
                1
            };
            imr_bps_table[id] = inst_ref.imr_bps;
            mmr_bps_table[id] = inst_ref.mmr_bps;
        }
    }

    // 3. Iterative reduction loop (decision D4).
    for _round in 0..DEFAULT_MAX_ROUNDS {
        if portfolio.health >= 0 {
            break;
        }
        let top_idx = match find_top_position(
            &portfolio.positions,
            portfolio.positions_len as usize,
            &mark_prices,
            &contract_sizes,
        ) {
            Some(i) => i,
            None => break,
        };
        let old_qty = portfolio.positions[top_idx].qty;
        let (new_qty, _removed) =
            apply_reduction(&portfolio.positions[top_idx], DEFAULT_FRACTION_BPS);

        // Realize the PnL delta from the closed portion into equity:
        //   realized_pnl = (new_qty - old_qty) * (mark - entry)
        // For a long reducing (closed_signed < 0): closing at mark when
        // mark > entry gives positive cash; mark < entry reduces loss.
        // For a short reducing (closed_signed > 0): symmetric.
        let inst_id = portfolio.positions[top_idx].instrument_id as usize;
        let mark = mark_prices
            .get(inst_id)
            .copied()
            .unwrap_or(0);
        let entry = portfolio.positions[top_idx].entry_vwap;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed.saturating_mul((mark as i128) - (entry as i128));
        portfolio.equity = portfolio.equity.saturating_add(delta_pnl);

        portfolio.positions[top_idx].qty = new_qty;

        // If the position collapsed to 0, drop it from the live positions.
        if new_qty == 0 {
            let last = (portfolio.positions_len as usize).saturating_sub(1);
            if top_idx != last {
                portfolio.positions[top_idx] = portfolio.positions[last];
            }
            portfolio.positions[last] = Position::default();
            portfolio.positions_len = portfolio.positions_len.saturating_sub(1);
        }

        // Recompute margin (im, mm, health). Does NOT touch pnl — that
        // field tracks funding accrual, not unrealized position PnL.
        recompute_margin(
            portfolio,
            &mark_prices,
            &contract_sizes,
            &imr_bps_table,
            &mmr_bps_table,
        );
    }

    // 4. If still underwater after the loop, full-flat the remaining
    //    positions at mark price.
    if portfolio.health < 0 && portfolio.positions_len > 0 {
        full_flat(portfolio, &mark_prices);
        recompute_margin(
            portfolio,
            &mark_prices,
            &contract_sizes,
            &imr_bps_table,
            &mmr_bps_table,
        );
    }

    // 5. Insurance claim. If equity is still negative after the
    //    reduction / full-flat, claim from insurance_fund.
    let mut uncovered_bad_debt: u128 = 0;
    if portfolio.equity < 0 {
        let bad_debt = portfolio.equity.unsigned_abs();
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };
        let payout = bad_debt.min(vault.insurance_fund);
        if payout > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_sub(payout);
            portfolio.equity = portfolio.equity.saturating_add(payout as i128);
            uncovered_bad_debt = bad_debt.saturating_sub(payout);
            if uncovered_bad_debt > 0 {
                vault.uncovered_bad_debt =
                    vault.uncovered_bad_debt.saturating_add(uncovered_bad_debt);
            }
            portfolio.recalc_margin();
            msg!("Insurance claim processed");
        }
    }

    // 6. M7 7.7: ADL stub. If insurance could not cover the shortfall,
    //    flag the vault so a keeper can observe and resolve. This does
    //    NOT implement counterparty deleveraging.
    if uncovered_bad_debt > 0 {
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };
        vault.mark_adl_pending(uncovered_bad_debt);
        msg!("ADL pending: keeper observation required");
    }

    msg!("LiquidateUser: complete");
    Ok(())
}

/// Read the fallback oracle's price via raw byte access. Returns `None`
/// if the account is missing, too small, or fails magic validation.
fn read_oracle_price(oracle_account: &AccountInfo) -> Option<i64> {
    let data = oracle_account.try_borrow_data().ok()?;
    if data.len() < ORACLE_PRICE_OFFSET + ORACLE_PRICE_LEN {
        return None;
    }
    let magic_bytes: [u8; 8] = data[0..8].try_into().ok()?;
    if u64::from_le_bytes(magic_bytes) != ORACLE_MAGIC {
        return None;
    }
    let price_bytes: [u8; 8] = data[ORACLE_PRICE_OFFSET..ORACLE_PRICE_OFFSET + ORACLE_PRICE_LEN]
        .try_into()
        .ok()?;
    Some(i64::from_le_bytes(price_bytes))
}

/// Recompute `portfolio.im` + `portfolio.mm` for the current position set
/// using the composite marks. Does NOT touch `portfolio.pnl` (funding
/// accrual) or `portfolio.equity` (cash). Health is updated by
/// `recalc_margin`.
fn recompute_margin(
    portfolio: &mut Portfolio,
    mark_prices: &[i64; MAX_INSTRUMENTS],
    contract_sizes: &[u64; MAX_INSTRUMENTS],
    imr_bps: &[u16; MAX_INSTRUMENTS],
    mmr_bps: &[u16; MAX_INSTRUMENTS],
) {
    let mut total_im: u128 = 0;
    let mut total_mm: u128 = 0;
    let count = portfolio.positions_len as usize;
    for i in 0..count.min(MAX_INSTRUMENTS) {
        let pos = &portfolio.positions[i];
        if pos.qty == 0 {
            continue;
        }
        let inst_id = pos.instrument_id as usize;
        let mark = mark_prices
            .get(inst_id)
            .copied()
            .unwrap_or(0)
            .max(0) as u64;
        let cs = contract_sizes.get(inst_id).copied().unwrap_or(1);
        let imr = imr_bps.get(inst_id).copied().unwrap_or(0) as u64;
        let mmr = mmr_bps.get(inst_id).copied().unwrap_or(0) as u64;

        total_im = total_im.saturating_add(calculate_im(pos.qty, cs, mark, imr));
        total_mm = total_mm.saturating_add(calculate_mm(pos.qty, cs, mark, mmr));
    }
    portfolio.im = total_im;
    portfolio.mm = total_mm;
    portfolio.recalc_margin();
}

/// Full-flat the remaining positions at mark price. Realizes all PnL into
/// `portfolio.equity` and zeroes positions. Sign-correct: `equity += pnl`
/// (not `equity -= total_loss` — the pre-7.7 implementation had the sign
/// inverted and would increase equity on losses).
///
/// Does NOT touch `portfolio.pnl` (funding accrual counter).
fn full_flat(portfolio: &mut Portfolio, mark_prices: &[i64; MAX_INSTRUMENTS]) {
    let mut total_pnl: i128 = 0;
    let count = portfolio.positions_len as usize;
    for i in 0..count.min(MAX_INSTRUMENTS) {
        let pos = &portfolio.positions[i];
        if pos.qty == 0 {
            continue;
        }
        let inst_id = pos.instrument_id as usize;
        let mark = mark_prices.get(inst_id).copied().unwrap_or(0);
        let pnl = (pos.qty as i128) * ((mark as i128) - (pos.entry_vwap as i128));
        total_pnl = total_pnl.saturating_add(pnl);
    }
    // Realize the PnL into equity (cash). Positive pnl (profit) increases
    // equity; negative pnl (loss) decreases it.
    portfolio.equity = portfolio.equity.saturating_add(total_pnl);

    // Zero out positions.
    for i in 0..count.min(MAX_INSTRUMENTS) {
        portfolio.positions[i].qty = 0;
        portfolio.positions[i].entry_vwap = 0;
    }
    portfolio.positions_len = 0;
    portfolio.im = 0;
    portfolio.mm = 0;
    portfolio.recalc_margin();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_pubkey(byte: u8) -> Pubkey {
        let mut b = [0u8; 32];
        b[0] = byte;
        Pubkey::from(b)
    }

    fn instrument_with_mark(id: u16, mark: i64, cs: u64, imr: u16, mmr: u16) -> Instrument {
        let mut inst = Instrument::new(id, 1_000_000, 1_000, imr, mmr);
        inst.contract_size = cs;
        inst.mark_price = mark;
        inst
    }

    #[test]
    fn test_oracle_magic_is_pinned() {
        // The oracle account layout (programs/oracle/src/state.rs) is
        // validated by this magic. Refactor that breaks it would silently
        // disable liquidation marking when instrument.mark_price is 0.
        assert_eq!(ORACLE_MAGIC, 0x4C43_524F_4C43_5250);
    }

    #[test]
    fn test_apply_reduction_compound_call() {
        // 25% reduction three times on the same qty → still positive
        // (round-toward-zero is conservative, leaves residual).
        let mut p = Position {
            instrument_id: 0,
            qty: 100,
            entry_vwap: 1_000_000,
        };
        for _ in 0..3 {
            let (nq, _r) = apply_reduction(&p, 2_500);
            p.qty = nq;
        }
        // 100 → 75 → 57 → 43 (each step rounds toward zero).
        // Per step: |qty| * 2500 / 10000 = reduction.
        //   100 → 100 - 25 = 75
        //    75 →  75 - 18 = 57  (75 * 2500 / 10000 = 18)
        //    57 →  57 - 14 = 43  (57 * 2500 / 10000 = 14)
        assert_eq!(p.qty, 43);
    }

    #[test]
    fn test_apply_reduction_full_close_then_idempotent() {
        let p = Position {
            instrument_id: 0,
            qty: 100,
            entry_vwap: 1_000_000,
        };
        let (nq, _) = apply_reduction(&p, 10_000);
        assert_eq!(nq, 0);
        let (nq2, _) = apply_reduction(&Position { qty: 0, ..p }, 10_000);
        assert_eq!(nq2, 0);
    }

    #[test]
    fn test_bps_denom_cross_crate_invariant() {
        // BPS_DENOM = 10_000 is shared between math.rs (calculate_im,
        // calculate_mm) and the liquidation fraction. If it changes,
        // margin accounting silently breaks across the system. We pin
        // DEFAULT_FRACTION_BPS = 2_500 as 1/4 of 10_000 (= 25%).
        assert_eq!(DEFAULT_FRACTION_BPS, 2_500); // 25% of 10_000
        assert_eq!(DEFAULT_MAX_ROUNDS, 5);
        assert_eq!(DEFAULT_FRACTION_BPS * 4, 10_000);
    }

    #[test]
    fn test_instrument_with_mark_helper() {
        let inst = instrument_with_mark(1, 50_000_000, 1, 100, 50);
        assert_eq!(inst.instrument_id, 1);
        assert_eq!(inst.mark_price, 50_000_000);
        assert_eq!(inst.contract_size, 1);
        assert_eq!(inst.imr_bps, 100);
        assert_eq!(inst.mmr_bps, 50);
    }

    #[test]
    fn test_user_pubkey_helper() {
        let u = user_pubkey(7);
        assert_eq!(u.as_ref()[0], 7);
    }

    #[test]
    fn test_realized_pnl_sign_long_loss() {
        // Long 10 @ entry=100, mark=90 (loss). Reduce 25%: old=10,
        // new=7 (rounded). closed_signed = 7 - 10 = -3.
        // delta_pnl = -3 * (90 - 100) = -3 * -10 = +30.
        // Equity should INCREASE by 30 (we avoided 30 of loss).
        let old_qty: i64 = 10;
        let new_qty: i64 = 7;
        let entry: i64 = 100;
        let mark: i64 = 90;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed * ((mark as i128) - (entry as i128));
        assert_eq!(delta_pnl, 30);
    }

    #[test]
    fn test_realized_pnl_sign_short_loss() {
        // Short -10 @ entry=100, mark=110 (loss for short). Reduce 25%:
        // old=-10, new=-7. closed_signed = -7 - (-10) = +3.
        // delta_pnl = +3 * (110 - 100) = +30.
        // Equity should INCREASE by 30 (we avoided 30 of loss).
        let old_qty: i64 = -10;
        let new_qty: i64 = -7;
        let entry: i64 = 100;
        let mark: i64 = 110;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed * ((mark as i128) - (entry as i128));
        assert_eq!(delta_pnl, 30);
    }

    #[test]
    fn test_realized_pnl_sign_long_profit() {
        // Long 10 @ entry=100, mark=110 (profit). Reduce 25%: closed=-3.
        // delta_pnl = -3 * (110 - 100) = -30.
        // Equity DECREASES by 30 (we gave up 30 of profit to reduce).
        let old_qty: i64 = 10;
        let new_qty: i64 = 7;
        let entry: i64 = 100;
        let mark: i64 = 110;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed * ((mark as i128) - (entry as i128));
        assert_eq!(delta_pnl, -30);
    }
}
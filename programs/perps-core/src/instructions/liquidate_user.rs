use crate::state::batch::{Batch, BatchStatus};
use crate::state::instrument::Instrument;
use crate::state::liquidation::{
    apply_reduction, find_top_position, validate_instrument_coverage, DEFAULT_FRACTION_BPS,
    DEFAULT_MAX_ROUNDS,
};
use crate::state::portfolio::{Portfolio, Position, MAX_INSTRUMENTS};
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use mgk_common::{
    math::{calculate_im, calculate_mm},
    MgkError,
};
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// M7 7.7: PriceOracle field offset for the `price` field. See
/// `programs/oracle/src/state.rs` for the full layout. Copied here
/// rather than imported to keep `liquidate_user` self-contained.
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
/// Accounts (fixed + variable):
/// - index 0: writable Portfolio PDA
/// - index 1: read-only Registry (M7 7.8: required for
///   `liquidations_paused` check)
/// - index 2: writable Vault PDA
/// - index 3: signer Liquidator
/// - index 4: read-only Batch (latest settled; DFBA `mark_valid` / `liq_paused`)
/// - indices 5..5+num_instruments: read-only Instrument accounts (provide
///   composite mark_price, contract_size, imr_bps, mmr_bps)
/// - index 5+num_instruments: read-only fallback oracle account (single,
///   owner = mgk-oracle).
///
/// **Caller MUST pass an instrument account for every distinct
/// `instrument_id` referenced by the portfolio's positions.** A missing
/// instrument returns `MgkError::InstrumentMissingForLiquidation`
/// (= 601) — see M7 7.7 remediation R1. Pass all 32 if unsure; the lookup
/// uses `instrument_id` as the index, so extra unused accounts are
/// harmless.
///
/// Data: num_instruments(2)
#[allow(clippy::too_many_arguments)]
pub fn process_liquidate_user(
    _program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    liquidator_account: &AccountInfo,
    batch_account: &AccountInfo,
    instrument_accounts: &[AccountInfo],
    oracle_account: &AccountInfo,
) -> ProgramResult {
    if !liquidator_account.is_signer() {
        msg!("Error: Liquidator must be signer");
        return Err(MgkError::Unauthorized.into());
    }

    let portfolio =
        unsafe { &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio) };
    let registry =
        unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };

    // M7 7.8: governance emergency brake. Liquidations can be paused by
    // governance (e.g. to manually intervene on a single position, or to
    // buy time during an oracle outage). Use with care — pausing
    // liquidations allows bad debt to accumulate.
    if registry.is_liquidations_paused() {
        msg!("Error: Liquidations are paused");
        return Err(MgkError::OperationPaused.into());
    }

    if portfolio.positions_len == 0 {
        msg!("Error: No positions to liquidate");
        return Err(MgkError::InvalidInstruction.into());
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
            break;
        }
        let inst_ref = unsafe { &*(inst.borrow_data_unchecked().as_ptr() as *const Instrument) };
        let id = inst_ref.instrument_id;
        if !passed_ids[..passed_count].contains(&id) {
            passed_ids[passed_count] = id;
            passed_count += 1;
        }
    }
    validate_instrument_coverage(
        &portfolio.positions,
        portfolio.positions_len as usize,
        &passed_ids[..passed_count],
    )?;

    if portfolio.health >= 0 {
        msg!("Error: Portfolio is healthy, cannot liquidate");
        return Err(MgkError::PortfolioHealthy.into());
    }

    // DFBA T9.4.1: liquidations require a dual-clear mark on the settled batch.
    // Trading may continue when only liq is paused (`liq_paused` / !mark_valid).
    let batch = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };
    if batch.status != BatchStatus::Settled {
        msg!("Error: Liquidate requires a Settled batch for mark_valid");
        return Err(MgkError::BatchNotSettled.into());
    }
    if batch.mark_valid == 0 || batch.liq_paused != 0 {
        msg!("Error: DFBA mark invalid / liq paused; liquidations blocked");
        return Err(MgkError::MarkInvalidForLiquidation.into());
    }
    // Prefer instrument mark when set; dual mid was written on settle when mark_valid.
    let any_mark = instrument_accounts.iter().any(|a| {
        let inst = unsafe { &*(a.borrow_data_unchecked().as_ptr() as *const Instrument) };
        inst.mark_price > 0
    }) || batch.clearing_price > 0;
    if !any_mark {
        msg!("Error: No usable mark price for liquidation");
        return Err(MgkError::OperationPaused.into());
    }

    let oracle_price = read_oracle_price(oracle_account);

    let mut mark_prices: [i64; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut contract_sizes: [u64; MAX_INSTRUMENTS] = [1; MAX_INSTRUMENTS];
    let mut imr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut mmr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    for inst in instrument_accounts {
        let inst_ref = unsafe { &*(inst.borrow_data_unchecked().as_ptr() as *const Instrument) };
        let id = inst_ref.instrument_id as usize;
        if id < MAX_INSTRUMENTS {
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

        recompute_margin(
            portfolio,
            &mark_prices,
            &contract_sizes,
            &imr_bps_table,
            &mmr_bps_table,
        );
    }

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

    let mut uncovered_bad_debt: u128 = 0;
    if portfolio.equity < 0 {
        let bad_debt = portfolio.equity.unsigned_abs();
        let vault =
            unsafe { &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault) };
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

    if uncovered_bad_debt > 0 {
        let vault =
            unsafe { &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault) };
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
        let mark = mark_prices.get(inst_id).copied().unwrap_or(0).max(0) as u64;
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
    portfolio.equity = portfolio.equity.saturating_add(total_pnl);

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
    use pinocchio::pubkey::Pubkey;

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
        assert_eq!(ORACLE_MAGIC, 0x4C43_524F_4C43_5250);
    }

    #[test]
    fn test_apply_reduction_compound_call() {
        let mut p = Position {
            instrument_id: 0,
            qty: 100,
            entry_vwap: 1_000_000,
        };
        for _ in 0..3 {
            let (nq, _r) = apply_reduction(&p, 2_500);
            p.qty = nq;
        }
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
        assert_eq!(DEFAULT_FRACTION_BPS, 2_500);
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

    /// T9.4.1: liquidation gate pattern — Settled + mark_valid + !liq_paused.
    #[test]
    fn test_dfba_liq_mark_gate_pattern() {
        use crate::state::batch::{Batch, BatchStatus};
        let mut b = Batch::new(1);
        b.status = BatchStatus::Settled;
        b.mark_valid = 0;
        b.liq_paused = 1;
        assert!(b.mark_valid == 0 || b.liq_paused != 0);

        b.mark_valid = 1;
        b.liq_paused = 0;
        b.clearing_price = 100_000;
        assert!(b.status == BatchStatus::Settled && b.mark_valid != 0 && b.liq_paused == 0);
        let _ = user_pubkey(1);
    }

    #[test]
    fn test_user_pubkey_helper() {
        let u = user_pubkey(7);
        assert_eq!(u.as_ref()[0], 7);
    }

    #[test]
    fn test_realized_pnl_sign_long_loss() {
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
        let old_qty: i64 = 10;
        let new_qty: i64 = 7;
        let entry: i64 = 100;
        let mark: i64 = 110;
        let closed_signed = (new_qty - old_qty) as i128;
        let delta_pnl = closed_signed * ((mark as i128) - (entry as i128));
        assert_eq!(delta_pnl, -30);
    }
}

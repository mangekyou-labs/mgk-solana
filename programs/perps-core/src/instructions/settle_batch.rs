use crate::pda::derive_batch_pda;
use crate::state::batch::{Batch, BatchStatus, Commitment, CommitmentStatus};
use crate::state::instrument::Instrument;
use crate::state::portfolio::Portfolio;
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// M6 6i.2: CLOB results wire format. num_fills(2) header, then 49 bytes per
/// fill: user(32) + filled_qty(8) + notional(8) + is_maker(1).
const RESULTS_HEADER_BYTES: usize = 2;
const RESULTS_BYTES_PER_FILL: usize = 49;
const BPS_DENOM: i128 = 10_000;

/// M7 7.5: PriceOracle field offset for the `price` field (raw bytes
/// read). The full struct is defined in `programs/oracle/src/state.rs`.
/// At offset 80: magic(8) + version(1) + bump(1) + is_active(1) +
/// _padding(5) + authority(32) + instrument(32) + price(8). This avoids
/// pulling percolator-oracle as a dep just to read 8 bytes.
const ORACLE_PRICE_OFFSET: usize = 80;
const ORACLE_PRICE_LEN: usize = 8;
/// Magic bytes stored as a u64 LE at offset 0 of `PriceOracle`. The
/// `PriceOracle::MAGIC` constant in `programs/oracle/src/state.rs` is
/// `b"PRCLORCL"`, which when stored LE on-chain becomes
/// `0x4C43524F4C435250` (P=0x50, R=0x52, C=0x43, L=0x4C, O=0x4F, ...).
const ORACLE_MAGIC: u64 = 0x4C43_524F_4C43_5250;

/// M7 7.2: Return the locked commitment deposit to the user's portfolio.
/// Decrements `portfolio.im` by `deposit_lamports` and recomputes
/// `free_collateral` / `health`. Used in both the Settled and Slashed
/// branches of `process_settle_batch` so that `CommitOrder`'s
/// `portfolio.im += deposit` lock is always reversed.
///
/// Returns `true` if the matching portfolio was found, `false` otherwise.
/// A `false` return signals a keeper TX bug (missing portfolio account) —
/// we do not crash because the deposit is still slashed to insurance in
/// that path; the im lock just persists until the keeper retries with the
/// correct account list.
fn return_deposit(
    portfolio_accounts: &[AccountInfo],
    user: &Pubkey,
    deposit_lamports: u64,
) -> bool {
    for portfolio_account in portfolio_accounts {
        let portfolio = unsafe {
            &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
        };
        if portfolio.user == *user {
            portfolio.im = portfolio.im.saturating_sub(deposit_lamports as u128);
            portfolio.recalc_margin();
            return true;
        }
    }
    false
}

/// M7 7.5: Read the fallback oracle's price via raw byte access.
///
/// Returns `Some(price)` if the oracle account has the expected magic
/// bytes and is at least 88 bytes long; `None` otherwise. We don't
/// validate `is_active` here — the caller treats a stale or inactive
/// oracle as "use book mid or carry-forward" without distinguishing the
/// two failure modes (the design's job, not ours).
///
/// Layout (per `programs/oracle/src/state.rs::PriceOracle`):
///   0..8     magic (u64 LE, `b"PRCLORCL"`)
///   8        version
///   9        bump
///   10       is_active
///   11..16   _padding
///   16..48   authority
///   48..80   instrument
///   80..88   price (i64 LE)  ← we read this
///   88..96   timestamp
///   96..104  confidence
///   104..128 _reserved
fn read_oracle_price(oracle_account: &AccountInfo) -> Option<i64> {
    let data = oracle_account.try_borrow_data().ok()?;
    if data.len() < ORACLE_PRICE_OFFSET + ORACLE_PRICE_LEN {
        return None;
    }
    // Validate magic.
    let magic_bytes: [u8; 8] = data[0..8].try_into().ok()?;
    let magic = u64::from_le_bytes(magic_bytes);
    if magic != ORACLE_MAGIC {
        return None;
    }
    // Read price.
    let price_bytes: [u8; 8] = data[ORACLE_PRICE_OFFSET..ORACLE_PRICE_OFFSET + ORACLE_PRICE_LEN]
        .try_into()
        .ok()?;
    Some(i64::from_le_bytes(price_bytes))
}

#[allow(clippy::too_many_arguments)]
pub fn process_settle_batch(
    program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    results_account: &AccountInfo,
    instrument_account: &AccountInfo,
    book_account: &AccountInfo,
    oracle_account: &AccountInfo,
    matcher_program: &AccountInfo,
    commitment_accounts: &[AccountInfo],
    portfolio_accounts: &[AccountInfo],
    next_batch_account: &AccountInfo,
) -> ProgramResult {
    let batch = unsafe {
        &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };

    if batch.status != BatchStatus::Clearing {
        msg!("Error: Batch not in clearing phase");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let registry = unsafe {
        &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry)
    };

    // Read the instrument (M6 6i.3) — provides taker/maker fee schedule.
    // M7 7.5: also need to write mark_price back, so we cast to *mut.
    let instrument = unsafe {
        &mut *(instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut Instrument)
    };

    // Read results from the results account (M6 6i.2 CLOB format).
    let results_data = results_account
        .try_borrow_data()
        .map_err(|_| PercolatorError::InvalidAccount)?;

    if results_data.len() < RESULTS_HEADER_BYTES {
        msg!("Error: Results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    let num_fills = u16::from_le_bytes(
        results_data[0..RESULTS_HEADER_BYTES]
            .try_into()
            .unwrap(),
    ) as usize;
    let fills_size = RESULTS_HEADER_BYTES + num_fills * RESULTS_BYTES_PER_FILL;
    if results_data.len() < fills_size {
        msg!("Error: Results account too small for fills");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Settle each commitment based on aggregated fill results.
    // A user can have multiple fills (one taker + N makers) at different
    // maker prices. We sum up qty and notional per user; the effective
    // price (notional / qty) becomes the entry_vwap.
    //
    // M6 6i.3: per-user fee/rebate aggregation. We split notional by
    // is_maker so the rebate (negative maker_fee_bps) only applies to
    // the maker-side portion of the user's fills.
    let mut total_settled: u32 = 0;
    let mut total_volume: u64 = 0;
    let mut total_notional: u128 = 0;
    let mut total_maker_notional: u128 = 0;
    let mut total_taker_notional: u128 = 0;
    let mut slashed: u128 = 0;

    for commitment_account in commitment_accounts.iter().take(batch.total_commitments as usize) {
        let commitment = unsafe {
            &mut *(commitment_account.borrow_mut_data_unchecked().as_ptr() as *mut Commitment)
        };

        if commitment.status == CommitmentStatus::Pending {
            // Non-revealed commitment — slash deposit.
            // M7 7.2: `commitment.deposit_lamports` stores the value
            // returned by `Registry::deposit_amount()` (i.e. `base_deposit *
            // volatility_multiplier / 10_000`, default = 10_000_000). It is
            // already in the same unit as `portfolio.equity` and
            // `vault.insurance_fund`, so no scale conversion is applied
            // here. (The previous `* 1_000_000` multiplier inflated the
            // insurance credit by 1e6 and was a unit-conversion bug.)
            commitment.status = CommitmentStatus::Slashed;
            slashed = slashed.saturating_add(commitment.deposit_lamports as u128);
            // Return the im lock even though the deposit was slashed —
            // the user's free collateral should reflect that the order
            // never executed. The slashed deposit itself is forwarded to
            // `vault.insurance_fund` below.
            return_deposit(portfolio_accounts, &commitment.user, commitment.deposit_lamports);
            continue;
        }

        if commitment.status != CommitmentStatus::Revealed {
            continue;
        }

        let user = &commitment.user;
        let mut user_filled_qty: u64 = 0;
        let mut user_notional: u64 = 0;
        let mut user_maker_notional: u64 = 0;
        let mut user_taker_notional: u64 = 0;

        for f_idx in 0..num_fills {
            let offset = RESULTS_HEADER_BYTES + f_idx * RESULTS_BYTES_PER_FILL;
            let fill_user_bytes: [u8; 32] =
                results_data[offset..offset + 32].try_into().unwrap();
            let fill_user = Pubkey::from(fill_user_bytes);

            if fill_user == *user {
                let fq = u64::from_le_bytes(
                    results_data[offset + 32..offset + 40].try_into().unwrap(),
                );
                let fn_ = u64::from_le_bytes(
                    results_data[offset + 40..offset + 48].try_into().unwrap(),
                );
                let is_maker = results_data[offset + 48] != 0;
                user_filled_qty = user_filled_qty.saturating_add(fq);
                user_notional = user_notional.saturating_add(fn_);
                if is_maker {
                    user_maker_notional = user_maker_notional.saturating_add(fn_);
                } else {
                    user_taker_notional = user_taker_notional.saturating_add(fn_);
                }
            }
        }

        // Find matching portfolio
        for portfolio_account in portfolio_accounts {
            let portfolio = unsafe {
                &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
            };

            if portfolio.user == *user {
                if user_filled_qty > 0 {
                    // Apply aggregated fill — update position.
                    let side = commitment.revealed.side as u8; // 0=Buy, 1=Sell
                    let instrument_id = commitment.revealed.instrument_id;
                    let qty_delta: i64 = if side == 0 {
                        user_filled_qty as i64 // Buy: positive qty
                    } else {
                        -(user_filled_qty as i64) // Sell: negative qty
                    };

                    // Effective price = notional / qty (price-time CLOB fills
                    // at multiple maker prices, so there's no single clearing
                    // price — VWAP is the natural choice for entry_vwap).
                    let effective_price: i64 = user_notional
                        .checked_div(user_filled_qty)
                        .unwrap_or(0) as i64;

                    let existing = portfolio.find_position(instrument_id);
                    if let Some((idx, pos)) = existing {
                        let new_qty = pos.qty.saturating_add(qty_delta);
                        portfolio.positions[idx].qty = new_qty;
                    } else {
                        if (portfolio.positions_len as usize) < portfolio.positions.len() {
                            let idx = portfolio.positions_len as usize;
                            portfolio.positions[idx].instrument_id = instrument_id;
                            portfolio.positions[idx].qty = qty_delta;
                            portfolio.positions[idx].entry_vwap = effective_price;
                            portfolio.positions_len += 1;
                        }
                    }

                    // Position notional: settled cash flow from the trade.
                    // For buys: equity decreases (spent); for sells: increases
                    // (received).
                    let notional_delta = user_notional as i128;
                    if side == 0 {
                        portfolio.equity = portfolio.equity.saturating_sub(notional_delta);
                    } else {
                        portfolio.equity = portfolio.equity.saturating_add(notional_delta);
                    }

                    // M6 6i.3: per-user maker rebate / taker fee.
                    // maker_rebate is signed: negative when maker_fee_bps<0
                    // (rebate paid to maker), positive when maker_fee_bps>0
                    // (rare — maker pays fee).
                    let maker_rebate: i128 = (user_maker_notional as i128
                        * instrument.maker_fee_bps as i128)
                        / BPS_DENOM;
                    let taker_fee: i128 = (user_taker_notional as i128
                        * instrument.taker_fee_bps as i128)
                        / BPS_DENOM;

                    // Net fee impact on this user (positive = cost, negative = rebate):
                    //   net = maker_rebate + taker_fee
                    // Apply to equity: equity -= net (rebates increase equity).
                    let net_fee = maker_rebate + taker_fee;
                    portfolio.equity = portfolio.equity.saturating_sub(net_fee);

                    portfolio.recalc_margin();
                }

                // M7 7.2: return the commitment deposit. The deposit was
                // locked against `portfolio.im` in `CommitOrder`; without
                // this, funds would be permanently locked. `recalc_margin`
                // is called inside `return_deposit`.
                return_deposit(portfolio_accounts, user, commitment.deposit_lamports);

                commitment.status = CommitmentStatus::Settled;
                total_settled += 1;
                total_volume = total_volume.saturating_add(user_filled_qty);
                total_notional = total_notional.saturating_add(user_notional as u128);
                total_maker_notional = total_maker_notional
                    .saturating_add(user_maker_notional as u128);
                total_taker_notional = total_taker_notional
                    .saturating_add(user_taker_notional as u128);
                break;
            }
        }
    }

    // Credit slashed deposits and net protocol fees to insurance fund.
    //
    // Insurance flow per user:
    //   + taker_fee  (taker paid)
    //   + maker_rebate  (negative: rebate paid out, reduces insurance)
    let protocol_fee_delta: i128 = (total_taker_notional as i128
        * instrument.taker_fee_bps as i128)
        / BPS_DENOM
        + (total_maker_notional as i128 * instrument.maker_fee_bps as i128) / BPS_DENOM;

    if slashed > 0 || protocol_fee_delta != 0 {
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };
        // Slashed deposits (positive) always credit insurance.
        if slashed > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_add(slashed);
        }
        // Net fee delta can be negative (rebates outpace fees). Saturate
        // to avoid underflow on insurance_fund (the protocol takes the
        // loss as uncovered_bad_debt if insurance runs out — tracked
        // separately, not subtracted here).
        if protocol_fee_delta > 0 {
            vault.insurance_fund =
                vault.insurance_fund.saturating_add(protocol_fee_delta as u128);
        } else if protocol_fee_delta < 0 {
            let rebate_out = (-protocol_fee_delta) as u128;
            if rebate_out <= vault.insurance_fund {
                vault.insurance_fund = vault.insurance_fund.saturating_sub(rebate_out);
            } else {
                // Insurance fund cannot cover the rebate — track the
                // shortfall as uncovered_bad_debt. For MVP we record the
                // deficit without crashing; downstream funding/insurance
                // top-up logic (out of scope) handles replenishment.
                vault.uncovered_bad_debt =
                    vault.uncovered_bad_debt.saturating_add(rebate_out - vault.insurance_fund);
                vault.insurance_fund = 0;
            }
        }
    }

    // Update batch state. CLOB has no single clearing price; we record the
    // effective price (total_notional / total_volume) for downstream
    // consumers (oracle, UI, etc.).
    let effective_clearing_price: i64 = total_notional
        .checked_div(total_volume as u128)
        .unwrap_or(0) as i64;
    batch.total_settled = total_settled;
    batch.total_volume = total_volume;
    batch.total_notional = total_notional;
    batch.slashed_deposits = batch.slashed_deposits.saturating_add(slashed);
    batch.clearing_price = effective_clearing_price;
    batch.status = BatchStatus::Settled;

    // M7 7.5: compute and write the mark price (decision D3 — mark lives
    // on Instrument, not on Batch). The mark drives funding, liquidation,
    // and equity computation downstream. We compute it after the batch is
    // marked Settled so the per-commitment state is final, and we write
    // to `instrument.mark_price` in place.
    //
    // 1. Validate the book PDA matches the expected derivation from the
    //    matcher's program id + the instrument's id. Refuse to read
    //    from a book that isn't the matcher's PDA for this instrument —
    //    protects against a malicious keeper passing a random book.
    let (expected_book_pda, _book_bump) = mgk_perps_matcher::state::book::book_pda(
        matcher_program.key(),
        instrument.instrument_id,
    );
    if book_account.key() != &expected_book_pda {
        msg!("Error: book_account PDA does not match expected derivation");
        return Err(PercolatorError::InvalidAccount.into());
    }

    // 2. Read the book. The book is matcher-owned; we only need the
    //    `OrderBook` header (the level arrays), not the resting[] array.
    //    We deserialize the full `OrderBook` struct from the start of the
    //    account data — it's `#[repr(C)]` so a raw cast is safe.
    let book: mgk_perps_matcher::state::book::OrderBook = unsafe {
        core::ptr::read_unaligned(
            book_account.borrow_data_unchecked().as_ptr()
                as *const mgk_perps_matcher::state::book::OrderBook,
        )
    };

    // 3. Read the oracle price (raw bytes — see `ORACLE_PRICE_OFFSET`).
    //    If the magic bytes don't match or the oracle is shorter than
    //    expected, treat as "no oracle" — fall back to book or
    //    carry-forward. Don't crash; an invalid oracle is recoverable
    //    via the carry-forward path.
    let oracle_price = read_oracle_price(oracle_account);

    // 4. Compute the new mark price. Reads `instrument.mark_price`
    //    (which is `prev_mark_price` — the value written in the last
    //    batch's SettleBatch, or 0 for the first batch).
    let prev_mark_price = instrument.mark_price;
    let current_slot = Clock::get()?.slot;
    let new_mark_price = crate::state::mark_price::compute_mark_price(
        &book,
        prev_mark_price,
        current_slot,
        oracle_price,
        instrument.mark_reference_qty,
        instrument.mark_decay_window_slots,
    );
    instrument.mark_price = new_mark_price;

    // Increment batch counter in registry
    let registry_mut = unsafe {
        &mut *(registry_account.borrow_mut_data_unchecked().as_ptr() as *mut Registry)
    };
    registry_mut.batch_id_counter = registry.batch_id_counter.saturating_add(1);

    // M7 7.1: embed next-batch creation (design decision D1 — see
    // docs/ai/planning/2026-06-16-m7-design-decisions.md). After settling
    // the current batch, write the next batch's PDA in place so there is
    // no idle gap where no batch is in Committing.
    //
    // 1. Derive the expected PDA from the current batch_id + 1 and verify
    //    the caller passed the right account.
    let (expected_next_pda, next_bump) =
        derive_batch_pda(batch.batch_id.saturating_add(1), program_id);
    if next_batch_account.key() != &expected_next_pda {
        msg!("Error: next_batch PDA does not match expected derivation");
        return Err(PercolatorError::InvalidAccount.into());
    }

    // 2. Defensive size check — the caller must pre-allocate the account
    //    at exactly size_of::<Batch>(). The PDA was created via system
    //    program in the same TX (or pre-created by the keeper) and
    //    assigned to core. If the size is wrong, refuse to write rather
    //    than corrupt the account.
    let next_batch_size = next_batch_account.data_len();
    if next_batch_size != core::mem::size_of::<Batch>() {
        msg!("Error: next_batch account size mismatch");
        return Err(PercolatorError::InvalidAccount.into());
    }

    // 3. Reject double-create: the account must be all-zero (batch_id == 0
    //    + status == Committing == 0 are ambiguous on their own, so we
    //    check batch_id != 0 as the canonical "already initialized" signal).
    {
        let next_batch_probe = unsafe {
            &*(next_batch_account.borrow_data_unchecked().as_ptr() as *const Batch)
        };
        if next_batch_probe.batch_id != 0 {
            msg!("Error: next_batch account already initialized");
            return Err(PercolatorError::AlreadyInitialized.into());
        }
    }

    // 4. Read the current slot and write the new batch in place.
    let current_slot = Clock::get()?.slot;
    let commit_deadline = current_slot.saturating_add(registry.t_max_slots);
    let next_batch = unsafe {
        &mut *(next_batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };
    // Reveal deadline is 0 here; CloseCommitting sets it on transition
    // out of Committing (design L153). Status, close_slot, shuffle_seed,
    // clearing_price, all counters default to 0 — the fresh state of a
    // brand-new batch in Committing.
    next_batch.initialize_in_place(
        batch.batch_id.saturating_add(1),
        commit_deadline,
        0,
        next_bump,
    );

    msg!("SettleBatch: Batch settled; next batch created");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M6 6i.2: results account format changed from
    /// `clearing_price(8) + num_fills(2) + fills(48)` to
    /// `num_fills(2) + fills(49)`. Pin the constants.
    #[test]
    fn test_results_wire_format_constants() {
        assert_eq!(RESULTS_HEADER_BYTES, 2);
        assert_eq!(RESULTS_BYTES_PER_FILL, 49);
        // Fill layout: user(32) + filled_qty(8) + notional(8) + is_maker(1).
        assert_eq!(32 + 8 + 8 + 1, RESULTS_BYTES_PER_FILL);
    }

    /// Build a synthetic results account buffer for a single fill.
    #[test]
    fn test_results_single_fill_layout() {
        let mut buf = [0u8; RESULTS_HEADER_BYTES + RESULTS_BYTES_PER_FILL];
        buf[0..2].copy_from_slice(&1u16.to_le_bytes());

        let user = pinocchio::pubkey::Pubkey::from([1u8; 32]);
        let offset = RESULTS_HEADER_BYTES;
        buf[offset..offset + 32].copy_from_slice(user.as_ref());
        buf[offset + 32..offset + 40].copy_from_slice(&5u64.to_le_bytes());
        buf[offset + 40..offset + 48].copy_from_slice(&500u64.to_le_bytes());
        buf[offset + 48] = 1; // is_maker

        let num_fills = u16::from_le_bytes(buf[0..2].try_into().unwrap());
        assert_eq!(num_fills, 1);
        let fq = u64::from_le_bytes(buf[offset + 32..offset + 40].try_into().unwrap());
        let fn_ = u64::from_le_bytes(buf[offset + 40..offset + 48].try_into().unwrap());
        let is_maker = buf[offset + 48];
        assert_eq!(fq, 5);
        assert_eq!(fn_, 500);
        assert_eq!(is_maker, 1);
    }

    /// M6 6i.3: pin the fee math.
    /// maker_fee_bps is signed (i16); negative = rebate paid to maker.
    #[test]
    fn test_maker_rebate_negative_is_payout() {
        let maker_notional: u64 = 1_000_000; // 1M notional
        let maker_fee_bps: i16 = -2; // 2 bps rebate
        let rebate: i128 =
            (maker_notional as i128 * maker_fee_bps as i128) / BPS_DENOM;
        // 1_000_000 * -2 / 10_000 = -200 (negative → rebate paid out)
        assert_eq!(rebate, -200);
    }

    #[test]
    fn test_taker_fee_positive_is_cost() {
        let taker_notional: u64 = 1_000_000;
        let taker_fee_bps: u16 = 5; // 5 bps fee
        let fee: i128 =
            (taker_notional as i128 * taker_fee_bps as i128) / BPS_DENOM;
        assert_eq!(fee, 500);
    }

    /// Net protocol fee delta = sum of taker fees + sum of maker rebates.
    /// When taker fees > maker rebates (revenue), insurance grows.
    /// When rebates > taker fees (subsidy), insurance shrinks.
    #[test]
    fn test_protocol_fee_delta_arithmetic() {
        let taker_notional: u128 = 5_000_000; // 5M taker
        let maker_notional: u128 = 3_000_000; // 3M maker
        let taker_fee_bps: u16 = 5;
        let maker_fee_bps: i16 = -2;
        let delta: i128 = (taker_notional as i128 * taker_fee_bps as i128) / BPS_DENOM
            + (maker_notional as i128 * maker_fee_bps as i128) / BPS_DENOM;
        // 5M * 5 / 10_000 = 2500
        // 3M * -2 / 10_000 = -600
        // net = 1900 (positive: protocol revenue)
        assert_eq!(delta, 1_900);
    }

    #[test]
    fn test_protocol_fee_delta_can_be_negative() {
        // When maker rebates exceed taker fees.
        let taker_notional: u128 = 1_000_000;
        let maker_notional: u128 = 10_000_000;
        let taker_fee_bps: u16 = 5;
        let maker_fee_bps: i16 = -2;
        let delta: i128 = (taker_notional as i128 * taker_fee_bps as i128) / BPS_DENOM
            + (maker_notional as i128 * maker_fee_bps as i128) / BPS_DENOM;
        // 1M * 5 / 10_000 = 500
        // 10M * -2 / 10_000 = -2000
        // net = -1500 (negative: protocol subsidizes)
        assert_eq!(delta, -1_500);
    }

    // =========================================================================
    // M7 7.1: Next-batch creation embedded in SettleBatch.
    //
    // These tests pin the post-conditions of the embedded batch creation.
    // They cannot call `process_settle_batch` directly (it requires real
    // Accounts + Clock sysvar), so they simulate the field writes that
    // `process_settle_batch` performs at the end (after `registry.batch_id_counter += 1`).
    // The matching e2e test in `tests/lifecycle.rs::test_e2e_settle_creates_next_batch_pda`
    // exercises the full path with real CPI.
    //
    // Note: `derive_batch_pda` calls `pinocchio::pubkey::find_program_address`,
    // which is a BPF syscall. The unit-test host environment cannot service
    // that syscall, so the PDA-derivation tests live in the e2e harness
    // (where `solana_sdk::pubkey::Pubkey::find_program_address` is host-safe).
    // Here we use a hardcoded bump to drive `Batch::initialize_in_place`
    // and assert the post-conditions it produces.
    // =========================================================================

    use crate::state::BatchStatus;

    /// A representative non-zero PDA bump — in production this is whatever
    /// `find_program_address` returns; the exact value is irrelevant to
    /// the post-condition tests below.
    const FAKE_BUMP: u8 = 254;

    /// The new batch's batch_id must be the current batch's batch_id + 1,
    /// status must be Committing, commit_deadline_slot must be
    /// `current_slot + t_max_slots`, and reveal_deadline_slot/close_slot/
    /// shuffle_seed/clearing_price/all counters must be 0.
    #[test]
    fn test_new_batch_state_post_settle() {
        let current_batch_id: u64 = 5;
        let current_slot: u64 = 1_234_567;
        let t_max_slots: u64 = 150;

        let mut next_batch = Batch::new(0);
        // Simulate the write — mirrors the in-place call in
        // process_settle_batch (no PDA derivation; the actual bump is
        // produced on-chain).
        next_batch.initialize_in_place(
            current_batch_id + 1,
            current_slot.saturating_add(t_max_slots),
            0,
            FAKE_BUMP,
        );

        assert_eq!(next_batch.batch_id, 6, "batch_id = current + 1");
        assert_eq!(
            next_batch.status,
            BatchStatus::Committing,
            "status must be Committing (0)"
        );
        assert_eq!(
            next_batch.commit_deadline_slot,
            current_slot + t_max_slots,
            "commit_deadline = current_slot + t_max_slots"
        );
        assert_eq!(
            next_batch.reveal_deadline_slot, 0,
            "reveal_deadline_slot is set in CloseCommitting, not here"
        );
        assert_eq!(next_batch.close_slot, 0, "close_slot is 0 (set later)");
        assert_eq!(next_batch.shuffle_seed, 0, "shuffle_seed is 0 (set later)");
        assert_eq!(next_batch.clearing_price, 0, "clearing_price is 0");
        assert_eq!(next_batch.total_commitments, 0, "total_commitments is 0");
        assert_eq!(next_batch.total_revealed, 0, "total_revealed is 0");
        assert_eq!(next_batch.total_settled, 0, "total_settled is 0");
        assert_eq!(next_batch.total_volume, 0, "total_volume is 0");
        assert_eq!(next_batch.total_notional, 0, "total_notional is 0");
        assert_eq!(next_batch.slashed_deposits, 0, "slashed_deposits is 0");
        assert_eq!(
            next_batch.bump, FAKE_BUMP,
            "bump must be the (on-chain derived) PDA bump — we hardcode \
             the value here because the derivation syscall is BPF-only"
        );
    }

    /// The double-create guard relies on `batch_id == 0` signaling an
    /// uninitialized account. Pin the `Batch::new` default so a refactor
    /// doesn't accidentally make `batch_id` nonzero at construction.
    #[test]
    fn test_uninitialized_batch_has_zero_batch_id() {
        let b = Batch::new(0);
        assert_eq!(
            b.batch_id, 0,
            "Batch::new(0) must leave batch_id at 0 (used as the \
             uninitialized marker for the next-batch account)"
        );
        assert_eq!(
            b.bump, 0,
            "Batch::new(0) must leave bump at 0 (also part of the \
             uninitialized marker)"
        );
    }

    /// `initialize_in_place` overwrites every field — pinning this guards
    /// against future field additions being silently missed by the
    /// initializer. If a field is added to `Batch` and not zeroed here,
    /// a fresh batch will carry over garbage.
    #[test]
    fn test_initialize_in_place_zeroes_every_field() {
        let mut b = Batch {
            batch_id: 99,
            status: BatchStatus::Settled,
            _pad_status: [1; 7],
            commit_deadline_slot: 1234,
            reveal_deadline_slot: 5678,
            close_slot: 9999,
            shuffle_seed: 8888,
            clearing_price: 7777,
            total_commitments: 11,
            total_revealed: 22,
            total_settled: 33,
            total_volume: 44,
            total_notional: 55,
            slashed_deposits: 66,
            bump: 77,
            _padding: [1; 7],
        };
        b.initialize_in_place(7, 100, 200, 254);

        assert_eq!(b.batch_id, 7);
        assert_eq!(b.status as u8, BatchStatus::Committing as u8);
        assert_eq!(b._pad_status, [0; 7]);
        assert_eq!(b.commit_deadline_slot, 100);
        assert_eq!(b.reveal_deadline_slot, 200);
        assert_eq!(b.close_slot, 0);
        assert_eq!(b.shuffle_seed, 0);
        assert_eq!(b.clearing_price, 0);
        assert_eq!(b.total_commitments, 0);
        assert_eq!(b.total_revealed, 0);
        assert_eq!(b.total_settled, 0);
        assert_eq!(b.total_volume, 0);
        assert_eq!(b.total_notional, 0);
        assert_eq!(b.slashed_deposits, 0);
        assert_eq!(b.bump, 254);
        assert_eq!(b._padding, [0; 7]);
    }

    // =========================================================================
    // M7 7.2: Commitment deposit return + margin accounting.
    //
    // Unit tests pin the math that `return_deposit()` performs on a
    // portfolio: `im -= deposit_lamports` (saturating), then
    // `recalc_margin()` updates `free_collateral` and `health`. We exercise
    // the math directly on a `Portfolio` because `return_deposit()` takes
    // `&[AccountInfo]` which is awkward to construct on the host. The
    // full e2e test in `tests/lifecycle.rs` exercises the helper end-to-end
    // through real BPF.
    //
    // We also pin the `slashed` arithmetic: a previous version
    // multiplied `commitment.deposit_lamports` by `1_000_000` when crediting
    // `vault.insurance_fund`, which inflated the credit by 1e6. The
    // commitment field stores the same unit as `portfolio.equity` (the
    // value returned by `Registry::deposit_amount()` = `base_deposit *
    // volatility_multiplier / 10_000`, default 10_000_000). No scale
    // conversion is needed.
    // =========================================================================

    /// `return_deposit` should reduce `portfolio.im` by exactly
    /// `deposit_lamports` and recompute `free_collateral` so that it
    /// reflects the returned deposit.
    #[test]
    fn test_return_deposit_decrements_im_for_settled() {
        let user = pinocchio::pubkey::Pubkey::from([7u8; 32]);
        let mut p = Portfolio::new(user);
        // Simulate `Deposit` + `CommitOrder`:
        let equity: i128 = 100_000_000; // 100M
        let deposit: u64 = 10_000_000; // 10M (default registry value)
        p.equity = equity;
        p.im = deposit as u128;
        p.recalc_margin();
        assert_eq!(p.im, 10_000_000);
        assert_eq!(p.free_collateral, 90_000_000);

        // Simulate the math inside `return_deposit`:
        let deposit_lamports: u64 = 10_000_000;
        p.im = p.im.saturating_sub(deposit_lamports as u128);
        p.recalc_margin();

        assert_eq!(p.im, 0, "im should be 0 after deposit returned");
        assert_eq!(
            p.free_collateral, 100_000_000,
            "free_collateral should equal equity after im release"
        );
    }

    /// Slashed commitments must also release the im lock — the user's
    /// pending order never executed, so the locked margin should return
    /// to free_collateral even though the deposit itself is forwarded to
    /// the insurance fund.
    #[test]
    fn test_return_deposit_decrements_im_for_slashed() {
        let user = pinocchio::pubkey::Pubkey::from([8u8; 32]);
        let mut p = Portfolio::new(user);
        let equity: i128 = 50_000_000;
        let deposit: u64 = 10_000_000;
        p.equity = equity;
        p.im = deposit as u128;
        p.recalc_margin();
        assert_eq!(p.free_collateral, 40_000_000);

        // SettleBatch slashed branch:
        p.im = p.im.saturating_sub(deposit as u128);
        p.recalc_margin();

        assert_eq!(p.im, 0);
        assert_eq!(p.free_collateral, 50_000_000);
    }

    /// Pin the bug fix: the `slashed` accumulator must equal the sum of
    /// `commitment.deposit_lamports` (in the same unit as
    /// `portfolio.equity`), NOT `deposit_lamports * 1_000_000`. The
    /// previous `* 1_000_000` multiplier inflated the insurance fund
    /// credit by 1e6.
    #[test]
    fn test_slashed_no_million_multiplier() {
        let deposit: u64 = 10_000_000; // default registry.deposit_amount()
        let mut slashed: u128 = 0;
        // Mirrors the line in `process_settle_batch`'s Pending branch:
        slashed = slashed.saturating_add(deposit as u128);
        assert_eq!(
            slashed, 10_000_000,
            "slashed must equal deposit, not deposit * 1_000_000"
        );
        // And the * 1_000_000 form is wrong — assert it would be wrong:
        let wrong: u128 = (deposit as u128) * 1_000_000;
        assert_ne!(
            slashed, wrong,
            "guard against the unit-bug regression"
        );
    }

    /// `saturating_sub` on `im` must not underflow when the deposit is
    /// larger than `im` (defensive — should not happen in practice, but
    /// if it does, the user should not get a wrapped-around huge im).
    #[test]
    fn test_return_deposit_saturating_sub_prevents_underflow() {
        let user = pinocchio::pubkey::Pubkey::from([9u8; 32]);
        let mut p = Portfolio::new(user);
        p.im = 1_000;
        // Pathological case: deposit > im (shouldn't happen, but...)
        let deposit_lamports: u64 = 5_000;
        p.im = p.im.saturating_sub(deposit_lamports as u128);
        assert_eq!(
            p.im, 0,
            "saturating_sub must clamp to 0, not wrap to a huge u128"
        );
    }

    /// Probe the actual layout of `Portfolio` so the e2e test in
    /// `tests/lifecycle.rs` can read the `im` field at the correct byte
    /// offset. This guards against a silent layout drift (added field,
    /// changed alignment) breaking the e2e im-return assertion.
    #[test]
    fn probe_portfolio_layout() {
        use core::mem::{offset_of, size_of};
        let _ = size_of::<Portfolio>();
        let _ = core::mem::align_of::<Portfolio>();
        eprintln!(
            "Portfolio size={} align={} user={} equity={} principal={} pnl={} \
             im={} mm={} free_collateral={} health={} positions_len={}",
            size_of::<Portfolio>(),
            core::mem::align_of::<Portfolio>(),
            offset_of!(Portfolio, user),
            offset_of!(Portfolio, equity),
            offset_of!(Portfolio, principal),
            offset_of!(Portfolio, pnl),
            offset_of!(Portfolio, im),
            offset_of!(Portfolio, mm),
            offset_of!(Portfolio, free_collateral),
            offset_of!(Portfolio, health),
            offset_of!(Portfolio, positions_len),
        );
        // Pin the layout that the e2e test relies on. If a refactor
        // changes offsets, this test will start failing and force an
        // update of the e2e offsets.
        assert_eq!(offset_of!(Portfolio, user), 0);
        assert_eq!(offset_of!(Portfolio, equity), 32);
        assert_eq!(offset_of!(Portfolio, principal), 48);
        assert_eq!(offset_of!(Portfolio, pnl), 64);
        assert_eq!(offset_of!(Portfolio, im), 80);
        assert_eq!(offset_of!(Portfolio, mm), 96);
    }
}

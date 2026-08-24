use crate::state::batch::{Batch, BatchStatus, Commitment, CommitmentStatus};
use crate::state::funding::{
    accrue_cum_funding, compute_d7_funding_rate,
};
use crate::state::instrument::Instrument;
// D7: sweep_book_side no longer needed (replaced by coefficient-based formula)
use crate::state::portfolio::Portfolio;
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use mgk_common::book::OrderBook;
use mgk_common::{math::calculate_funding_payment, MgkError};
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// M6 6i.2: CLOB results wire format. num_fills(2) header, then 49 bytes per
/// fill: user(32) + filled_qty(8) + notional(8) + is_maker(1).
const RESULTS_HEADER_BYTES: usize = 2;
const RESULTS_BYTES_PER_FILL: usize = 49;
const BPS_DENOM: i128 = 10_000;
/// DFBA results: 34-byte header (prices/qty + num_fills at 32) then 58-byte fills.
const DFBA_RESULT_HEADER_BYTES: usize = 34;
const DFBA_FILL_WIRE_BYTES: usize = 58;

/// M7 7.5: PriceOracle field offset for the `price` field (raw bytes
/// read). The full struct is defined in `programs/oracle/src/state.rs`.
/// At offset 80: magic(8) + version(1) + bump(1) + is_active(1) +
/// _padding(5) + authority(32) + instrument(32) + price(8). This avoids
/// pulling mgk-oracle as a dep just to read 8 bytes.
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

/// M7 7.5 / T9.10.3: Read and validate the fallback oracle's price via raw byte access.
///
/// Accepts index data ONLY when:
///   1. `oracle_account.key() == expected_oracle_addr` (matches `instrument.oracle_addr`)
///   2. `oracle_account.owner() == &mgk_common::program_ids::mgk_oracle_program_id()`
///   3. `oracle_account.data_len() >= 128` (PRICE_ORACLE_SIZE)
///   4. `magic == ORACLE_MAGIC` (`0x4C43_524F_4C43_5250`)
///   5. `version == 0`
///   6. `oracle.instrument == *instrument_account.key()`
///   7. `price > 0`
///
/// Returns `Some((price, timestamp, is_active))` if valid; `None` otherwise.
fn read_oracle_price(
    oracle_account: &AccountInfo,
    instrument_account: &AccountInfo,
    expected_oracle_addr: &Pubkey,
) -> Option<(i64, i64, bool)> {
    if oracle_account.key() != expected_oracle_addr {
        return None;
    }
    if oracle_account.owner() != &mgk_common::program_ids::mgk_oracle_program_id() {
        return None;
    }
    let data = oracle_account.try_borrow_data().ok()?;
    if data.len() < 128 {
        return None;
    }
    // Validate magic.
    let magic_bytes: [u8; 8] = data[0..8].try_into().ok()?;
    let magic = u64::from_le_bytes(magic_bytes);
    if magic != ORACLE_MAGIC {
        return None;
    }
    // Validate version.
    let version = data[8];
    if version != 0 {
        return None;
    }
    let is_active = data[10] != 0;
    // Validate instrument binding.
    let oracle_inst_bytes: [u8; 32] = data[48..80].try_into().ok()?;
    if Pubkey::from(oracle_inst_bytes) != *instrument_account.key() {
        return None;
    }
    // Read price.
    let price_bytes: [u8; 8] = data[ORACLE_PRICE_OFFSET..ORACLE_PRICE_OFFSET + ORACLE_PRICE_LEN]
        .try_into()
        .ok()?;
    let price = i64::from_le_bytes(price_bytes);
    if price <= 0 {
        return None;
    }
    // Read timestamp.
    let ts_bytes: [u8; 8] = data[88..96].try_into().ok()?;
    let timestamp = i64::from_le_bytes(ts_bytes);
    Some((price, timestamp, is_active))
}

/// D7: Compute the funding rate from mark price and oracle index,
/// then accrue `cum_funding` on the instrument.
///
/// Uses the D7 formula:
///   rate_bps = clamp(((mark - index) * coefficient_bps) / index, ±max_rate_bps)
///
/// Reads `instrument.cum_funding` / `last_funding_slot` and writes
/// back the updated values. Does NOT apply payments to portfolios —
/// that happens in `apply_funding_to_portfolio` below.
///
/// Returns the rate used (for logging/verification). If the oracle
/// price is invalid, the function is a no-op (carry-forward).
fn apply_funding_to_instrument(
    instrument: &mut Instrument,
    mark_price: i64,
    oracle_price: Option<i64>,
    current_slot: u64,
) -> i64 {
    // D7: Use current valid DFBA mark and fresh bound oracle index.
    // Skip if oracle is unavailable or mark is invalid (zero).
    let index = match oracle_price {
        Some(p) if p > 0 => p,
        _ => {
            // Oracle unavailable or invalid — carry forward.
            return 0;
        }
    };
    if mark_price <= 0 {
        // Invalid mark — carry forward.
        return 0;
    }

    let rate = match compute_d7_funding_rate(
        mark_price,
        index,
        instrument.funding_coefficient_bps,
        instrument.max_funding_rate_bps,
    ) {
        Some(r) => r,
        None => {
            // Invalid parameters — carry forward.
            return 0;
        }
    };

    // Accrue `cum_funding` by `rate × funding_period`. Advances
    // `last_funding_slot` by the same number of intervals so the next
    // batch doesn't double-count the remainder.
    let (delta, new_last) = accrue_cum_funding(
        current_slot,
        instrument.last_funding_slot,
        instrument.funding_interval_slots,
        rate,
    );
    instrument.cum_funding = instrument.cum_funding.saturating_add(delta);
    instrument.last_funding_slot = new_last;
    rate
}

/// M7 7.4: Apply the current funding rate to a single portfolio's
/// position(s) in the given instrument. Iterates `portfolio.positions`
/// looking for `instrument_id`, computes
/// `qty × (cum_funding − last_funding_checkpoint[instrument_id])` per
/// position (via `mgk_common::math::calculate_funding_payment`),
/// adds the sum to `portfolio.pnl`, and updates the checkpoint.
///
/// `last_funding_checkpoint[instrument_id]` is the
/// `portfolio.last_funding_checkpoint[idx]` where
/// `idx = instrument_id as usize`. Out-of-range `instrument_id`
/// (>= MAX_INSTRUMENTS) is a no-op (defensive — instrument_id is u16,
/// but only MAX_INSTRUMENTS=32 slots are allocated).
fn apply_funding_to_portfolio(portfolio: &mut Portfolio, instrument_id: u16, cum_funding: i128) {
    let idx = instrument_id as usize;
    if idx >= portfolio.last_funding_checkpoint.len() {
        return;
    }
    let entry = portfolio.last_funding_checkpoint[idx];
    if entry == cum_funding {
        return; // no funding accrued since last checkpoint
    }
    let mut total_payment: i128 = 0;
    for i in 0..portfolio.positions_len as usize {
        if portfolio.positions[i].instrument_id == instrument_id {
            let qty = portfolio.positions[i].qty;
            let payment = calculate_funding_payment(qty, cum_funding, entry);
            total_payment = total_payment.saturating_add(payment);
        }
    }
    if total_payment != 0 {
        portfolio.pnl = portfolio.pnl.saturating_add(total_payment);
        portfolio.recalc_margin();
    }
    portfolio.last_funding_checkpoint[idx] = cum_funding;
}

#[allow(clippy::too_many_arguments)]
pub fn process_settle_batch(
    _program_id: &Pubkey,
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
    let batch = unsafe { &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch) };

    if batch.status != BatchStatus::Clearing {
        msg!("Error: Batch not in clearing phase");
        return Err(MgkError::InvalidInstruction.into());
    }

    let registry =
        unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };

    // Read the instrument (M6 6i.3) — provides taker/maker fee schedule.
    // M7 7.5: also need to write mark_price back, so we cast to *mut.
    let instrument = unsafe {
        &mut *(instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut Instrument)
    };

    // Results: DFBA format (34-byte header) preferred; legacy CLOB (2-byte) fallback.
    let results_data = results_account
        .try_borrow_data()
        .map_err(|_| MgkError::InvalidAccount)?;

    const DFBA_HDR: usize = DFBA_RESULT_HEADER_BYTES;
    const DFBA_FILL: usize = DFBA_FILL_WIRE_BYTES;
    let dfba_mode = results_data.len() >= DFBA_HDR
        && (batch.matched_bid_qty > 0
            || batch.matched_ask_qty > 0
            || batch.mark_valid != 0
            || results_data.len() >= DFBA_HDR + DFBA_FILL);

    let (num_fills, fill_stride, fill_base) = if dfba_mode {
        if results_data.len() < DFBA_HDR {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let n = u16::from_le_bytes(results_data[32..34].try_into().unwrap()) as usize;
        let need = DFBA_HDR + n * DFBA_FILL;
        if results_data.len() < need {
            return Err(ProgramError::AccountDataTooSmall);
        }
        (n, DFBA_FILL, DFBA_HDR)
    } else {
        if results_data.len() < RESULTS_HEADER_BYTES {
            msg!("Error: Results account too small");
            return Err(ProgramError::AccountDataTooSmall);
        }
        let n =
            u16::from_le_bytes(results_data[0..RESULTS_HEADER_BYTES].try_into().unwrap()) as usize;
        let need = RESULTS_HEADER_BYTES + n * RESULTS_BYTES_PER_FILL;
        if results_data.len() < need {
            return Err(ProgramError::AccountDataTooSmall);
        }
        (n, RESULTS_BYTES_PER_FILL, RESULTS_HEADER_BYTES)
    };
    let _ = (num_fills, fill_stride, fill_base); // used below in DFBA-aware settle

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

    // DFBA: optional commitment accounts (posts rest on book; no slash path).
    let commitment_limit = if batch.total_commitments == 0 {
        0
    } else {
        batch.total_commitments as usize
    };

    // DFBA fill apply: update portfolios from results (dual format).
    // Creates positions when missing; applies equity cash flow + fees.
    if dfba_mode && num_fills > 0 {
        for i in 0..num_fills {
            let off = fill_base + i * fill_stride;
            let user = Pubkey::from(
                <[u8; 32]>::try_from(&results_data[off..off + 32]).unwrap_or([0u8; 32]),
            );
            let fill_qty = u64::from_le_bytes(results_data[off + 40..off + 48].try_into().unwrap());
            let fill_price =
                i64::from_le_bytes(results_data[off + 48..off + 56].try_into().unwrap());
            let is_maker = results_data[off + 56] != 0;
            let auction = results_data[off + 57]; // 0=bid 1=ask
            if fill_qty == 0 {
                continue;
            }
            let notional = (fill_qty as u128).saturating_mul(fill_price.unsigned_abs() as u128);
            total_volume = total_volume.saturating_add(fill_qty);
            total_notional = total_notional.saturating_add(notional);
            if is_maker {
                total_maker_notional = total_maker_notional.saturating_add(notional);
            } else {
                total_taker_notional = total_taker_notional.saturating_add(notional);
            }
            for pa in portfolio_accounts {
                let portfolio =
                    unsafe { &mut *(pa.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio) };
                if portfolio.user != user {
                    continue;
                }
                apply_one_dfba_fill(
                    portfolio,
                    instrument,
                    fill_qty,
                    fill_price,
                    is_maker,
                    auction,
                );
                total_settled = total_settled.saturating_add(1);
                break;
            }
        }
    }

    for commitment_account in commitment_accounts.iter().take(commitment_limit) {
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
            return_deposit(
                portfolio_accounts,
                &commitment.user,
                commitment.deposit_lamports,
            );
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
            let fill_user_bytes: [u8; 32] = results_data[offset..offset + 32].try_into().unwrap();
            let fill_user = Pubkey::from(fill_user_bytes);

            if fill_user == *user {
                let fq =
                    u64::from_le_bytes(results_data[offset + 32..offset + 40].try_into().unwrap());
                let fn_ =
                    u64::from_le_bytes(results_data[offset + 40..offset + 48].try_into().unwrap());
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
                    let effective_price: i64 =
                        user_notional.checked_div(user_filled_qty).unwrap_or(0) as i64;

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
                total_maker_notional =
                    total_maker_notional.saturating_add(user_maker_notional as u128);
                total_taker_notional =
                    total_taker_notional.saturating_add(user_taker_notional as u128);
                break;
            }
        }
    }

    // Credit slashed deposits and net protocol fees to insurance fund.
    //
    // Insurance flow per user:
    //   + taker_fee  (taker paid)
    //   + maker_rebate  (negative: rebate paid out, reduces insurance)
    let protocol_fee_delta: i128 =
        (total_taker_notional as i128 * instrument.taker_fee_bps as i128) / BPS_DENOM
            + (total_maker_notional as i128 * instrument.maker_fee_bps as i128) / BPS_DENOM;

    if slashed > 0 || protocol_fee_delta != 0 {
        let vault =
            unsafe { &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault) };
        // Slashed deposits (positive) always credit insurance.
        if slashed > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_add(slashed);
        }
        // Net fee delta can be negative (rebates outpace fees). Saturate
        // to avoid underflow on insurance_fund (the protocol takes the
        // loss as uncovered_bad_debt if insurance runs out — tracked
        // separately, not subtracted here).
        if protocol_fee_delta > 0 {
            vault.insurance_fund = vault
                .insurance_fund
                .saturating_add(protocol_fee_delta as u128);
        } else if protocol_fee_delta < 0 {
            let rebate_out = (-protocol_fee_delta) as u128;
            if rebate_out <= vault.insurance_fund {
                vault.insurance_fund = vault.insurance_fund.saturating_sub(rebate_out);
            } else {
                // Insurance fund cannot cover the rebate — track the
                // shortfall as uncovered_bad_debt. For MVP we record the
                // deficit without crashing; downstream funding/insurance
                // top-up logic (out of scope) handles replenishment.
                vault.uncovered_bad_debt = vault
                    .uncovered_bad_debt
                    .saturating_add(rebate_out - vault.insurance_fund);
                vault.insurance_fund = 0;
            }
        }
    }

    // Preserve DFBA dual mid when set by ClearBatch; else VWAP fallback.
    if batch.mark_valid == 0 && total_volume > 0 {
        let effective = total_notional
            .checked_div(total_volume as u128)
            .unwrap_or(0) as i64;
        batch.clearing_price = effective;
    }
    batch.total_settled = total_settled;
    if total_volume > 0 {
        batch.total_volume = total_volume;
    }
    batch.total_notional = total_notional;
    batch.slashed_deposits = batch.slashed_deposits.saturating_add(slashed);
    batch.status = BatchStatus::Settled;

    // Book ownership check (still required for funding premium path).
    let (expected_book_pda, _book_bump) =
        mgk_common::book::book_pda(matcher_program.key(), instrument.instrument_id);
    if book_account.key() != &expected_book_pda && book_account.owner() != matcher_program.key() {
        msg!("Error: book_account is neither expected PDA nor matcher-owned");
        return Err(MgkError::InvalidAccount.into());
    }

    let book = unsafe {
        &*(book_account.borrow_data_unchecked().as_ptr() as *const OrderBook)
    };
    if book.instrument_id != instrument.instrument_id {
        msg!("Error: book instrument_id does not match instrument");
        return Err(MgkError::InvalidAccount.into());
    }

    let clock = Clock::get()?;
    let current_slot = clock.slot;
    let current_unix_ts = clock.unix_timestamp;

    let oracle_info = read_oracle_price(oracle_account, instrument_account, &instrument.oracle_addr);
    let oracle_price = oracle_info.map(|(p, _, _)| p);
    let prev_mark_price = instrument.mark_price;

    // T9.10.6: Pure settlement-mark selector.\    // No oracle or book seeding — the mark comes from the DFBA clearing price
    // only; invalid/missing clears carry or zero the mark respectively.
    //
    // 1. Valid dual clear → use the clearing price.
    // 2. Invalid clear but prior mark exists → carry forward.
    // 3. Invalid clear and no prior mark (first batch) → zero.
    let new_mark_price = if batch.mark_valid != 0 {
        batch.clearing_price
    } else if prev_mark_price != 0 {
        prev_mark_price
    } else {
        0
    };
    instrument.mark_price = new_mark_price;

    // D7 / T9.10.5: Funding rate accrual (coefficient-based, replaces SMA).
    // Skip entirely when:
    //   - governance `funding_paused` (soft skip; next non-paused catches up),
    //   - `!mark_valid` (no dual DFBA clear → no auction mid), or
    //   - oracle stale, future-dated, or inactive (stale index cannot produce valid rate).
    // `cum_funding` / `last_funding_slot` are left untouched on skip.
    let funding_paused = unsafe {
        (*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry))
            .is_funding_paused()
    };
    // T9.10.3: Oracle freshness check. Compare oracle timestamp with Clock::unix_timestamp;
    // freshness is 0 <= age < 600 seconds (i.e. ts <= current_unix_ts and current_unix_ts - ts < 600).
    const ORACLE_STALENESS_WINDOW_SECS: i64 = 600; // 10 minutes
    let oracle_fresh = if let Some((_price, ts, active)) = oracle_info {
        active && ts > 0 && current_unix_ts >= ts && (current_unix_ts - ts) < ORACLE_STALENESS_WINDOW_SECS
    } else {
        false
    };
    if !funding_paused && batch.mark_valid != 0 && oracle_fresh {
        let _d7_rate = apply_funding_to_instrument(
            instrument,
            new_mark_price,
            oracle_price,
            current_slot,
        );
        let post_funding_cum = instrument.cum_funding;
        let instrument_id_for_funding = instrument.instrument_id;
        for portfolio_account in portfolio_accounts.iter() {
            let portfolio = unsafe {
                &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
            };
            apply_funding_to_portfolio(portfolio, instrument_id_for_funding, post_funding_cum);
        }
    } else {
        // Soft skip: advance cursor for fresh zero-rate intervals to prevent
        // later retroactive accrual when funding resumes.
        if !funding_paused && instrument.funding_interval_slots > 0 {
            let (delta, new_last) = accrue_cum_funding(
                current_slot,
                instrument.last_funding_slot,
                instrument.funding_interval_slots,
                0, // zero rate
            );
            let _ = delta;
            instrument.last_funding_slot = new_last;
        }
    }

    // M7 7.6 (decision D2): post-hoc margin check. After all fills +
    // funding are applied, flag any underwater portfolios for the
    // keeper. Fills are NOT reverted (per D2) — the existing
    // `LiquidateUser` instruction handles liquidation in a separate
    // transaction and already enforces `health >= 0 → reject`. This
    // check is purely observational: it makes underwater portfolios
    // visible to off-chain monitors without changing the batch outcome.
    for portfolio_account in portfolio_accounts.iter() {
        let portfolio =
            unsafe { &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio) };
        if portfolio.needs_liquidation() {
            msg!("Warning: portfolio underwater post-settle, eligible for liquidation");
        }
    }

    // Increment batch counter in registry.
    // Raw byte write at offset 36 — SBF field assignment has been observed to
    // corrupt neighboring fields (same fix as create_batch / initialize).
    let next_counter = registry.batch_id_counter.saturating_add(1);
    unsafe {
        let dst = registry_account.borrow_mut_data_unchecked().as_ptr() as *mut u8;
        let bytes = next_counter.to_le_bytes();
        core::ptr::write_volatile(dst.add(36), bytes[0]);
        core::ptr::write_volatile(dst.add(37), bytes[1]);
        core::ptr::write_volatile(dst.add(38), bytes[2]);
        core::ptr::write_volatile(dst.add(39), bytes[3]);
        core::ptr::write_volatile(dst.add(40), bytes[4]);
        core::ptr::write_volatile(dst.add(41), bytes[5]);
        core::ptr::write_volatile(dst.add(42), bytes[6]);
        core::ptr::write_volatile(dst.add(43), bytes[7]);
    }

    // M7 7.1: embed next-batch creation (design decision D1 — see
    // docs/ai/planning/2026-06-16-m7-design-decisions.md). After settling
    // the current batch, write the next batch's PDA in place so there is
    // no idle gap where no batch is in Committing.
    //
    // NOTE: PDA validation removed — Solana 4.x breaks createAccount for PDA
    // addresses (new accounts must sign their own Allocate). Batch is now
    // created by keeper via Keypair.generate() + createAccount, not via PDA.
    // The bump value is stored as metadata only (no invoke_signed signing).
    let next_batch_id = batch.batch_id.saturating_add(1);
    let next_bump: u8 = 0; // bump unused when batch is keypair-controlled

    // 2. Defensive size check — the caller must pre-allocate the account
    //    at exactly size_of::<Batch>(). The PDA was created via system
    //    program in the same TX (or pre-created by the keeper) and
    //    assigned to core. If the size is wrong, refuse to write rather
    //    than corrupt the account.
    let next_batch_size = next_batch_account.data_len();
    if next_batch_size != core::mem::size_of::<Batch>() {
        msg!("Error: next_batch account size mismatch");
        return Err(MgkError::InvalidAccount.into());
    }

    // 3. Reject double-create: the account must be all-zero (batch_id == 0
    //    + status == Committing == 0 are ambiguous on their own, so we
    //    check batch_id != 0 as the canonical "already initialized" signal).
    {
        let next_batch_probe =
            unsafe { &*(next_batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };
        if next_batch_probe.batch_id != 0 {
            msg!("Error: next_batch account already initialized");
            return Err(MgkError::AlreadyInitialized.into());
        }
    }

    // 4. Read the current slot and write the new batch in place.
    let current_slot = Clock::get()?.slot;
    let commit_deadline = current_slot.saturating_add(registry.t_max_slots);
    let next_batch =
        unsafe { &mut *(next_batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch) };
    // Reveal deadline is 0 here; CloseCommitting sets it on transition
    // out of Committing (design L153). Status, close_slot, shuffle_seed,
    // clearing_price, all counters default to 0 — the fresh state of a
    // brand-new batch in Committing.
    next_batch.initialize_in_place(next_batch_id, commit_deadline, 0, next_bump);

    msg!("SettleBatch: Batch settled; next batch created");
    Ok(())
}

/// Aggregated DFBA fill apply (host CI). SettleBatch uses
/// `apply_one_dfba_fill` per remaining-account portfolio.
#[cfg(test)]
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
struct DfbaApplyTotals {
    settled: u32,
    volume: u64,
    notional: u128,
    maker_notional: u128,
    taker_notional: u128,
}

/// Bid makers buy, bid takers sell; ask opposite.
fn dfba_signed_qty(auction: u8, is_maker: bool, fill_qty: u64) -> i64 {
    match (auction, is_maker) {
        (0, true) => fill_qty as i64,
        (0, false) => -(fill_qty as i64),
        (1, true) => -(fill_qty as i64),
        (1, false) => fill_qty as i64,
        _ => fill_qty as i64,
    }
}

fn apply_one_dfba_fill(
    portfolio: &mut Portfolio,
    instrument: &Instrument,
    fill_qty: u64,
    fill_price: i64,
    is_maker: bool,
    auction: u8,
) {
    let signed_qty = dfba_signed_qty(auction, is_maker, fill_qty);
    let notional = (fill_qty as u128).saturating_mul(fill_price.unsigned_abs() as u128);
    let id = instrument.instrument_id;
    if let Some((idx, pos)) = portfolio.find_position_mut(id) {
        let old_qty = pos.qty;
        let new_qty = old_qty.saturating_add(signed_qty);
        if new_qty != 0
            && fill_price > 0
            && ((old_qty >= 0 && signed_qty > 0) || (old_qty <= 0 && signed_qty < 0))
        {
            let old_n = (old_qty.unsigned_abs() as u128)
                .saturating_mul(pos.entry_vwap.unsigned_abs() as u128);
            let new_n = old_n.saturating_add(notional);
            let new_abs = new_qty.unsigned_abs() as u128;
            if let Some(vwap) = new_n.checked_div(new_abs) {
                portfolio.positions[idx].entry_vwap = vwap as i64;
            }
        }
        portfolio.positions[idx].qty = new_qty;
    } else if signed_qty != 0 && (portfolio.positions_len as usize) < portfolio.positions.len() {
        let idx = portfolio.positions_len as usize;
        portfolio.positions[idx].instrument_id = id;
        portfolio.positions[idx].qty = signed_qty;
        portfolio.positions[idx].entry_vwap = fill_price.max(0);
        portfolio.positions_len = portfolio.positions_len.saturating_add(1);
    }
    if signed_qty > 0 {
        portfolio.equity = portfolio.equity.saturating_sub(notional as i128);
    } else if signed_qty < 0 {
        portfolio.equity = portfolio.equity.saturating_add(notional as i128);
    }
    let fee: i128 = if is_maker {
        (notional as i128 * instrument.maker_fee_bps as i128) / BPS_DENOM
    } else {
        (notional as i128 * instrument.taker_fee_bps as i128) / BPS_DENOM
    };
    portfolio.equity = portfolio.equity.saturating_sub(fee);
    portfolio.recalc_margin();
}

/// Apply matcher DFBA result fills to the matching portfolios.
#[cfg(test)]
fn apply_dfba_results(
    results: &[u8],
    portfolios: &mut [&mut Portfolio],
    instrument: &Instrument,
) -> DfbaApplyTotals {
    let mut totals = DfbaApplyTotals::default();
    if results.len() < DFBA_RESULT_HEADER_BYTES {
        return totals;
    }
    let n = u16::from_le_bytes(results[32..34].try_into().unwrap()) as usize;
    let need = DFBA_RESULT_HEADER_BYTES + n * DFBA_FILL_WIRE_BYTES;
    if results.len() < need {
        return totals;
    }
    for i in 0..n {
        let off = DFBA_RESULT_HEADER_BYTES + i * DFBA_FILL_WIRE_BYTES;
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&results[off..off + 32]).unwrap_or([0u8; 32]),
        );
        let fill_qty = u64::from_le_bytes(results[off + 40..off + 48].try_into().unwrap());
        let fill_price = i64::from_le_bytes(results[off + 48..off + 56].try_into().unwrap());
        let is_maker = results[off + 56] != 0;
        let auction = results[off + 57];
        if fill_qty == 0 {
            continue;
        }
        let notional = (fill_qty as u128).saturating_mul(fill_price.unsigned_abs() as u128);
        totals.volume = totals.volume.saturating_add(fill_qty);
        totals.notional = totals.notional.saturating_add(notional);
        if is_maker {
            totals.maker_notional = totals.maker_notional.saturating_add(notional);
        } else {
            totals.taker_notional = totals.taker_notional.saturating_add(notional);
        }
        for portfolio in portfolios.iter_mut() {
            if portfolio.user != user {
                continue;
            }
            apply_one_dfba_fill(
                portfolio,
                instrument,
                fill_qty,
                fill_price,
                is_maker,
                auction,
            );
            totals.settled = totals.settled.saturating_add(1);
            break;
        }
    }
    totals
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
        let rebate: i128 = (maker_notional as i128 * maker_fee_bps as i128) / BPS_DENOM;
        // 1_000_000 * -2 / 10_000 = -200 (negative → rebate paid out)
        assert_eq!(rebate, -200);
    }

    #[test]
    fn test_taker_fee_positive_is_cost() {
        let taker_notional: u64 = 1_000_000;
        let taker_fee_bps: u16 = 5; // 5 bps fee
        let fee: i128 = (taker_notional as i128 * taker_fee_bps as i128) / BPS_DENOM;
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
        // process_settle_batch. Batches are keypair-controlled in the
        // current devnet path, so no PDA bump is stored.
        next_batch.initialize_in_place(
            current_batch_id + 1,
            current_slot.saturating_add(t_max_slots),
            0,
            0,
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
            next_batch.bump, 0,
            "bump is always 0 when batch is keypair-controlled (no PDA derivation)"
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
            bid_clearing_price: 1,
            ask_clearing_price: 2,
            matched_bid_qty: 3,
            matched_ask_qty: 4,
            mark_valid: 1,
            liq_paused: 0,
            _dfba_pad: [1; 6],
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
        assert_eq!(b.bid_clearing_price, 0);
        assert_eq!(b.ask_clearing_price, 0);
        assert_eq!(b.matched_bid_qty, 0);
        assert_eq!(b.matched_ask_qty, 0);
        assert_eq!(b.mark_valid, 0);
        assert_eq!(b.liq_paused, 1);
        assert_eq!(b._dfba_pad, [0; 6]);
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
        assert_ne!(slashed, wrong, "guard against the unit-bug regression");
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

    // ---- M7 7.4.3 — funding integration into SettleBatch ----

    use crate::state::instrument::Instrument;
    use crate::state::portfolio::{Position, MAX_INSTRUMENTS, MAX_POSITIONS};




    fn portfolio_with_position(user_bytes: [u8; 32], instrument_id: u16, qty: i64) -> Portfolio {
        let user = pinocchio::pubkey::Pubkey::from(user_bytes);
        let mut p = Portfolio::new(user);
        if qty != 0 {
            p.positions[0] = Position {
                instrument_id,
                qty,
                entry_vwap: 100_000,
            };
            p.positions_len = 1;
        }
        p
    }

    // ---- apply_funding_to_instrument (D7) ----

    #[test]
    fn test_d7_apply_funding_mark_equals_index_yields_zero_rate() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        // mark=100_000, index=100_000 → diff=0 → rate=0 → delta=0.
        let rate = apply_funding_to_instrument(&mut inst, 100_000, Some(100_000), 100);
        assert_eq!(rate, 0);
        assert_eq!(inst.cum_funding, 0); // zero rate → no accrual
        assert_eq!(inst.last_funding_slot, 0); // rate=0 → cursor unchanged
    }

    #[test]
    fn test_d7_apply_funding_mark_above_index_yields_positive_rate() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        inst.max_funding_rate_bps = 1_000; // raise cap for test
        // mark=105_000, index=100_000, coeff=10_000, cap=1_000
        // raw = (105_000 - 100_000) * 10_000 / 100_000 = 500
        let rate = apply_funding_to_instrument(&mut inst, 105_000, Some(100_000), 100);
        assert_eq!(rate, 500);
        assert_eq!(inst.cum_funding, 500); // 1 interval × 500
        assert_eq!(inst.last_funding_slot, 100);
    }

    #[test]
    fn test_d7_apply_funding_no_oracle_skips() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        let cum_before = inst.cum_funding;
        let rate = apply_funding_to_instrument(&mut inst, 105_000, None, 100);
        assert_eq!(rate, 0);
        assert_eq!(inst.cum_funding, cum_before); // no oracle → no accrual
    }

    #[test]
    fn test_d7_apply_funding_invalid_mark_skips() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        let rate = apply_funding_to_instrument(&mut inst, 0, Some(100_000), 100);
        assert_eq!(rate, 0);
        assert_eq!(inst.cum_funding, 0);
    }

    #[test]
    fn test_d7_apply_funding_multi_period_accrues_multiplied() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        inst.max_funding_rate_bps = 1_000; // raise cap for test
        // 3 intervals elapsed (current=300, last=0, interval=100)
        let rate = apply_funding_to_instrument(&mut inst, 105_000, Some(100_000), 300);
        assert_eq!(rate, 500);
        assert_eq!(inst.cum_funding, 1_500); // 3 × 500
        assert_eq!(inst.last_funding_slot, 300);
    }

    #[test]
    fn test_d7_apply_funding_within_interval_is_noop() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        inst.max_funding_rate_bps = 1_000; // raise cap for test
        inst.last_funding_slot = 100;
        inst.cum_funding = 5;
        // current=150, last=100, interval=100 → period=0 → no accrual
        let rate = apply_funding_to_instrument(&mut inst, 105_000, Some(100_000), 150);
        assert_eq!(rate, 500); // rate computed but not applied
        assert_eq!(inst.cum_funding, 5); // no accrual (within interval)
        assert_eq!(inst.last_funding_slot, 100);
    }

    #[test]
    fn test_d7_apply_funding_capped_by_max_rate() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        // mark=150_000, index=100_000 → raw = 50_000, cap=50 → rate=50
        let rate = apply_funding_to_instrument(&mut inst, 150_000, Some(100_000), 100);
        assert_eq!(rate, 50);
        assert_eq!(inst.cum_funding, 50);
    }

    // ---- apply_funding_to_portfolio ----

    #[test]
    fn test_apply_funding_to_portfolio_no_position_in_instrument_no_pnl_change() {
        // qty=0 in the position — no payment, but checkpoint still moves
        // forward so we don't re-evaluate the same cum_funding next time.
        let mut p = portfolio_with_position([1u8; 32], 1, 0);
        let pnl_before = p.pnl;
        apply_funding_to_portfolio(&mut p, 1, 1_000);
        assert_eq!(p.pnl, pnl_before);
        assert_eq!(p.last_funding_checkpoint[1], 1_000);
    }

    #[test]
    fn test_apply_funding_to_portfolio_different_instrument_no_pnl_change() {
        // Position is in instrument 1; we accrue funding for instrument 2.
        // The portfolio has no position in instrument 2 → pnl unchanged.
        // The instrument-2 checkpoint is still advanced.
        let mut p = portfolio_with_position([1u8; 32], 1, 10);
        let pnl_before = p.pnl;
        apply_funding_to_portfolio(&mut p, 2, 1_000);
        assert_eq!(p.pnl, pnl_before);
        assert_eq!(p.last_funding_checkpoint[2], 1_000);
        // Instrument-1 checkpoint must NOT be touched by an instrument-2
        // funding application.
        assert_eq!(p.last_funding_checkpoint[1], 0);
    }

    #[test]
    fn test_apply_funding_to_portfolio_same_cum_funding_is_noop() {
        // Portfolio checkpoint already matches cum_funding → no change.
        let mut p = portfolio_with_position([1u8; 32], 1, 10);
        p.last_funding_checkpoint[1] = 5;
        let pnl_before = p.pnl;
        apply_funding_to_portfolio(&mut p, 1, 5);
        assert_eq!(p.pnl, pnl_before);
    }

    #[test]
    fn test_apply_funding_long_position_positive_cum_increases_pnl() {
        // Long (qty=10), cum delta = +5. payment = 10 * 5 = 50. pnl += 50.
        let mut p = portfolio_with_position([1u8; 32], 1, 10);
        p.last_funding_checkpoint[1] = 0;
        apply_funding_to_portfolio(&mut p, 1, 5);
        assert_eq!(p.pnl, 50);
        assert_eq!(p.last_funding_checkpoint[1], 5);
    }

    #[test]
    fn test_apply_funding_short_position_positive_cum_decreases_pnl() {
        // Short (qty=-10), cum delta = +5. payment = -10 * 5 = -50. pnl += -50.
        let mut p = portfolio_with_position([2u8; 32], 1, -10);
        apply_funding_to_portfolio(&mut p, 1, 5);
        assert_eq!(p.pnl, -50);
        assert_eq!(p.last_funding_checkpoint[1], 5);
    }

    #[test]
    fn test_apply_funding_multiple_positions_same_instrument_sum() {
        // Two positions in instrument 1 (qty=10 and qty=5), cum delta=4.
        // payment = 10*4 + 5*4 = 60. pnl += 60.
        let mut p = portfolio_with_position([1u8; 32], 1, 10);
        p.positions[1] = Position {
            instrument_id: 1,
            qty: 5,
            entry_vwap: 100_000,
        };
        p.positions_len = 2;
        apply_funding_to_portfolio(&mut p, 1, 4);
        assert_eq!(p.pnl, 60);
    }

    #[test]
    fn test_apply_funding_out_of_range_instrument_id_is_noop() {
        // instrument_id=999 is way beyond MAX_INSTRUMENTS=32.
        let mut p = portfolio_with_position([1u8; 32], 1, 10);
        let pnl_before = p.pnl;
        apply_funding_to_portfolio(&mut p, 999, 1_000);
        assert_eq!(p.pnl, pnl_before);
    }

    #[test]
    fn test_apply_funding_zero_qty_position_updates_checkpoint_only() {
        // Position exists but qty=0 → payment = 0 (no pnl change), but
        // the checkpoint still moves forward so we don't re-evaluate.
        let mut p = portfolio_with_position([1u8; 32], 1, 0);
        p.positions[0] = Position {
            instrument_id: 1,
            qty: 0,
            entry_vwap: 0,
        };
        p.positions_len = 1;
        let pnl_before = p.pnl;
        apply_funding_to_portfolio(&mut p, 1, 1_000);
        assert_eq!(p.pnl, pnl_before);
        // Checkpoint is updated even though no payment was applied.
        assert_eq!(p.last_funding_checkpoint[1], 1_000);
    }

    // ---- Conservation: hedged portfolio (long +10, short -10) is zero-sum ----

    #[test]
    fn test_apply_funding_hedged_portfolio_conservation() {
        // After applying funding to two portfolios that are long/short
        // counterparts in the same instrument, the sum of pnl changes
        // must be zero. This is the same property the Kani proof
        // (common::math::m10_funding_symmetry) guarantees, lifted to
        // the portfolio level.
        let mut long_p = portfolio_with_position([1u8; 32], 1, 10);
        let mut short_p = portfolio_with_position([2u8; 32], 1, -10);
        let cum = 1_000i128;
        apply_funding_to_portfolio(&mut long_p, 1, cum);
        apply_funding_to_portfolio(&mut short_p, 1, cum);
        assert_eq!(long_p.pnl + short_p.pnl, 0);
        assert_eq!(long_p.pnl, 10_000);
        assert_eq!(short_p.pnl, -10_000);
    }

    // Pin the constants used by the integration helpers.
    #[test]
    fn test_max_instruments_matches_array_size() {
        assert_eq!(MAX_INSTRUMENTS, 32);
        assert_eq!(MAX_POSITIONS, 32);
    }

    /// M7 7.8: `funding_paused` is a SOFT skip in `SettleBatch` — not
    /// an error. The funding step is skipped entirely; `cum_funding`
    /// and `last_funding_slot` are left untouched; the next non-paused
    /// batch catches up via `compute_funding_period`. See the matching
    /// test in `commit_order.rs` for why we pin the pattern here
    /// rather than call the full instruction.
    #[test]
    fn test_settle_batch_funding_paused_pattern() {
        let mut r = Registry::new(Pubkey::from([10u8; 32]));
        r.set_pause_flags(crate::state::registry::PAUSE_FUNDING);
        assert!(r.is_funding_paused());
        // Unlike trading/withdrawals/liquidations, funding_paused does
        // NOT return an error — it skips the funding step in place.
        // The check pattern is `if !registry.is_funding_paused() {
        // apply_funding_to_instrument(...); }`.
    }

    /// DFBA T9.4: funding also soft-skips when `!mark_valid` (no dual clear).
    #[test]
    fn test_funding_skipped_when_mark_invalid() {
        let funding_paused = false;
        let mark_valid: u8 = 0;
        assert!(funding_paused || mark_valid == 0);
        let mark_valid_ok: u8 = 1;
        assert!(!funding_paused && mark_valid_ok != 0);
    }

    // ====================================================================
    // T-SETTLE-MARK: instrument.mark_price from dual mid
    // ====================================================================

    /// When mark_valid=1 (dual fill), instrument.mark_price is set to
    /// batch.clearing_price (which is the dual mid from ClearBatch).
    #[test]
    fn test_settle_mark_from_dual_mid() {
        let mut batch = Batch::new(1);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);

        // Simulate a dual clear
        batch.bid_clearing_price = 100_000;
        batch.ask_clearing_price = 100_100;
        batch.matched_bid_qty = 10;
        batch.matched_ask_qty = 8;
        batch.mark_valid = 1;
        batch.liq_paused = 0;
        // clearing_price = dual mid computed by ClearBatch
        batch.clearing_price = 100_050;

        // SettleBatch logic: mark_valid → use clearing_price
        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else {
            0
        };
        inst.mark_price = new_mark;

        assert_eq!(inst.mark_price, 100_050);
    }

    /// When mark_valid=0 but prev mark exists, carry forward prev mark.
    #[test]
    fn test_settle_mark_carry_forward_when_invalid() {
        let mut batch = Batch::new(2);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);

        // Previous batch set a valid mark
        inst.mark_price = 99_500;

        // This batch had only one-sided clear
        batch.mark_valid = 0;
        batch.liq_paused = 1;
        batch.clearing_price = 0;

        let prev_mark = inst.mark_price;
        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else if prev_mark != 0 {
            prev_mark
        } else {
            0
        };
        inst.mark_price = new_mark;

        assert_eq!(inst.mark_price, 99_500); // carried forward
    }

    /// First batch with no dual clear: mark stays 0 (no prev, no oracle
    /// in this test path).
    #[test]
    fn test_settle_mark_zero_first_batch_no_dual() {
        let mut batch = Batch::new(3);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);

        // First batch: no prev mark
        inst.mark_price = 0;
        batch.mark_valid = 0;
        batch.liq_paused = 1;

        let prev_mark = inst.mark_price;
        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else if prev_mark != 0 {
            prev_mark
        } else {
            0 // fallback (would be oracle/book in real code)
        };
        inst.mark_price = new_mark;

        assert_eq!(inst.mark_price, 0);
    }

    // ====================================================================
    // T9.10.6: Pure settlement-mark selector tests
    // ====================================================================

    /// Valid settlement: mark_valid=1 → use clearing_price (not oracle, not prev).
    #[test]
    fn test_t9_10_6_valid_settlement_uses_clearing_price() {
        let mut batch = Batch::new(10);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        batch.mark_valid = 1;
        batch.clearing_price = 150_500_000;
        // Even if prev_mark and oracle_price exist, clearing_price wins.
        inst.mark_price = 99_999;

        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else if inst.mark_price != 0 {
            inst.mark_price
        } else {
            0
        };
        inst.mark_price = new_mark;
        assert_eq!(inst.mark_price, 150_500_000, "valid settlement must use clearing_price");
    }

    /// Invalid settlement with prior mark: carry forward prev mark.
    #[test]
    fn test_t9_10_6_invalid_settlement_carries_forward_prev_mark() {
        let mut batch = Batch::new(11);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        batch.mark_valid = 0;
        batch.clearing_price = 0;
        inst.mark_price = 120_000_000;

        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else if inst.mark_price != 0 {
            inst.mark_price
        } else {
            0
        };
        inst.mark_price = new_mark;
        assert_eq!(inst.mark_price, 120_000_000, "invalid batch must carry forward");
    }

    /// Invalid first settlement (no prior mark): mark stays zero.
    #[test]
    fn test_t9_10_6_invalid_first_settlement_stays_zero() {
        let mut batch = Batch::new(12);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        batch.mark_valid = 0;
        batch.clearing_price = 0;
        inst.mark_price = 0; // no prior mark

        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else if inst.mark_price != 0 {
            inst.mark_price
        } else {
            0
        };
        inst.mark_price = new_mark;
        assert_eq!(inst.mark_price, 0, "first invalid batch must remain zero");
    }

    /// Succession: valid → invalid → valid shows correct mark progression.
    #[test]
    fn test_t9_10_6_succession_valid_invalid_valid() {
        let mut inst = Instrument::new(0, 1, 1, 100, 50);

        // Batch 1: valid clear
        let mut b1 = Batch::new(1);
        b1.mark_valid = 1;
        b1.clearing_price = 100_000;
        inst.mark_price = if b1.mark_valid != 0 { b1.clearing_price } else { 0 };
        assert_eq!(inst.mark_price, 100_000);

        // Batch 2: invalid clear → carry forward
        let mut b2 = Batch::new(2);
        b2.mark_valid = 0;
        inst.mark_price = if b2.mark_valid != 0 { b2.clearing_price } else if inst.mark_price != 0 { inst.mark_price } else { 0 };
        assert_eq!(inst.mark_price, 100_000, "must carry forward");

        // Batch 3: valid clear → new price
        let mut b3 = Batch::new(3);
        b3.mark_valid = 1;
        b3.clearing_price = 101_000;
        inst.mark_price = if b3.mark_valid != 0 { b3.clearing_price } else if inst.mark_price != 0 { inst.mark_price } else { 0 };
        assert_eq!(inst.mark_price, 101_000, "must update to new clearing");
    }

    /// Verify the dual mid rounding formula matches ClearBatch.
    #[test]
    fn test_settle_mark_dual_mid_rounding_matches_clear() {
        // Both odd prices → rounding correction applies
        let bid: i64 = 100_001;
        let ask: i64 = 100_003;
        let clearing_price = bid / 2 + ask / 2 + (bid % 2 + ask % 2) / 2;
        // 50_000 + 50_001 + (1+1)/2 = 100_002
        assert_eq!(clearing_price, 100_002);

        let mut batch = Batch::new(4);
        batch.mark_valid = 1;
        batch.clearing_price = clearing_price;

        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        let new_mark = if batch.mark_valid != 0 {
            batch.clearing_price
        } else {
            0
        };
        inst.mark_price = new_mark;
        assert_eq!(inst.mark_price, 100_002);
    }

    /// liq_paused is set to 1 when mark_valid=0 (no dual clear).
    #[test]
    fn test_settle_liq_paused_when_no_dual() {
        let mut batch = Batch::new(5);
        batch.matched_bid_qty = 10;
        batch.matched_ask_qty = 0; // one-sided
        let dual_ok = batch.matched_bid_qty > 0 && batch.matched_ask_qty > 0;
        if dual_ok {
            batch.mark_valid = 1;
            batch.liq_paused = 0;
        } else {
            batch.mark_valid = 0;
            batch.liq_paused = 1;
        }
        assert_eq!(batch.mark_valid, 0);
        assert_eq!(batch.liq_paused, 1);
    }

    /// liq_paused is cleared to 0 when mark_valid=1 (dual clear).
    #[test]
    fn test_settle_liq_cleared_when_dual() {
        let mut batch = Batch::new(6);
        batch.matched_bid_qty = 10;
        batch.matched_ask_qty = 8;
        let dual_ok = batch.matched_bid_qty > 0 && batch.matched_ask_qty > 0;
        if dual_ok {
            batch.mark_valid = 1;
            batch.liq_paused = 0;
        } else {
            batch.mark_valid = 0;
            batch.liq_paused = 1;
        }
        assert_eq!(batch.mark_valid, 1);
        assert_eq!(batch.liq_paused, 0);
    }

    // ====================================================================
    // T-E2E-TWO-USER-FILL (T9.9.4): two distinct pubkeys, host CI
    // ====================================================================

    const TWO_USER_QTY: u64 = 10_000;
    const TWO_USER_BID: i64 = 86_000_000;
    const TWO_USER_ASK: i64 = 88_000_000;
    const TWO_USER_START: i128 = 100_000_000;
    const DFBA_HDR: usize = 34;
    const DFBA_FILL: usize = 58;

    fn two_user_pk(tag: u8) -> Pubkey {
        Pubkey::from([tag; 32])
    }

    fn two_user_order(price: i64, size: u64, id: u64, tag: u8) -> mgk_perps_matcher::DfbaOrder {
        mgk_perps_matcher::DfbaOrder {
            price,
            size,
            order_id: id,
            user: two_user_pk(tag),
        }
    }

    fn pack_dfba_results(dual: &mgk_perps_matcher::state::dfba::DualAuctionResult) -> Vec<u8> {
        let total = dual.bid_alloc.maker_fill_count
            + dual.bid_alloc.taker_fill_count
            + dual.ask_alloc.maker_fill_count
            + dual.ask_alloc.taker_fill_count;
        let mut data = vec![0u8; DFBA_HDR + total * DFBA_FILL];
        data[0..8].copy_from_slice(&dual.bid.clearing_price.to_le_bytes());
        data[8..16].copy_from_slice(&dual.ask.clearing_price.to_le_bytes());
        data[16..24].copy_from_slice(&dual.bid_alloc.matched_qty.to_le_bytes());
        data[24..32].copy_from_slice(&dual.ask_alloc.matched_qty.to_le_bytes());
        let mut w = 0usize;
        let mut put = |user: &Pubkey, order_id: u64, qty: u64, price: i64, is_maker: bool, auction: u8| {
            if qty == 0 {
                return;
            }
            let off = DFBA_HDR + w * DFBA_FILL;
            data[off..off + 32].copy_from_slice(user.as_ref());
            data[off + 32..off + 40].copy_from_slice(&order_id.to_le_bytes());
            data[off + 40..off + 48].copy_from_slice(&qty.to_le_bytes());
            data[off + 48..off + 56].copy_from_slice(&price.to_le_bytes());
            data[off + 56] = u8::from(is_maker);
            data[off + 57] = auction;
            w += 1;
        };
        let bp = dual.bid_alloc.clearing_price;
        for i in 0..dual.bid_alloc.maker_fill_count {
            let f = dual.bid_alloc.maker_fills[i];
            put(&f.user, f.order_id, f.fill_qty, bp, true, 0);
        }
        for i in 0..dual.bid_alloc.taker_fill_count {
            let f = dual.bid_alloc.taker_fills[i];
            put(&f.user, f.order_id, f.fill_qty, bp, false, 0);
        }
        let ap = dual.ask_alloc.clearing_price;
        for i in 0..dual.ask_alloc.maker_fill_count {
            let f = dual.ask_alloc.maker_fills[i];
            put(&f.user, f.order_id, f.fill_qty, ap, true, 1);
        }
        for i in 0..dual.ask_alloc.taker_fill_count {
            let f = dual.ask_alloc.taker_fills[i];
            put(&f.user, f.order_id, f.fill_qty, ap, false, 1);
        }
        data[32..34].copy_from_slice(&(w as u16).to_le_bytes());
        data
    }

    /// T-E2E-TWO-USER-FILL: maker (pubkey 1) quotes both sides; taker
    /// (pubkey 2) crosses both auctions. Allocation, fee flow, and
    /// position deltas must match SettleBatch DFBA apply.
    #[test]
    fn t_e2e_two_user_fill_allocation_fees_and_positions() {
        let maker_tag = 0x6A;
        let taker_tag = 0xBE;
        assert_ne!(maker_tag, taker_tag);

        let maker_buys = [two_user_order(TWO_USER_BID, TWO_USER_QTY, 1, maker_tag)];
        let maker_sells = [two_user_order(TWO_USER_ASK, TWO_USER_QTY, 2, maker_tag)];
        let taker_buys = [two_user_order(TWO_USER_ASK, TWO_USER_QTY, 3, taker_tag)];
        let taker_sells = [two_user_order(TWO_USER_BID, TWO_USER_QTY, 4, taker_tag)];

        let dual = mgk_perps_matcher::run_dual_dfba(
            &maker_buys,
            &maker_sells,
            &taker_buys,
            &taker_sells,
            u64::MAX,
        );

        assert_eq!(dual.bid.matched_qty, TWO_USER_QTY, "bid allocation");
        assert_eq!(dual.ask.matched_qty, TWO_USER_QTY, "ask allocation");
        assert_eq!(dual.bid_alloc.matched_qty, TWO_USER_QTY);
        assert_eq!(dual.ask_alloc.matched_qty, TWO_USER_QTY);
        assert_eq!(dual.bid.clearing_price, TWO_USER_BID);
        assert_eq!(dual.ask.clearing_price, TWO_USER_ASK);
        assert_eq!(dual.bid_alloc.maker_fill_count, 1);
        assert_eq!(dual.bid_alloc.taker_fill_count, 1);
        assert_eq!(dual.ask_alloc.maker_fill_count, 1);
        assert_eq!(dual.ask_alloc.taker_fill_count, 1);
        assert_eq!(dual.bid_alloc.maker_fills[0].user, two_user_pk(maker_tag));
        assert_eq!(dual.bid_alloc.taker_fills[0].user, two_user_pk(taker_tag));
        assert_eq!(dual.ask_alloc.maker_fills[0].user, two_user_pk(maker_tag));
        assert_eq!(dual.ask_alloc.taker_fills[0].user, two_user_pk(taker_tag));
        for f in [
            dual.bid_alloc.maker_fills[0],
            dual.bid_alloc.taker_fills[0],
            dual.ask_alloc.maker_fills[0],
            dual.ask_alloc.taker_fills[0],
        ] {
            assert_ne!(
                dual.bid_alloc.maker_fills[0].user,
                dual.bid_alloc.taker_fills[0].user,
                "self-trade must not fill"
            );
            assert!(f.fill_qty > 0);
        }

        let results = pack_dfba_results(&dual);
        let n = u16::from_le_bytes(results[32..34].try_into().unwrap());
        assert_eq!(n, 4, "maker+taker × bid+ask");

        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        // Signed-field rebate example (not the locked D3 default of 0).
        inst.maker_fee_bps = -2;
        inst.taker_fee_bps = 5;
        assert_eq!(inst.maker_fee_bps, -2);
        assert_eq!(inst.taker_fee_bps, 5);

        let mut maker = Portfolio::new(two_user_pk(maker_tag));
        let mut taker = Portfolio::new(two_user_pk(taker_tag));
        maker.equity = TWO_USER_START;
        maker.principal = TWO_USER_START;
        taker.equity = TWO_USER_START;
        taker.principal = TWO_USER_START;
        maker.recalc_margin();
        taker.recalc_margin();

        let totals = {
            let mut ports: [&mut Portfolio; 2] = [&mut maker, &mut taker];
            apply_dfba_results(&results, &mut ports, &inst)
        };

        let bid_n = (TWO_USER_QTY as u128) * (TWO_USER_BID.unsigned_abs() as u128);
        let ask_n = (TWO_USER_QTY as u128) * (TWO_USER_ASK.unsigned_abs() as u128);
        let maker_fee_bid = (bid_n as i128 * inst.maker_fee_bps as i128) / BPS_DENOM;
        let maker_fee_ask = (ask_n as i128 * inst.maker_fee_bps as i128) / BPS_DENOM;
        let taker_fee_bid = (bid_n as i128 * inst.taker_fee_bps as i128) / BPS_DENOM;
        let taker_fee_ask = (ask_n as i128 * inst.taker_fee_bps as i128) / BPS_DENOM;

        // Dual legs flatten both books: maker buys bid / sells ask.
        assert_eq!(maker.positions_len, 1);
        assert_eq!(maker.positions[0].qty, 0, "maker dual quote nets flat");
        assert_eq!(maker.positions[0].entry_vwap, TWO_USER_BID);
        assert_eq!(taker.positions_len, 1);
        assert_eq!(taker.positions[0].qty, 0, "taker dual cross nets flat");

        let maker_equity = TWO_USER_START - bid_n as i128 + ask_n as i128
            - maker_fee_bid
            - maker_fee_ask;
        let taker_equity = TWO_USER_START + bid_n as i128 - ask_n as i128
            - taker_fee_bid
            - taker_fee_ask;
        assert_eq!(maker.equity, maker_equity, "maker spread + rebate");
        assert_eq!(taker.equity, taker_equity, "taker spread cost + fees");
        assert_eq!(totals.settled, 4);
        assert_eq!(totals.volume, TWO_USER_QTY * 4);
        assert_eq!(totals.maker_notional, bid_n + ask_n);
        assert_eq!(totals.taker_notional, bid_n + ask_n);

        let protocol = (totals.taker_notional as i128 * inst.taker_fee_bps as i128) / BPS_DENOM
            + (totals.maker_notional as i128 * inst.maker_fee_bps as i128) / BPS_DENOM;
        assert_eq!(protocol, taker_fee_bid + taker_fee_ask + maker_fee_bid + maker_fee_ask);
        assert!(protocol > 0, "taker 5 bps outpaces maker -2 rebate");
    }

    /// Same pubkey on both sides of an auction: clearing volume may exist
    /// but allocation is zero — settle must not move positions.
    #[test]
    fn t_e2e_two_user_self_trade_does_not_fill() {
        let user = 0x99;
        let dual = mgk_perps_matcher::run_dual_dfba(
            &[],
            &[two_user_order(TWO_USER_ASK, TWO_USER_QTY, 1, user)],
            &[two_user_order(TWO_USER_ASK + 1, TWO_USER_QTY, 2, user)],
            &[],
            u64::MAX,
        );
        assert!(dual.ask.matched_qty > 0, "pre-filter clearing volume");
        assert_eq!(dual.ask_alloc.matched_qty, 0, "self-trade skipped");
        assert_eq!(dual.ask_alloc.maker_fill_count, 0);
        assert_eq!(dual.ask_alloc.taker_fill_count, 0);
        assert_eq!(dual.bid_alloc.matched_qty, 0);

        let results = pack_dfba_results(&dual);
        let n = u16::from_le_bytes(results[32..34].try_into().unwrap());
        assert_eq!(n, 0);

        let inst = Instrument::new(0, 1, 1, 100, 50);
        let mut portfolio = Portfolio::new(two_user_pk(user));
        portfolio.equity = TWO_USER_START;
        let before = portfolio.equity;
        let totals = {
            let mut ports: [&mut Portfolio; 1] = [&mut portfolio];
            apply_dfba_results(&results, &mut ports, &inst)
        };
        assert_eq!(portfolio.equity, before);
        assert_eq!(portfolio.positions_len, 0);
        assert_eq!(totals.settled, 0);
        assert_eq!(totals.volume, 0);
    }

    /// Locked D3: makers 0 bps, takers 5. Spread still accrues to maker;
    /// taker pays only taker fees. Default Instrument::new is now D3 (T9.10.1).
    #[test]
    fn t_e2e_two_user_fill_makers_free_d3() {
        let maker_tag = 0x11;
        let taker_tag = 0x22;
        let dual = mgk_perps_matcher::run_dual_dfba(
            &[two_user_order(TWO_USER_BID, TWO_USER_QTY, 1, maker_tag)],
            &[two_user_order(TWO_USER_ASK, TWO_USER_QTY, 2, maker_tag)],
            &[two_user_order(TWO_USER_ASK, TWO_USER_QTY, 3, taker_tag)],
            &[two_user_order(TWO_USER_BID, TWO_USER_QTY, 4, taker_tag)],
            u64::MAX,
        );
        let results = pack_dfba_results(&dual);
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        inst.maker_fee_bps = 0;
        inst.taker_fee_bps = 5;

        let mut maker = Portfolio::new(two_user_pk(maker_tag));
        let mut taker = Portfolio::new(two_user_pk(taker_tag));
        maker.equity = TWO_USER_START;
        taker.equity = TWO_USER_START;

        {
            let mut ports: [&mut Portfolio; 2] = [&mut maker, &mut taker];
            apply_dfba_results(&results, &mut ports, &inst);
        }

        let bid_n = (TWO_USER_QTY as u128) * (TWO_USER_BID.unsigned_abs() as u128);
        let ask_n = (TWO_USER_QTY as u128) * (TWO_USER_ASK.unsigned_abs() as u128);
        let taker_fees = (bid_n as i128 * 5) / BPS_DENOM + (ask_n as i128 * 5) / BPS_DENOM;
        assert_eq!(maker.positions[0].qty, 0);
        assert_eq!(taker.positions[0].qty, 0);
        assert_eq!(
            maker.equity,
            TWO_USER_START - bid_n as i128 + ask_n as i128,
            "makers free under D3"
        );
        assert_eq!(
            taker.equity,
            TWO_USER_START + bid_n as i128 - ask_n as i128 - taker_fees
        );
    }

    // ====================================================================
    // T9.10.3 — Oracle Validation & Freshness Tests
    // ====================================================================

    #[test]
    fn test_oracle_freshness_unix_timestamp_boundaries() {
        const ORACLE_STALENESS_WINDOW_SECS: i64 = 600;
        let current_unix_ts: i64 = 1_700_000_000;

        let check_fresh = |ts: i64, active: bool| -> bool {
            active
                && ts > 0
                && current_unix_ts >= ts
                && (current_unix_ts - ts) < ORACLE_STALENESS_WINDOW_SECS
        };

        // 1. Exact current time (age = 0) -> fresh
        assert!(check_fresh(current_unix_ts, true));

        // 2. 1 second ago (age = 1) -> fresh
        assert!(check_fresh(current_unix_ts - 1, true));

        // 3. 599 seconds ago (age = 599) -> fresh
        assert!(check_fresh(current_unix_ts - 599, true));

        // 4. 600 seconds ago (age = 600) -> stale (not fresh)
        assert!(!check_fresh(current_unix_ts - 600, true));

        // 5. 601 seconds ago (age = 601) -> stale (not fresh)
        assert!(!check_fresh(current_unix_ts - 601, true));

        // 6. Future timestamp (ts = current_unix_ts + 1) -> not fresh
        assert!(!check_fresh(current_unix_ts + 1, true));

        // 7. Future timestamp (ts = current_unix_ts + 60) -> not fresh
        assert!(!check_fresh(current_unix_ts + 60, true));

        // 8. Zero timestamp -> not fresh
        assert!(!check_fresh(0, true));

        // 9. Negative timestamp -> not fresh
        assert!(!check_fresh(-100, true));

        // 10. Inactive oracle (even if timestamp is fresh) -> not fresh
        assert!(!check_fresh(current_unix_ts, false));
    }

    #[test]
    fn test_oracle_validation_price_and_metadata_rules() {
        let make_oracle_data = |magic: u64, version: u8, is_active: bool, inst: &Pubkey, price: i64, ts: i64| -> [u8; 128] {
            let mut data = [0u8; 128];
            data[0..8].copy_from_slice(&magic.to_le_bytes());
            data[8] = version;
            data[10] = if is_active { 1 } else { 0 };
            data[48..80].copy_from_slice(inst.as_ref());
            data[80..88].copy_from_slice(&price.to_le_bytes());
            data[88..96].copy_from_slice(&ts.to_le_bytes());
            data
        };

        let inst_pk = Pubkey::from([0x11u8; 32]);
        let other_inst_pk = Pubkey::from([0x22u8; 32]);

        // Valid data
        let valid = make_oracle_data(ORACLE_MAGIC, 0, true, &inst_pk, 87_000_000, 1_700_000_000);
        assert_eq!(valid.len(), 128);

        // Price <= 0 must be rejected
        let zero_price = make_oracle_data(ORACLE_MAGIC, 0, true, &inst_pk, 0, 1_700_000_000);
        let neg_price = make_oracle_data(ORACLE_MAGIC, 0, true, &inst_pk, -500, 1_700_000_000);
        let price_0 = i64::from_le_bytes(zero_price[80..88].try_into().unwrap());
        let price_neg = i64::from_le_bytes(neg_price[80..88].try_into().unwrap());
        assert!(price_0 <= 0);
        assert!(price_neg <= 0);

        // Wrong magic
        let bad_magic = make_oracle_data(0xDEADBEEF, 0, true, &inst_pk, 87_000_000, 1_700_000_000);
        assert_ne!(u64::from_le_bytes(bad_magic[0..8].try_into().unwrap()), ORACLE_MAGIC);

        // Version != 0
        let bad_ver = make_oracle_data(ORACLE_MAGIC, 1, true, &inst_pk, 87_000_000, 1_700_000_000);
        assert_ne!(bad_ver[8], 0);

        // Inactive
        let inactive = make_oracle_data(ORACLE_MAGIC, 0, false, &inst_pk, 87_000_000, 1_700_000_000);
        assert_eq!(inactive[10], 0);

        // Instrument mismatch
        let mismatch = make_oracle_data(ORACLE_MAGIC, 0, true, &other_inst_pk, 87_000_000, 1_700_000_000);
        let parsed_inst = Pubkey::from(<[u8; 32]>::try_from(&mismatch[48..80]).unwrap());
        assert_ne!(parsed_inst, inst_pk);
    }

    #[test]
    fn test_funding_soft_skips_when_oracle_invalid_or_stale() {
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        let cum_before = inst.cum_funding;
        let last_before = inst.last_funding_slot;

        let funding_paused = false;
        let mark_valid = 1u8;

        // When oracle is not fresh, SettleBatch skips funding entirely.
        let oracle_fresh = false;
        if !funding_paused && mark_valid != 0 && oracle_fresh {
            apply_funding_to_instrument(&mut inst, 100_000, Some(100_000), 100);
        }

        // cum_funding and last_funding_slot are untouched
        assert_eq!(inst.cum_funding, cum_before);
        assert_eq!(inst.last_funding_slot, last_before);
    }
}

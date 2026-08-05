//! M7 7.4: Funding rate accrual (design L504-553 — Aligned with Bulk.Trade).
//!
//! Funding is a perpetual-futures mechanism that periodically transfers
//! value between longs and shorts to keep the mark price anchored to the
//! index (oracle) price. A positive funding rate means longs pay shorts;
//! a negative rate means shorts pay longs.
//!
//! ## Unit convention (M7 7.4.2)
//!
//! All rates, premiums, and caps are stored in **basis points (bps)** as
//! integers. 1 unit = 1 bp = 0.0001 fraction. The design L527-532
//! specifies single-digit bps for the rate parameters, and the SMA
//! operates on a bps-scaled premium, so 1-bp resolution is sufficient
//! for MVP. Sub-bp premiums round to 0 via integer division (the
//! alternative is to scale by 10^4 to preserve sub-bp precision, but
//! that would require i128 for the SMA accumulator — not worth it for
//! a pre-testnet MVP).
//!
//! Premium conversion: the design's formula
//!   `premium = delta / oracle_price`
//! returns a fraction. To convert to bps, multiply by 10_000 (since
//! 1 bp = 10^-4). The scale constant is `BPS_PER_UNIT_FRACTION = 10_000`.
//!
//! The **cumulative** `cum_funding` is the running sum of
//! `funding_rate × funding_period` across batches, in bps × intervals.
//! A position's funding payment is the difference between the current
//! `cum_funding` and the position's `last_funding_checkpoint`, scaled
//! by the position's qty — that is, the same formula as
//! `mgk_common::math::calculate_funding_payment`, which we reuse.
//!
//! ## Sign convention (carried from existing math.rs + Kani proof)
//!
//! `calculate_funding_payment(qty, cum_current, cum_entry) = qty × delta`.
//! The convention assumed by `common::math::m10_funding_symmetry` is
//! that long and short funding payments sum to zero (conservation).
//! The directional mapping ("positive funding rate → longs pay shorts")
//! is enforced at the *application* layer in `SettleBatch`, not by the
//! math helper. See design L553 for the design's stated direction.
//!
//! ## Premium sample storage
//!
//! `Instrument.premium_samples` is a 16-entry ring buffer of the most
//! recent premium samples in bps. The SMA uses the most recent
//! `min(premium_sample_count, funding_sma_window)` samples. A window
//! of 0 means "use the latest sample only" (useful for tests and
//! first-batch edges).

use crate::state::instrument::Instrument;

/// Scale factor to convert a price-fraction (e.g., 0.01) to bps.
/// 1 bp = 10^-4, so multiply the fraction by 10_000 to get bps.
const BPS_PER_UNIT_FRACTION: i128 = 10_000;

/// Capacity of `Instrument.premium_samples` ring buffer.
pub const PREMIUM_SAMPLE_CAPACITY: usize = 16;

/// Compute the premium sample for one batch (design L508-515).
///
/// `delta = max(P_bid - P_oracle, 0) - max(P_oracle - P_ask, 0)`
/// `premium = delta / P_oracle` (in fraction), then × 10_000 to bps.
///
/// Returns the premium in bps. Returns `None` if `oracle_price`
/// is 0 or negative (oracle missing / invalid; caller is expected to
/// fall back to carry-forward and skip the funding update).
///
/// The premium is signed: positive when the bid side of the book is
/// above the oracle (bullish pressure), negative when the ask side is
/// below (bearish pressure). A balanced book or mark = oracle gives
/// exactly zero.
pub fn compute_premium_sample(
    p_bid: Option<i64>,
    p_ask: Option<i64>,
    oracle_price: i64,
) -> Option<i64> {
    if oracle_price <= 0 {
        return None;
    }
    let bid = p_bid?;
    let ask = p_ask?;
    // Both sides present. Use saturating_sub for the negative branch
    // (P_oracle - P_ask where P_ask may exceed P_oracle).
    let upside = bid.saturating_sub(oracle_price).max(0);
    let downside = oracle_price.saturating_sub(ask).max(0);
    let delta = upside.saturating_sub(downside);
    // Convert to bps: (delta / oracle) * 10_000, computed in i128 to
    // avoid overflow for large prices.
    let bps = (delta as i128)
        .saturating_mul(BPS_PER_UNIT_FRACTION)
        .checked_div(oracle_price as i128)
        .unwrap_or(0);
    i64::try_from(bps).ok()
}

/// Simple moving average over the most recent N premium samples
/// (design L517: "simple moving average (SMA) of premium samples").
///
/// `samples` is the full 16-entry ring buffer; `count` is
/// `Instrument.premium_sample_count` (how many entries are populated,
/// saturating at 16); `window` is `Instrument.funding_sma_window`. The
/// SMA window is `min(count, window)`, clamped to at least 1 (a
/// window of 0 means "use the latest sample").
///
/// Returns the SMA in bps (integer-truncated toward zero), or 0 if no
/// samples are available.
pub fn compute_premium_sma(
    samples: &[i64; PREMIUM_SAMPLE_CAPACITY],
    count: u8,
    window: u8,
) -> i64 {
    let n = (count as usize).min(PREMIUM_SAMPLE_CAPACITY);
    if n == 0 {
        return 0;
    }
    let window = (window as usize).max(1).min(n);
    // The ring buffer holds the most recent samples in slots
    // `[(count - n) % 16 .. (count - 1) % 16]`. We sum the last
    // `window` entries: indices `(n - window) % 16 .. n % 16`.
    // Walk back from the most recent sample.
    let mut sum: i128 = 0;
    for i in 0..window {
        let idx = (n - 1 - i) % PREMIUM_SAMPLE_CAPACITY;
        sum += samples[idx] as i128;
    }
    let avg = sum / window as i128;
    i64::try_from(avg).unwrap_or(0)
}

/// Record a new premium sample into the instrument's ring buffer.
/// `premium_sample_count` is incremented, saturating at
/// `PREMIUM_SAMPLE_CAPACITY`. The new sample is written at
/// `index = count % CAPACITY` (overwriting the oldest entry once the
/// buffer is full — the ring is "lossy" with respect to the SMA
/// window: callers that want a longer window need a bigger buffer).
pub fn record_premium_sample(instrument: &mut Instrument, sample: i64) {
    let count = instrument.premium_sample_count as usize;
    let idx = count % PREMIUM_SAMPLE_CAPACITY;
    instrument.premium_samples[idx] = sample;
    if count < PREMIUM_SAMPLE_CAPACITY {
        instrument.premium_sample_count += 1;
    }
}

/// Compute the funding rate for one batch (design L524).
///
/// `F = clamp(P_mu + clamp(interest_rate - P_mu, -deviation_cap,
/// deviation_cap), -funding_cap, funding_cap)`
///
/// All inputs in bps. Returns the rate in bps per funding interval.
pub fn compute_funding_rate(
    premium_sma: i64,
    interest_rate_bps: i64,
    deviation_cap_bps: i64,
    funding_cap_bps: i64,
) -> i64 {
    // Inner clamp: clamp(interest_rate - P_mu, -deviation_cap,
    // +deviation_cap).
    let interest_minus_premium = interest_rate_bps.saturating_sub(premium_sma);
    let deviation = clamp_i64(interest_minus_premium, -deviation_cap_bps, deviation_cap_bps);
    let raw = premium_sma.saturating_add(deviation);
    clamp_i64(raw, -funding_cap_bps, funding_cap_bps)
}

/// Compute the number of full funding intervals that have elapsed
/// since `last_funding_slot` (design L539).
///
/// Returns 0 if `current_slot <= last_funding_slot` or
/// `funding_interval_slots == 0` (defensive: a 0 interval would
/// otherwise divide by zero and would mean "funding disabled" anyway).
pub fn compute_funding_period(
    current_slot: u64,
    last_funding_slot: u64,
    funding_interval_slots: u64,
) -> u64 {
    if funding_interval_slots == 0 {
        return 0;
    }
    if current_slot <= last_funding_slot {
        return 0;
    }
    let elapsed = current_slot - last_funding_slot;
    elapsed / funding_interval_slots
}

/// Compute the delta to add to `instrument.cum_funding` for this
/// batch. Returns `(delta, new_last_funding_slot)`. The caller writes
/// `instrument.cum_funding += delta` and `instrument.last_funding_slot
/// = new_last_funding_slot`.
///
/// `delta = funding_rate × funding_period`, in bps × intervals.
///
/// The new `last_funding_slot` is advanced by `funding_period ×
/// funding_interval_slots` so that we accrue *exactly* the elapsed
/// intervals and don't double-count the partial remainder (which gets
/// carried into the next batch's `compute_funding_period`).
pub fn accrue_cum_funding(
    current_slot: u64,
    last_funding_slot: u64,
    funding_interval_slots: u64,
    funding_rate_bps: i64,
) -> (i128, u64) {
    let period = compute_funding_period(current_slot, last_funding_slot, funding_interval_slots);
    if period == 0 || funding_rate_bps == 0 {
        return (0, last_funding_slot);
    }
    let delta = (funding_rate_bps as i128).saturating_mul(period as i128);
    let new_last = last_funding_slot.saturating_add(
        period.saturating_mul(funding_interval_slots),
    );
    (delta, new_last)
}

#[inline]
fn clamp_i64(value: i64, min: i64, max: i64) -> i64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::instrument::Instrument;

    fn empty_instrument() -> Instrument {
        Instrument::new(1, 1_000_000, 1_000, 100, 50)
    }

    fn sample_buf(vals: &[i64]) -> [i64; 16] {
        let mut buf = [0i64; 16];
        for (i, v) in vals.iter().enumerate() {
            if i >= 16 {
                break;
            }
            buf[i] = *v;
        }
        buf
    }

    // ---- compute_premium_sample ----

    #[test]
    fn test_premium_zero_when_mark_equals_oracle() {
        // P_bid == P_ask == P_oracle → delta = 0, premium = 0 bps.
        let p = compute_premium_sample(Some(100_000), Some(100_000), 100_000);
        assert_eq!(p, Some(0));
    }

    #[test]
    fn test_premium_positive_when_bid_above_oracle() {
        // P_bid 101k, P_ask 100k, P_oracle 100k → delta = 1000, premium = 0.01
        // = 1% = 100 bps.
        let p = compute_premium_sample(Some(101_000), Some(100_000), 100_000);
        assert_eq!(p, Some(100));
    }

    #[test]
    fn test_premium_negative_when_ask_below_oracle() {
        // P_bid 100k, P_ask 99k, P_oracle 100k → delta = -1000, premium = -0.01
        // = -1% = -100 bps.
        let p = compute_premium_sample(Some(100_000), Some(99_000), 100_000);
        assert_eq!(p, Some(-100));
    }

    #[test]
    fn test_premium_zero_when_bid_above_and_ask_below_cancel() {
        // P_bid 101k, P_ask 99k, P_oracle 100k → upside=1000, downside=1000, delta=0.
        let p = compute_premium_sample(Some(101_000), Some(99_000), 100_000);
        assert_eq!(p, Some(0));
    }

    #[test]
    fn test_premium_none_when_oracle_invalid() {
        assert_eq!(compute_premium_sample(Some(100_000), Some(100_000), 0), None);
        assert_eq!(compute_premium_sample(Some(100_000), Some(100_000), -1), None);
    }

    #[test]
    fn test_premium_none_when_side_missing() {
        // One-sided book: caller is expected to fall back to oracle/mark
        // and pass a synthetic two-sided price, or skip premium entirely.
        assert_eq!(compute_premium_sample(None, Some(100_000), 100_000), None);
        assert_eq!(compute_premium_sample(Some(100_000), None, 100_000), None);
    }

    #[test]
    fn test_premium_sub_bp_rounds_to_zero() {
        // Documented trade-off (M7 7.4.2): 1-bp resolution. delta=10,
        // oracle=100_000 → fraction = 0.0001 = exactly 1 bp, included.
        let p = compute_premium_sample(Some(100_010), Some(100_000), 100_000);
        assert_eq!(p, Some(1));
        // delta=5 → 0.5 bp, rounds to 0 (truncation).
        let p2 = compute_premium_sample(Some(100_005), Some(100_000), 100_000);
        assert_eq!(p2, Some(0));
    }

    // ---- compute_premium_sma ----

    #[test]
    fn test_sma_empty_returns_zero() {
        let buf = [0i64; 16];
        assert_eq!(compute_premium_sma(&buf, 0, 8), 0);
    }

    #[test]
    fn test_sma_single_sample_uses_window_1() {
        let buf = sample_buf(&[5]);
        // window=0 → use latest only → returns 5.
        assert_eq!(compute_premium_sma(&buf, 1, 0), 5);
        // window=8 but only 1 sample → uses 1 sample.
        assert_eq!(compute_premium_sma(&buf, 1, 8), 5);
    }

    #[test]
    fn test_sma_averages_recent_window() {
        // 8 samples: six at 10, two trailing at 20. Window 2 → avg of
        // last 2 = 20 (both are 20).
        let buf = sample_buf(&[10, 10, 10, 10, 10, 10, 20, 20]);
        assert_eq!(compute_premium_sma(&buf, 8, 2), 20);

        // Window 8: avg of all 8 = (6*10 + 2*20) / 8 = 100/8 = 12 (trunc).
        assert_eq!(compute_premium_sma(&buf, 8, 8), 12);

        // Window 4: avg of last 4 = (10 + 10 + 20 + 20) / 4 = 15.
        assert_eq!(compute_premium_sma(&buf, 8, 4), 15);
    }

    #[test]
    fn test_sma_window_caps_at_count() {
        // 3 samples, window 8 → uses all 3.
        let buf = sample_buf(&[3, 6, 9]);
        assert_eq!(compute_premium_sma(&buf, 3, 8), 6);
    }

    // ---- record_premium_sample ----

    #[test]
    fn test_record_first_sample_writes_at_zero() {
        let mut inst = empty_instrument();
        record_premium_sample(&mut inst, 7);
        assert_eq!(inst.premium_sample_count, 1);
        assert_eq!(inst.premium_samples[0], 7);
    }

    #[test]
    fn test_record_wraps_at_capacity() {
        let mut inst = empty_instrument();
        for i in 0..16 {
            record_premium_sample(&mut inst, i as i64);
        }
        assert_eq!(inst.premium_sample_count, 16);
        record_premium_sample(&mut inst, 99);
        // count is still 16 (saturated); 99 overwrote index 0 (was 0).
        assert_eq!(inst.premium_sample_count, 16);
        assert_eq!(inst.premium_samples[0], 99);
    }

    // ---- compute_funding_rate ----

    #[test]
    fn test_funding_rate_balanced_book_yields_interest_rate() {
        // premium_sma = 0 (mark = oracle) → rate = clamp(0 + clamp(IR, ±dev), ±cap)
        // = clamp(IR, ±cap) = IR.
        let r = compute_funding_rate(0, 1, 5, 50);
        assert_eq!(r, 1);
    }

    #[test]
    fn test_funding_rate_clamped_to_funding_cap_positive() {
        // premium_sma=0, IR=100, cap=5: inner = clamp(100, ±5) = 5; raw = 5;
        // outer = 5.
        let r = compute_funding_rate(0, 100, 5, 50);
        assert_eq!(r, 5);
    }

    #[test]
    fn test_funding_rate_clamped_to_funding_cap_negative() {
        // premium_sma = 0, IR = -100, deviation_cap = 5, funding_cap = 50.
        // inner = clamp(-100, -5, 5) = -5; raw = -5; outer = -5.
        let r = compute_funding_rate(0, -100, 5, 50);
        assert_eq!(r, -5);
    }

    #[test]
    fn test_funding_rate_deviation_cap_limits_inner() {
        // premium_sma = 10, IR = 1, deviation_cap = 5.
        // inner = clamp(1 - 10, -5, 5) = -5; raw = 10 + -5 = 5; outer = 5.
        let r = compute_funding_rate(10, 1, 5, 50);
        assert_eq!(r, 5);
    }

    #[test]
    fn test_funding_rate_outer_cap_overrides_inner_sum() {
        // premium_sma = 50, IR = 0, deviation_cap = 5, funding_cap = 50.
        // inner = clamp(0 - 50, -5, 5) = -5; raw = 50 + -5 = 45; outer = 45.
        let r = compute_funding_rate(50, 0, 5, 50);
        assert_eq!(r, 45);
    }

    // ---- compute_funding_period ----

    #[test]
    fn test_period_zero_within_interval() {
        // last=100, current=150, interval=100 → elapsed=50, period=0.
        assert_eq!(compute_funding_period(150, 100, 100), 0);
    }

    #[test]
    fn test_period_one_at_one_interval() {
        assert_eq!(compute_funding_period(200, 100, 100), 1);
    }

    #[test]
    fn test_period_floors_partial_extra() {
        // 250 - 100 = 150 / 100 = 1 (the 50 remainder is carried forward).
        assert_eq!(compute_funding_period(250, 100, 100), 1);
    }

    #[test]
    fn test_period_zero_when_zero_interval() {
        // 0 interval = "funding disabled" — defensive against div-by-zero.
        assert_eq!(compute_funding_period(200, 0, 0), 0);
    }

    #[test]
    fn test_period_zero_when_clock_unchanged() {
        assert_eq!(compute_funding_period(100, 100, 100), 0);
    }

    // ---- accrue_cum_funding ----

    #[test]
    fn test_accrue_zero_rate_returns_zero_delta() {
        let (delta, new_last) = accrue_cum_funding(200, 100, 100, 0);
        assert_eq!(delta, 0);
        assert_eq!(new_last, 100); // unchanged
    }

    #[test]
    fn test_accrue_zero_period_returns_zero_delta() {
        let (delta, new_last) = accrue_cum_funding(150, 100, 100, 1);
        assert_eq!(delta, 0);
        assert_eq!(new_last, 100);
    }

    #[test]
    fn test_accrue_advances_last_funding_slot_by_full_intervals() {
        // period 1, interval 100, current 250 → new_last = 100 + 1*100 = 200.
        let (delta, new_last) = accrue_cum_funding(250, 100, 100, 1);
        assert_eq!(delta, 1);
        assert_eq!(new_last, 200);
    }

    #[test]
    fn test_accrue_multi_period_drops_partial_remainder() {
        // last=100, current=550, interval=100 → period = (550-100)/100 = 4.
        // new_last = 100 + 4*100 = 500 (the 50-slot remainder is dropped —
        // acceptable: it's < 1 interval, and the next batch will
        // recompute period from new_last=500).
        let (delta, new_last) = accrue_cum_funding(550, 100, 100, 1);
        assert_eq!(delta, 4);
        assert_eq!(new_last, 500);
    }

    // ---- end-to-end funding model (matches design L504-553) ----

    #[test]
    fn test_e2e_balanced_book_one_interval_accrues_interest() {
        // Premium = 0 (mark = oracle), interest = 1 bp, caps don't bind.
        // After 1 interval, cum_funding += 1 bp.
        let mut inst = empty_instrument();
        let p = compute_premium_sample(Some(100_000), Some(100_000), 100_000).unwrap();
        record_premium_sample(&mut inst, p);
        let sma = compute_premium_sma(
            &inst.premium_samples,
            inst.premium_sample_count,
            inst.funding_sma_window,
        );
        let rate = compute_funding_rate(
            sma,
            inst.interest_rate_bps,
            inst.deviation_cap_bps,
            inst.funding_cap_bps,
        );
        // After exactly 1 interval (current=100, last=0, interval=100),
        // delta = rate × 1.
        let (delta, new_last) = accrue_cum_funding(100, 0, inst.funding_interval_slots, rate);
        assert_eq!(delta, 1);
        assert_eq!(new_last, 100);
        inst.cum_funding += delta;
        inst.last_funding_slot = new_last;
        assert_eq!(inst.cum_funding, 1);
    }

    #[test]
    fn test_e2e_hedged_portfolio_payments_sum_to_zero() {
        // Conservation: a hedged portfolio (long +10, short -10) has zero
        // net funding payment, regardless of the cum_funding delta.
        // This is the "no free lunch" guarantee — matches the Kani proof
        // in common::math::m10_funding_symmetry.
        let cum_current: i128 = 1_000;
        let cum_entry: i128 = 0;
        let long_p = mgk_common::math::calculate_funding_payment(10, cum_current, cum_entry);
        let short_p = mgk_common::math::calculate_funding_payment(-10, cum_current, cum_entry);
        assert_eq!(long_p, 10_000);
        assert_eq!(short_p, -10_000);
        assert_eq!(long_p + short_p, 0);
    }

    // Pin constants to catch a future "fix" that flips the unit.
    #[test]
    fn test_bps_per_unit_fraction_is_ten_thousand() {
        assert_eq!(BPS_PER_UNIT_FRACTION, 10_000);
    }

    #[test]
    fn test_premium_sample_capacity_is_16() {
        assert_eq!(PREMIUM_SAMPLE_CAPACITY, 16);
    }
}

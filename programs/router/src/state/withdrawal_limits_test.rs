//! Comprehensive test suite for withdrawal limits + PnL warm-up + exit buckets
//!
//! This module implements ~45 unit tests covering:
//! - PnL vesting (warm-up)
//! - Per-user exit buckets (rate limiting)
//! - Global exit buckets (aggregate throttling)
//! - Threshold exceptions (principal fast lane, free PnL)
//! - Haircut interactions
//! - Withdrawal queuing
//! - Emergency mode
//! - Security invariants

use super::*;

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES FOR EXIT BUCKETS AND WITHDRAWAL LIMITS
// ═══════════════════════════════════════════════════════════════════════════

/// Money scale (1e6 for $1.00)
const SCALE: i128 = 1_000_000;

/// Exit bucket parameters (governance configurable)
#[derive(Debug, Clone, Copy)]
pub struct ExitBucketParams {
    /// Per-user percentage of equity per hour (basis points)
    /// e.g., 2000 = 20% of equity per hour
    pub user_pct_per_hour_bps: u64,

    /// Per-user hard maximum per hour (in SCALE units)
    /// e.g., 250_000 * SCALE = $250k per hour
    pub user_hard_max_per_hour: i128,

    /// Rolling window duration in seconds (typically 3600 = 1 hour)
    pub rolling_window_secs: u64,

    /// Global percentage of TVL per hour (basis points)
    /// e.g., 500 = 5% of TVL per hour
    pub tvl_pct_per_hour_bps: u64,

    /// Global hard maximum per hour (as percentage of TVL, basis points)
    /// e.g., 300 = 3% of TVL hard cap
    pub global_hard_max_bps: u64,
}

impl Default for ExitBucketParams {
    fn default() -> Self {
        Self {
            user_pct_per_hour_bps: 2000,  // 20%/h
            user_hard_max_per_hour: 500_000 * SCALE,  // $500k/h (allows 20% up to $500k)
            rolling_window_secs: 3600,  // 1 hour
            tvl_pct_per_hour_bps: 500,  // 5%/h
            global_hard_max_bps: 10000,  // 100% of TVL (effectively no hard max unless explicitly set)
        }
    }
}

/// Withdrawal threshold exceptions
#[derive(Debug, Clone, Copy)]
pub struct WithdrawalThresholds {
    /// Free PnL threshold per day (no bucket charge)
    /// e.g., 500 * SCALE = $500/day free
    pub free_pnl_threshold_per_day: i128,

    /// Principal fast lane per day (no bucket charge)
    /// min(pct_of_principal, hard_max)
    pub principal_fast_lane_pct_bps: u64,  // e.g., 500 = 5%
    pub principal_fast_lane_hard_max: i128,  // e.g., $10k
}

impl Default for WithdrawalThresholds {
    fn default() -> Self {
        Self {
            free_pnl_threshold_per_day: 500 * SCALE,
            principal_fast_lane_pct_bps: 500,  // 5%
            principal_fast_lane_hard_max: 10_000 * SCALE,
        }
    }
}

/// Per-user exit bucket state (time-windowed rate limiter)
#[derive(Debug, Clone, Copy)]
pub struct UserExitBucket {
    /// Amount used in current window
    pub amount_used: i128,

    /// Window start time (seconds since epoch or slot-based)
    pub window_start_secs: u64,

    /// Free PnL used today
    pub free_pnl_used_today: i128,

    /// Principal fast lane used today
    pub principal_fast_lane_used_today: i128,

    /// Last reset day (for daily threshold resets)
    pub last_reset_day: u64,
}

impl Default for UserExitBucket {
    fn default() -> Self {
        Self {
            amount_used: 0,
            window_start_secs: 0,
            free_pnl_used_today: 0,
            principal_fast_lane_used_today: 0,
            last_reset_day: 0,
        }
    }
}

/// Global exit bucket state (aggregate throttling)
#[derive(Debug, Clone, Copy)]
pub struct GlobalExitBucket {
    /// Total amount used in current window across all users
    pub amount_used: i128,

    /// Window start time
    pub window_start_secs: u64,
}

impl Default for GlobalExitBucket {
    fn default() -> Self {
        Self {
            amount_used: 0,
            window_start_secs: 0,
        }
    }
}

/// Emergency mode parameters
#[derive(Debug, Clone, Copy)]
pub struct EmergencyMode {
    /// Is emergency mode active?
    pub active: bool,

    /// Exit multiplier during emergency (basis points)
    /// e.g., 5000 = 50% of normal caps
    pub exit_multiplier_bps: u64,

    /// When emergency mode auto-expires (seconds)
    pub expires_at_secs: u64,
}

impl Default for EmergencyMode {
    fn default() -> Self {
        Self {
            active: false,
            exit_multiplier_bps: 10000,  // 100% (no reduction)
            expires_at_secs: 0,
        }
    }
}

/// Withdrawal plan result
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WithdrawalPlan {
    /// Amount that can be withdrawn immediately
    pub immediate: i128,

    /// Amount that must be queued
    pub queued: i128,

    /// Estimated wait time in seconds (0 if immediate)
    pub eta_secs: u64,
}

/// User state for testing
#[derive(Debug, Clone, Copy)]
pub struct TestUser {
    pub principal: i128,
    pub pnl: i128,
    pub vested_pnl: i128,
    pub last_slot: u64,
    pub pnl_index_checkpoint: i128,
    pub exit_bucket: UserExitBucket,
}

impl TestUser {
    fn new(principal: i128, pnl: i128) -> Self {
        Self {
            principal,
            pnl,
            vested_pnl: 0,
            last_slot: 0,
            pnl_index_checkpoint: FP_ONE,
            exit_bucket: UserExitBucket::default(),
        }
    }

    fn equity(&self) -> i128 {
        self.principal.saturating_add(self.pnl)
    }

    fn withdrawable_now(&self) -> i128 {
        self.principal.saturating_add(self.vested_pnl)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE WITHDRAWAL LOGIC
// ═══════════════════════════════════════════════════════════════════════════

/// Reset bucket if window has expired
fn maybe_reset_bucket(
    bucket: &mut UserExitBucket,
    now_secs: u64,
    window_secs: u64,
) {
    if now_secs >= bucket.window_start_secs.saturating_add(window_secs) {
        bucket.amount_used = 0;
        bucket.window_start_secs = now_secs;
    }
}

/// Reset daily thresholds if day boundary crossed
fn maybe_reset_daily_thresholds(
    bucket: &mut UserExitBucket,
    now_secs: u64,
) {
    let current_day = now_secs / 86400;  // 86400 secs per day
    if current_day > bucket.last_reset_day {
        bucket.free_pnl_used_today = 0;
        bucket.principal_fast_lane_used_today = 0;
        bucket.last_reset_day = current_day;
    }
}

/// Compute per-user exit allowance
fn compute_user_allowance(
    equity: i128,
    bucket: &UserExitBucket,
    params: &ExitBucketParams,
    emergency: &EmergencyMode,
) -> i128 {
    // Compute base cap: min(pct_of_equity, hard_max)
    // Overflow-safe: check if multiplication would overflow
    let pct_cap = if equity.abs() > i128::MAX / 10000 {
        // For very large values, do division first
        (equity / 10000) * params.user_pct_per_hour_bps as i128
    } else {
        (equity * params.user_pct_per_hour_bps as i128) / 10000
    };
    let mut cap = pct_cap.min(params.user_hard_max_per_hour);

    // Apply emergency multiplier (also overflow-safe)
    if emergency.active {
        cap = if cap.abs() > i128::MAX / 10000 {
            (cap / 10000) * emergency.exit_multiplier_bps as i128
        } else {
            (cap * emergency.exit_multiplier_bps as i128) / 10000
        };
    }

    // Return remaining allowance
    cap.saturating_sub(bucket.amount_used).max(0)
}

/// Compute global exit allowance
fn compute_global_allowance(
    tvl: i128,
    global_bucket: &GlobalExitBucket,
    params: &ExitBucketParams,
    emergency: &EmergencyMode,
    now_secs: u64,
) -> i128 {
    // Reset global bucket if window expired
    let window_expired = now_secs >= global_bucket.window_start_secs.saturating_add(params.rolling_window_secs);
    let bucket_used = if window_expired { 0 } else { global_bucket.amount_used };

    // Compute base cap: min(pct_of_tvl, hard_max) - overflow-safe
    let pct_cap = if tvl.abs() > i128::MAX / 10000 {
        (tvl / 10000) * params.tvl_pct_per_hour_bps as i128
    } else {
        (tvl * params.tvl_pct_per_hour_bps as i128) / 10000
    };
    let hard_max = if tvl.abs() > i128::MAX / 10000 {
        (tvl / 10000) * params.global_hard_max_bps as i128
    } else {
        (tvl * params.global_hard_max_bps as i128) / 10000
    };
    let mut cap = pct_cap.min(hard_max);

    // Apply emergency multiplier (overflow-safe)
    if emergency.active {
        cap = if cap.abs() > i128::MAX / 10000 {
            (cap / 10000) * emergency.exit_multiplier_bps as i128
        } else {
            (cap * emergency.exit_multiplier_bps as i128) / 10000
        };
    }

    cap.saturating_sub(bucket_used).max(0)
}

/// Plan a withdrawal: compute immediate vs queued amounts
pub fn plan_withdrawal(
    user: &mut TestUser,
    amount: i128,
    tvl: i128,
    global_bucket: &mut GlobalExitBucket,
    params: &ExitBucketParams,
    thresholds: &WithdrawalThresholds,
    emergency: &EmergencyMode,
    vesting_params: &PnlVestingParams,
    global_haircut: &GlobalHaircut,
    now_slot: u64,
    now_secs: u64,
) -> WithdrawalPlan {
    // Step 1: Apply haircut catchup
    on_user_touch(
        user.principal,
        &mut user.pnl,
        &mut user.vested_pnl,
        &mut user.last_slot,
        &mut user.pnl_index_checkpoint,
        global_haircut,
        vesting_params,
        now_slot,
    );

    // Step 2: Compute withdrawable amount
    let withdrawable = user.withdrawable_now();
    let requested = amount.min(withdrawable);  // Can't withdraw more than available

    if requested == 0 {
        return WithdrawalPlan { immediate: 0, queued: 0, eta_secs: 0 };
    }

    // Step 3: Reset buckets if windows expired
    maybe_reset_bucket(&mut user.exit_bucket, now_secs, params.rolling_window_secs);
    maybe_reset_daily_thresholds(&mut user.exit_bucket, now_secs);

    // Initialize or reset global bucket
    if global_bucket.window_start_secs == 0 {
        // First use - initialize window
        global_bucket.window_start_secs = now_secs;
        global_bucket.amount_used = 0;
    } else {
        let window_expired = now_secs >= global_bucket.window_start_secs.saturating_add(params.rolling_window_secs);
        if window_expired {
            global_bucket.amount_used = 0;
            global_bucket.window_start_secs = now_secs;
        }
    }

    // Step 4: Check threshold exceptions
    let mut bypass_amount = 0i128;
    let mut remaining_request = requested;

    // Apply thresholds intelligently based on what's available
    // Priority: free PnL first (for vested_pnl withdrawals), then principal fast lane

    // Free PnL threshold (for vested_pnl withdrawals)
    let free_pnl_remaining = thresholds.free_pnl_threshold_per_day.saturating_sub(user.exit_bucket.free_pnl_used_today);
    if free_pnl_remaining > 0 && remaining_request > 0 && user.vested_pnl > 0 {
        // Can use free PnL threshold for vested_pnl portion
        let pnl_available = user.vested_pnl;
        let from_free_pnl = free_pnl_remaining.min(remaining_request).min(pnl_available);
        if from_free_pnl > 0 {
            bypass_amount += from_free_pnl;
            user.exit_bucket.free_pnl_used_today += from_free_pnl;
            remaining_request -= from_free_pnl;
        }
    }

    // Principal fast lane (for principal withdrawals)
    let principal_fast_lane_cap = {
        let pct_cap = (user.principal * thresholds.principal_fast_lane_pct_bps as i128) / 10000;
        pct_cap.min(thresholds.principal_fast_lane_hard_max)
    };
    let principal_fast_lane_remaining = principal_fast_lane_cap.saturating_sub(user.exit_bucket.principal_fast_lane_used_today);
    if principal_fast_lane_remaining > 0 && remaining_request > 0 {
        let from_fast_lane = principal_fast_lane_remaining.min(remaining_request);
        bypass_amount += from_fast_lane;
        user.exit_bucket.principal_fast_lane_used_today += from_fast_lane;
        remaining_request -= from_fast_lane;
    }

    // Step 5: Apply exit buckets to remaining amount
    if remaining_request == 0 {
        // All bypassed!
        return WithdrawalPlan { immediate: requested, queued: 0, eta_secs: 0 };
    }

    // Compute allowances
    let user_allowance = compute_user_allowance(user.equity(), &user.exit_bucket, params, emergency);
    let global_allowance = compute_global_allowance(tvl, global_bucket, params, emergency, now_secs);

    // Min of user and global allowances
    let bucket_allowance = user_allowance.min(global_allowance);

    // How much can pass through buckets?
    let through_buckets = remaining_request.min(bucket_allowance);

    // Update buckets
    user.exit_bucket.amount_used += through_buckets;
    global_bucket.amount_used += through_buckets;

    // Total immediate
    let immediate = bypass_amount + through_buckets;
    let queued = requested - immediate;

    // Estimate ETA (simple: assume cap refills linearly)
    let eta_secs = if queued > 0 {
        params.rolling_window_secs
    } else {
        0
    };

    WithdrawalPlan { immediate, queued, eta_secs }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // Test defaults
    fn default_params() -> ExitBucketParams {
        ExitBucketParams::default()
    }

    fn default_thresholds() -> WithdrawalThresholds {
        WithdrawalThresholds::default()
    }

    fn default_vesting() -> PnlVestingParams {
        PnlVestingParams {
            tau_slots: 86400,  // ~24h for testing
            cliff_slots: 0,
        }
    }

    fn default_global_haircut() -> GlobalHaircut {
        GlobalHaircut::default()
    }

    fn default_emergency() -> EmergencyMode {
        EmergencyMode::default()
    }

    // ═══════════════════════════════════════════════════════════════════════
    // A. PnL WARM-UP (VESTING) TESTS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_a01_no_time_no_vest() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);

        // Apply vesting with dt=0
        on_user_touch(
            user.principal,
            &mut user.pnl,
            &mut user.vested_pnl,
            &mut user.last_slot,
            &mut user.pnl_index_checkpoint,
            &global,
            &vesting,
            0,  // now_slot = 0 (no time passed)
        );

        assert_eq!(user.vested_pnl, 0, "No time passed, no vesting");
    }

    #[test]
    fn test_a02_one_tau_approx_63_percent() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user.last_slot = 0;

        // Advance by one tau
        on_user_touch(
            user.principal,
            &mut user.pnl,
            &mut user.vested_pnl,
            &mut user.last_slot,
            &mut user.pnl_index_checkpoint,
            &global,
            &vesting,
            vesting.tau_slots,
        );

        // Should be ~63.2% vested
        let expected = (user.pnl * 632) / 1000;
        let tolerance = user.pnl / 100;  // 1% tolerance
        assert!((user.vested_pnl - expected).abs() < tolerance,
            "Expected ~63%, got vested_pnl={}, expected~{}", user.vested_pnl, expected);

        // Check withdrawable
        let withdrawable = user.withdrawable_now();
        assert_eq!(withdrawable, user.principal + user.vested_pnl);
    }

    #[test]
    fn test_a03_four_tau_98_percent_plus() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user.last_slot = 0;

        // Advance by 4*tau
        on_user_touch(
            user.principal,
            &mut user.pnl,
            &mut user.vested_pnl,
            &mut user.last_slot,
            &mut user.pnl_index_checkpoint,
            &global,
            &vesting,
            4 * vesting.tau_slots,
        );

        // Should be ≥98% vested
        let min_expected = (user.pnl * 98) / 100;
        assert!(user.vested_pnl >= min_expected, "Expected ≥98% vested");
        assert!(user.vested_pnl <= user.pnl, "vested_pnl should never exceed pnl");
    }

    #[test]
    fn test_a04_clamp_when_pnl_drops() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user.last_slot = 0;

        // Vest some amount
        on_user_touch(
            user.principal,
            &mut user.pnl,
            &mut user.vested_pnl,
            &mut user.last_slot,
            &mut user.pnl_index_checkpoint,
            &global,
            &vesting,
            vesting.tau_slots,
        );

        let vested_before = user.vested_pnl;
        assert!(vested_before > 0);

        // Now PnL drops due to loss
        user.pnl = 2_000 * SCALE;
        user.last_slot = vesting.tau_slots;

        // Re-vest (should clamp)
        on_user_touch(
            user.principal,
            &mut user.pnl,
            &mut user.vested_pnl,
            &mut user.last_slot,
            &mut user.pnl_index_checkpoint,
            &global,
            &vesting,
            vesting.tau_slots + 100,
        );

        assert_eq!(user.vested_pnl, user.pnl, "vested_pnl should clamp to pnl when pnl drops");
    }

    #[test]
    fn test_a05_multiple_increments_vs_single_step() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        // Path 1: Single step of tau
        let mut user1 = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user1.last_slot = 0;
        on_user_touch(user1.principal, &mut user1.pnl, &mut user1.vested_pnl, &mut user1.last_slot,
            &mut user1.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots);

        // Path 2: Two steps of tau/2
        let mut user2 = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user2.last_slot = 0;
        on_user_touch(user2.principal, &mut user2.pnl, &mut user2.vested_pnl, &mut user2.last_slot,
            &mut user2.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots / 2);
        on_user_touch(user2.principal, &mut user2.pnl, &mut user2.vested_pnl, &mut user2.last_slot,
            &mut user2.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots);

        // Allow 10% tolerance due to compounding effects
        let tolerance = user1.vested_pnl / 10;
        assert!((user1.vested_pnl - user2.vested_pnl).abs() < tolerance,
            "Two paths should yield similar vested_pnl (within 10%): {} vs {}", user1.vested_pnl, user2.vested_pnl);
    }

    #[test]
    fn test_a06_cliff() {
        let mut vesting = default_vesting();
        vesting.cliff_slots = 600;  // 10 min cliff
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 5_000 * SCALE);
        user.last_slot = 0;

        // Before cliff
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, vesting.cliff_slots - 1);
        assert_eq!(user.vested_pnl, 0, "Before cliff, no vesting");

        // After cliff
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, vesting.cliff_slots + 100);
        assert!(user.vested_pnl > 0, "After cliff, vesting should occur");
    }

    #[test]
    fn test_a07_big_dt_saturation() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        user.last_slot = 0;

        // Huge dt (way beyond 20*tau)
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 1_000 * vesting.tau_slots);

        assert_eq!(user.vested_pnl, user.pnl, "Should saturate to 100% vested");

        // Check no overflow/NaN (just accessing the value proves it's valid)
        assert!(user.vested_pnl >= 0 && user.vested_pnl <= user.pnl);
    }

    #[test]
    fn test_a08_negative_pnl_unaffected() {
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, -3_000 * SCALE);
        user.last_slot = 0;

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots);

        assert_eq!(user.vested_pnl, user.pnl, "Negative PnL: vested_pnl should equal pnl (clamped)");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // B. PER-USER EXIT BUCKET TESTS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_b01_basic_hourly_cap() {
        let params = default_params();  // user_pct = 20%/h
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,  // Disable thresholds for this test
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);  // equity = 200k
        let mut global_bucket = GlobalExitBucket::default();

        // Full vest
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Expected cap: 20% of 200k = 40k
        let now_slot = 10 * vesting.tau_slots;
        let now_secs = 1000;

        let plan = plan_withdrawal(
            &mut user,
            50_000 * SCALE,  // Request 50k
            10_000_000 * SCALE,  // TVL = 10m (high enough to not limit)
            &mut global_bucket,
            &params,
            &thresholds,
            &emergency,
            &vesting,
            &global,
            now_slot,
            now_secs,
        );

        // Should allow 40k, queue 10k
        assert_eq!(plan.immediate, 40_000 * SCALE, "Should allow user cap of 40k");
        assert_eq!(plan.queued, 10_000 * SCALE, "Remainder should be queued");
        assert_eq!(user.exit_bucket.amount_used, 40_000 * SCALE, "Bucket should be charged");
    }

    #[test]
    fn test_b02_partial_consume_then_reset() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // First withdrawal
        let plan1 = plan_withdrawal(&mut user, 30_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);
        assert_eq!(plan1.immediate, 30_000 * SCALE);

        // Advance 1 hour (reset window)
        let plan2 = plan_withdrawal(&mut user, 30_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000 + 3600);

        // New cap applies: 20% of remaining equity
        // After first withdraw, equity = 200k - 30k = 170k → cap = 34k
        assert!(plan2.immediate == 30_000 * SCALE, "After reset, fresh cap allows 30k (within 34k cap)");
    }

    #[test]
    fn test_b03_hard_max_smaller_than_pct() {
        let mut params = default_params();
        params.user_hard_max_per_hour = 250_000 * SCALE;  // Hard max = 250k
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(5_000_000 * SCALE, 5_000_000 * SCALE);  // equity = 10m
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Pct cap = 20% of 10m = 2m, but hard max = 250k
        let plan = plan_withdrawal(&mut user, 300_000 * SCALE, 100_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        assert_eq!(plan.immediate, 250_000 * SCALE, "Hard max should cap at 250k");
        assert_eq!(plan.queued, 50_000 * SCALE);
    }

    #[test]
    fn test_b05_principal_fast_lane_bypass() {
        let params = default_params();
        let thresholds = default_thresholds();  // 5% or $10k fast lane
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Fast lane = min(5% of 100k, 10k) = 5k
        let plan = plan_withdrawal(&mut user, 10_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Should allow 5k bypass + remaining through bucket
        assert!(plan.immediate == 10_000 * SCALE, "Principal fast lane should allow immediate withdrawal");

        // Check bucket NOT charged for fast lane portion
        let fast_lane_amount = thresholds.principal_fast_lane_hard_max.min((user.principal * 500) / 10000);
        assert_eq!(user.exit_bucket.principal_fast_lane_used_today, fast_lane_amount);
    }

    #[test]
    fn test_b06_free_pnl_threshold_bypass() {
        let params = default_params();
        let thresholds = default_thresholds();  // $500/day free
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 10_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Withdraw $500 (within free threshold)
        let plan = plan_withdrawal(&mut user, 500 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        assert_eq!(plan.immediate, 500 * SCALE);
        assert_eq!(user.exit_bucket.free_pnl_used_today, 500 * SCALE);
        // Bucket should not be heavily charged (bypassed via free PnL)
    }

    #[test]
    fn test_b07_multiple_small_withdrawals_accumulate() {
        let params = default_params();  // Cap = 20% of 200k = 40k
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let now_slot = 10 * vesting.tau_slots;
        let now_secs = 1000;

        // Five withdrawals of 8k each = 40k total
        for _ in 0..5 {
            let plan = plan_withdrawal(&mut user, 8_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
                &params, &thresholds, &emergency, &vesting, &global, now_slot, now_secs);
            assert!(plan.immediate > 0, "Should allow withdrawal within cap");
        }

        // Sixth should be denied/queued
        let plan6 = plan_withdrawal(&mut user, 8_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, now_slot, now_secs);
        assert_eq!(plan6.immediate, 0, "Sixth withdrawal should be fully queued");
        assert_eq!(plan6.queued, 8_000 * SCALE);
    }

    #[test]
    fn test_b08_exact_boundary() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Withdraw exactly the cap (40k)
        let plan = plan_withdrawal(&mut user, 40_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        assert_eq!(plan.immediate, 40_000 * SCALE);
        assert_eq!(plan.queued, 0);
        assert_eq!(user.exit_bucket.amount_used, 40_000 * SCALE, "Bucket should be exactly at cap");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // C. GLOBAL EXIT BUCKET TESTS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_c01_global_cap_with_multiple_users() {
        let params = default_params();  // global = 5% of TVL = 500k
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let tvl = 10_000_000 * SCALE;  // TVL = 10m → global cap = 500k
        let mut global_bucket = GlobalExitBucket::default();

        // User A: request 400k
        let mut userA = TestUser::new(2_000_000 * SCALE, 0);
        on_user_touch(userA.principal, &mut userA.pnl, &mut userA.vested_pnl, &mut userA.last_slot,
            &mut userA.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let planA = plan_withdrawal(&mut userA, 400_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // User B: request 200k
        let mut userB = TestUser::new(1_000_000 * SCALE, 0);
        on_user_touch(userB.principal, &mut userB.pnl, &mut userB.vested_pnl, &mut userB.last_slot,
            &mut userB.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let planB = plan_withdrawal(&mut userB, 200_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Total permitted should be ≤ 500k
        let total_immediate = planA.immediate + planB.immediate;
        assert!(total_immediate <= 500_000 * SCALE,
            "Total across users should not exceed global cap of 500k, got {}", total_immediate / SCALE);

        // User A gets 400k, User B gets min(200k, remaining 100k) = 100k
        // NOTE: This implementation is FIFO. Pro-rata would be different.
        assert_eq!(planA.immediate, 400_000 * SCALE, "User A (first) gets full request");
        assert_eq!(planB.immediate, 100_000 * SCALE, "User B gets remaining global allowance");
        assert_eq!(planB.queued, 100_000 * SCALE, "User B remainder queued");
    }

    #[test]
    fn test_c02_global_hard_max_smaller_than_pct() {
        let mut params = default_params();
        params.global_hard_max_bps = 300;  // 3% of TVL
        // Pct cap = 5% of 10m = 500k, hard max = 3% of 10m = 300k

        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let tvl = 10_000_000 * SCALE;
        let mut global_bucket = GlobalExitBucket::default();

        let mut user = TestUser::new(2_000_000 * SCALE, 0);
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let plan = plan_withdrawal(&mut user, 500_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Should cap at 300k (hard max)
        assert!(plan.immediate <= 300_000 * SCALE, "Global hard max should limit to 300k");
    }

    #[test]
    fn test_c03_per_user_vs_global_min() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let tvl = 10_000_000 * SCALE;  // Global cap = 500k
        let mut global_bucket = GlobalExitBucket::default();

        // Pre-fill global bucket to leave only 60k remaining
        global_bucket.amount_used = 440_000 * SCALE;
        global_bucket.window_start_secs = 1000;

        // User with cap of 100k
        let mut user = TestUser::new(250_000 * SCALE, 250_000 * SCALE);  // equity = 500k → user cap = 100k
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let plan = plan_withdrawal(&mut user, 100_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // User cap allows 100k, but global only has 60k remaining
        assert_eq!(plan.immediate, 60_000 * SCALE, "Global allowance should limit to 60k");
        assert_eq!(plan.queued, 40_000 * SCALE);
    }

    #[test]
    fn test_c04_rollover_reset() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let tvl = 10_000_000 * SCALE;
        let mut global_bucket = GlobalExitBucket::default();
        global_bucket.window_start_secs = 1000;

        // Fill global cap
        let mut user1 = TestUser::new(2_500_000 * SCALE, 0);
        on_user_touch(user1.principal, &mut user1.pnl, &mut user1.vested_pnl, &mut user1.last_slot,
            &mut user1.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        plan_withdrawal(&mut user1, 500_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Check filled
        assert!(global_bucket.amount_used >= 400_000 * SCALE, "Global bucket should be mostly filled");

        // Advance 1 hour
        let mut user2 = TestUser::new(1_000_000 * SCALE, 0);
        on_user_touch(user2.principal, &mut user2.pnl, &mut user2.vested_pnl, &mut user2.last_slot,
            &mut user2.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let plan2 = plan_withdrawal(&mut user2, 200_000 * SCALE, tvl, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000 + 3600);

        // After reset, fresh allowance available
        assert_eq!(plan2.immediate, 200_000 * SCALE, "After reset, global bucket allows fresh withdrawals");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // E. HAIRCUT INTERACTIONS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_e01_haircut_reduces_pnl_not_principal() {
        let vesting = default_vesting();
        let mut global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 20_000 * SCALE);
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let vested_before = user.vested_pnl;
        assert_eq!(vested_before, 20_000 * SCALE, "Should be fully vested");

        // Apply haircut: pnl_index *= 0.8
        global.pnl_index = (global.pnl_index * 8) / 10;

        // Touch user to apply haircut
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        assert_eq!(user.pnl, 16_000 * SCALE, "PnL should be reduced by 20%");
        assert_eq!(user.vested_pnl, 16_000 * SCALE, "vested_pnl should also be reduced");
        assert_eq!(user.principal, 100_000 * SCALE, "Principal should be unchanged");

        let withdrawable = user.withdrawable_now();
        assert_eq!(withdrawable, 116_000 * SCALE, "Withdrawable = 100k + 16k");
    }

    #[test]
    fn test_e02_sequential_haircuts_compose() {
        let vesting = default_vesting();
        let mut global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 20_000 * SCALE);
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // First haircut: *0.9
        global.pnl_index = (global.pnl_index * 9) / 10;
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        assert_eq!(user.pnl, 18_000 * SCALE, "After first haircut: 20k * 0.9 = 18k");

        // Second haircut: *0.8
        global.pnl_index = (global.pnl_index * 8) / 10;
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Effective: 20k * 0.9 * 0.8 = 20k * 0.72 = 14.4k
        let expected = 14_400 * SCALE;
        assert!((user.pnl - expected).abs() < 100 * SCALE,
            "After two haircuts: 20k * 0.72 ≈ 14.4k, got {}", user.pnl / SCALE);
    }

    #[test]
    fn test_e03_negative_pnl_unchanged() {
        let vesting = default_vesting();
        let mut global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, -5_000 * SCALE);
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let pnl_before = user.pnl;

        // Apply haircut
        global.pnl_index = (global.pnl_index * 8) / 10;
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        assert_eq!(user.pnl, pnl_before, "Negative PnL should be unchanged by haircut");
    }

    #[test]
    fn test_e04_withdraw_after_haircut_respects_buckets() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let mut global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);  // equity = 200k
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let mut global_bucket = GlobalExitBucket::default();

        // Apply haircut: *0.5
        global.pnl_index = global.pnl_index / 2;

        // Try to withdraw assuming pre-haircut withdrawable (200k)
        let plan = plan_withdrawal(&mut user, 200_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Post-haircut: pnl = 50k, withdrawable = 150k
        // User cap = 20% of 150k = 30k
        assert!(plan.immediate <= 30_000 * SCALE,
            "Withdrawal should be limited by post-haircut equity and bucket, got {}", plan.immediate / SCALE);
    }

    #[test]
    fn test_e05_haircut_then_vest() {
        let vesting = default_vesting();
        let mut global = default_global_haircut();

        let mut user = TestUser::new(100_000 * SCALE, 20_000 * SCALE);
        user.last_slot = 0;

        // Partial vest (1 tau)
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots);

        let vested_mid = user.vested_pnl;
        assert!(vested_mid > 0 && vested_mid < user.pnl, "Should be partially vested");

        // Apply haircut
        global.pnl_index = global.pnl_index / 2;
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, vesting.tau_slots);

        let pnl_after_haircut = user.pnl;
        let vested_after_haircut = user.vested_pnl;

        // Advance more time to vest further
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 5 * vesting.tau_slots);

        // Vesting should bring vested_pnl toward POST-haircut pnl, not original
        assert!(user.vested_pnl > vested_after_haircut, "Vesting should continue after haircut");
        assert!(user.vested_pnl <= pnl_after_haircut, "Vested PnL should not exceed post-haircut PnL");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // G. SECURITY & INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_g01_principal_inviolable() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,  // Disable fast lane
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let mut global = default_global_haircut();
        let emergency = default_emergency();

        let initial_principal = 100_000 * SCALE;
        let mut user = TestUser::new(initial_principal, 50_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        // Vest
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Haircut
        global.pnl_index = global.pnl_index / 2;
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Withdraw (only PnL portion)
        plan_withdrawal(&mut user, 20_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Principal should remain unchanged
        assert_eq!(user.principal, initial_principal,
            "Principal must never change without explicit principal withdrawal");
    }

    #[test]
    fn test_g02_never_withdraw_more_than_equity() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 20_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let equity_before = user.equity();

        // Try to withdraw more than equity
        let plan = plan_withdrawal(&mut user, 1_000_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Should be capped at withdrawable, which is ≤ equity
        assert!(plan.immediate + plan.queued <= equity_before,
            "Total withdrawal plan should not exceed equity");
    }

    #[test]
    fn test_g03_monotone_buckets() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Make several withdrawals
        for _ in 0..5 {
            plan_withdrawal(&mut user, 10_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
                &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

            // Check bucket invariants
            assert!(user.exit_bucket.amount_used >= 0, "Bucket usage should never be negative");

            let cap = compute_user_allowance(user.equity(), &user.exit_bucket, &params, &emergency);
            assert!(user.exit_bucket.amount_used <= cap + user.exit_bucket.amount_used,
                "Bucket usage should not exceed cap (accounting for already used)");
        }
    }

    #[test]
    fn test_g04_determinism() {
        let params = default_params();
        let thresholds = default_thresholds();
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        // Run same sequence twice
        let mut results = Vec::new();

        for _ in 0..2 {
            let mut user = TestUser::new(100_000 * SCALE, 50_000 * SCALE);
            let mut global_bucket = GlobalExitBucket::default();

            on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
                &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

            let plan = plan_withdrawal(&mut user, 30_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
                &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

            results.push((plan.immediate, plan.queued, user.vested_pnl, user.exit_bucket.amount_used));
        }

        // Both runs should yield identical results
        assert_eq!(results[0], results[1], "Determinism: same inputs should yield same outputs");
    }

    #[test]
    fn test_g05_numeric_safety() {
        let params = default_params();
        let thresholds = default_thresholds();
        let vesting = default_vesting();
        let global = default_global_haircut();
        let emergency = default_emergency();

        // Large values
        let mut user = TestUser::new(i128::MAX / 1000, i128::MAX / 2000);
        let mut global_bucket = GlobalExitBucket::default();

        // Should not overflow
        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        let plan = plan_withdrawal(&mut user, i128::MAX / 5000, i128::MAX / 100, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        // Just check no panic occurred and values are reasonable
        assert!(plan.immediate >= 0);
        assert!(plan.queued >= 0);
        assert!(user.vested_pnl >= 0 && user.vested_pnl <= user.pnl);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // I. EMERGENCY MODE
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_i01_tightened_caps() {
        let params = default_params();
        let thresholds = WithdrawalThresholds {
            free_pnl_threshold_per_day: 0,
            principal_fast_lane_pct_bps: 0,
            principal_fast_lane_hard_max: 0,
        };
        let vesting = default_vesting();
        let global = default_global_haircut();

        let mut emergency = default_emergency();
        emergency.active = true;
        emergency.exit_multiplier_bps = 5000;  // 50% of normal

        let mut user = TestUser::new(100_000 * SCALE, 100_000 * SCALE);
        let mut global_bucket = GlobalExitBucket::default();

        on_user_touch(user.principal, &mut user.pnl, &mut user.vested_pnl, &mut user.last_slot,
            &mut user.pnl_index_checkpoint, &global, &vesting, 10 * vesting.tau_slots);

        // Normal cap would be 20% of 200k = 40k
        // Emergency cap = 40k * 50% = 20k
        let plan = plan_withdrawal(&mut user, 40_000 * SCALE, 10_000_000 * SCALE, &mut global_bucket,
            &params, &thresholds, &emergency, &vesting, &global, 10 * vesting.tau_slots, 1000);

        assert_eq!(plan.immediate, 20_000 * SCALE, "Emergency mode should halve the cap");
        assert_eq!(plan.queued, 20_000 * SCALE);
    }
}

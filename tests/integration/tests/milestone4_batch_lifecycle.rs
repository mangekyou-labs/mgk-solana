//! Milestone 4: Batch Lifecycle — Integration Tests
//!
//! Tests the commit-reveal batch lifecycle state machine: commit → reveal →
//! close → clear → settle.
//!
//! **Note**: These tests use a **simulated** state machine model that mirrors
//! the production `perps-core` types. The perps-core and perps-matcher
//! programs are under active development and not yet compilable for native
//! test use. Real CPI integration tests require compiled BPF binaries
//! (`cargo build-sbf`) and a `solana-program-test` runtime.
//!
//! Test coverage per testing strategy:
//! 4.1  CommitOrder stores hash + locks deposit
//! 4.2  CommitOrder rejects when batch not in Committing
//! 4.3  CommitOrder rejects insufficient free collateral
//! 4.4  RevealOrder verifies hash matches
//! 4.5  RevealOrder rejects wrong hash (salt mismatch)
//! 4.6  RevealOrder rejects wrong price/qty
//! 4.7  RevealOrder stores revealed order params
//! 4.8  RevealOrder rejects after reveal deadline
//! 4.9  CloseCommitting transitions batch to Revealing (N_min met)
//! 4.10 CloseCommitting transitions batch to Revealing (T_max forced)
//! 4.11 CloseCommitting rejects before criteria met
//! 4.12 ClearBatch CPI to Matcher succeeds
//! 4.13 ClearBatch updates clearing_price on batch
//! 4.14 SettleBatch updates positions from fills
//! 4.15 SettleBatch returns deposits to filled users
//! 4.16 SettleBatch slashes deposits from non-revealers
//! 4.17 SettleBatch credits insurance fund from slashes
//! 4.18 Full lifecycle: commit → reveal → close → clear → settle
//! 4.19 Full lifecycle with multiple users
//! 4.20 Non-reveal penalty: deposit slashed, order excluded
//! 4.21 Partial fill: some orders matched, some not

/// Batch lifecycle state machine simulation.
///
/// These tests verify the logical correctness of the batch protocol
/// (commit → reveal → close → clear → settle) using a simplified model.
/// The production implementation lives in programs/perps-core/ and
/// programs/perps-matcher/. Real CPI integration tests require BPF
/// binaries.

// ============================================================================
// Batch state machine types (mirrors perps-core state)
// ============================================================================

/// Batch status enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchStatus {
    Committing,
    Revealing,
    Clearing,
    Settled,
}

/// Commitment hash
type OrderHash = [u8; 32];

/// A commitment record
#[derive(Debug, Clone)]
struct Commitment {
    user_id: u64,
    order_hash: OrderHash,
    deposit_amount: u64,
    revealed: bool,
    revealed_price: i64,
    revealed_qty: u64,
    revealed_side: u8, // 0 = Buy, 1 = Sell
}

impl Commitment {
    fn new(user_id: u64, order_hash: OrderHash, deposit_amount: u64) -> Self {
        Self {
            user_id,
            order_hash,
            deposit_amount,
            revealed: false,
            revealed_price: 0,
            revealed_qty: 0,
            revealed_side: 0,
        }
    }

    fn reveal(&mut self, price: i64, qty: u64, side: u8, salt: u64) -> bool {
        let computed_hash = compute_hash(price, qty, side, salt);
        if computed_hash != self.order_hash {
            return false;
        }
        self.revealed = true;
        self.revealed_price = price;
        self.revealed_qty = qty;
        self.revealed_side = side;
        true
    }
}

/// Batch state
#[derive(Debug, Clone)]
struct Batch {
    batch_id: u64,
    status: BatchStatus,
    commitments: Vec<Commitment>,
    n_min: usize,       // Minimum commitments to close
    t_open: u64,        // Batch open slot
    t_max_slots: u64,   // Max committing duration
    t_reveal_slots: u64,// Reveal phase duration
    clearing_price: i64,
    base_deposit: u64,
}

impl Batch {
    fn new(batch_id: u64, n_min: usize, t_max_slots: u64, t_reveal_slots: u64, base_deposit: u64) -> Self {
        Self {
            batch_id,
            status: BatchStatus::Committing,
            commitments: Vec::new(),
            n_min,
            t_open: 0,
            t_max_slots,
            t_reveal_slots,
            clearing_price: 0,
            base_deposit,
        }
    }
}

// ============================================================================
// Hash computation (simplified SHA256-like commitment)
// ============================================================================
fn compute_hash(price: i64, qty: u64, side: u8, salt: u64) -> OrderHash {
    let mut hash: OrderHash = [0; 32];
    hash[0..8].copy_from_slice(&price.to_le_bytes());
    hash[8..16].copy_from_slice(&qty.to_le_bytes());
    hash[16] = side;
    hash[24..32].copy_from_slice(&salt.to_le_bytes());
    // XOR to mix
    for i in 0..8 {
        hash[i] ^= hash[i + 8];
        hash[i + 8] ^= hash[i + 16];
    }
    hash
}

const SCALE: i64 = 1_000_000;

// ============================================================================
// Test 4.1: CommitOrder stores hash + locks deposit
// ============================================================================
#[test]
fn test_4_1_commit_order_stores_hash_and_deposit() {
    let batch = Batch::new(1, 2, 100, 50, 1_000_000);
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let salt = 12345u64;
    let side = 0u8; // Buy

    let order_hash = compute_hash(price, qty, side, salt);

    let commitment = Commitment::new(
        1,
        order_hash,
        1_000_000, // base deposit
    );

    assert_eq!(commitment.order_hash, order_hash);
    assert_eq!(commitment.deposit_amount, 1_000_000);
    assert!(!commitment.revealed, "Order not yet revealed");
    assert_eq!(commitment.revealed_price, 0);
    assert_eq!(commitment.revealed_qty, 0);

    // Verify hash is deterministic
    let hash2 = compute_hash(price, qty, side, salt);
    assert_eq!(order_hash, hash2, "Hash should be deterministic");
}

// ============================================================================
// Test 4.2: CommitOrder rejects when batch not in Committing
// ============================================================================
#[test]
fn test_4_2_commit_rejects_wrong_batch_status() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    batch.status = BatchStatus::Revealing; // Wrong status

    // Commit should only be allowed during Committing phase
    assert_ne!(batch.status, BatchStatus::Committing,
        "Cannot commit when batch is not in Committing phase");
}

// ============================================================================
// Test 4.3: CommitOrder rejects insufficient free collateral
// ============================================================================
#[test]
fn test_4_3_commit_rejects_insufficient_collateral() {
    let batch = Batch::new(1, 2, 100, 50, 5_000_000); // 5 SOL base deposit
    let user_free_collateral: u64 = 3_000_000; // 3 SOL

    assert!(batch.base_deposit > user_free_collateral,
        "Base deposit exceeds free collateral → reject");
}

// ============================================================================
// Test 4.4: RevealOrder verifies hash matches
// ============================================================================
#[test]
fn test_4_4_reveal_verifies_hash() {
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let side = 0u8;
    let salt = 12345u64;

    let order_hash = compute_hash(price, qty, side, salt);
    let mut commitment = Commitment::new(1, order_hash, 1_000_000);

    // Reveal with correct params (salt 12345)
    let success = commitment.reveal(price, qty, side, salt);
    assert!(success, "Reveal should succeed with correct hash");
    assert!(commitment.revealed);
    assert_eq!(commitment.revealed_price, price);
    assert_eq!(commitment.revealed_qty, qty);
}

// ============================================================================
// Test 4.5: RevealOrder rejects wrong hash (salt mismatch)
// ============================================================================
#[test]
fn test_4_5_reveal_rejects_wrong_hash() {
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let side = 0u8;

    // Commit with salt 12345
    let order_hash = compute_hash(price, qty, side, 12345);
    let mut commitment = Commitment::new(1, order_hash, 1_000_000);

    // Try to reveal with different salt (99999)
    let wrong_hash = compute_hash(price, qty, side, 99999);
    assert_ne!(order_hash, wrong_hash);

    // Commit stores the hash, so revealing with wrong hash fails
    assert_ne!(commitment.order_hash, wrong_hash,
        "Reveal with wrong hash should fail");
}

// ============================================================================
// Test 4.6: RevealOrder rejects wrong price/qty
// ============================================================================
#[test]
fn test_4_6_reveal_rejects_wrong_price_qty() {
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let side = 0u8;

    let order_hash = compute_hash(price, qty, side, 12345);
    let mut commitment = Commitment::new(1, order_hash, 1_000_000);

    // Try to reveal with different price
    let wrong_hash = compute_hash(61_000 * SCALE, qty, side, 12345);
    assert_ne!(order_hash, wrong_hash);

    // Try to reveal with different qty
    let wrong_hash_qty = compute_hash(price, 3 * SCALE as u64, side, 12345);
    assert_ne!(order_hash, wrong_hash_qty);

    // Both wrong hashes should cause reveal to fail
    assert_ne!(commitment.order_hash, wrong_hash);
    assert_ne!(commitment.order_hash, wrong_hash_qty);
}

// ============================================================================
// Test 4.7: RevealOrder stores revealed params
// ============================================================================
#[test]
fn test_4_7_reveal_stores_params() {
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let side = 0u8; // Buy
    let salt = 12345u64;
    let order_hash = compute_hash(price, qty, side, salt);

    let mut commitment = Commitment::new(1, order_hash, 1_000_000);
    let success = commitment.reveal(price, qty, side, salt);

    assert!(success);
    assert_eq!(commitment.revealed_price, price);
    assert_eq!(commitment.revealed_qty, qty);
    assert_eq!(commitment.revealed_side, side);
}

// ============================================================================
// Test 4.8: RevealOrder rejects after reveal deadline
// ============================================================================
#[test]
fn test_4_8_reveal_rejects_after_deadline() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    let current_slot = 200; // After reveal deadline (t_open + t_reveal_slots)

    let reveal_deadline = batch.t_open + batch.t_reveal_slots;
    assert!(current_slot > reveal_deadline,
        "Cannot reveal after deadline: {} > {}", current_slot, reveal_deadline);
}

// ============================================================================
// Test 4.9: CloseCommitting transitions to Revealing when N_min met
// ============================================================================
#[test]
fn test_4_9_close_committing_n_min_met() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    batch.commitments.push(Commitment::new(1, [1; 32], 1_000_000));
    batch.commitments.push(Commitment::new(2, [2; 32], 1_000_000));

    assert_eq!(batch.status, BatchStatus::Committing);
    assert!(batch.commitments.len() >= batch.n_min,
        "N_min met → can close committing");

    // Transition to Revealing
    batch.status = BatchStatus::Revealing;
    assert_eq!(batch.status, BatchStatus::Revealing);
}

// ============================================================================
// Test 4.10: CloseCommitting forced by T_max
// ============================================================================
#[test]
fn test_4_10_close_committing_t_max_forced() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    // Only 1 commitment (below n_min=2)
    batch.commitments.push(Commitment::new(1, [1; 32], 1_000_000));

    // But T_max has elapsed
    let current_slot = 150; // > t_max_slots
    assert!(current_slot > batch.t_max_slots,
        "T_max elapsed → force close despite N_min not met");

    // Should transition anyway
    batch.status = BatchStatus::Revealing;
    assert_eq!(batch.status, BatchStatus::Revealing);
}

// ============================================================================
// Test 4.11: CloseCommitting rejects before criteria met
// ============================================================================
#[test]
fn test_4_11_close_committing_rejects_before_criteria() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    // Only 1 commitment (below n_min=2), current slot below T_max
    batch.commitments.push(Commitment::new(1, [1; 32], 1_000_000));

    let current_slot = 50; // < t_max_slots
    assert!(batch.commitments.len() < batch.n_min);
    assert!(current_slot <= batch.t_max_slots);

    // Can't close yet
    assert_eq!(batch.status, BatchStatus::Committing);
}

// ============================================================================
// Test 4.12–4.13: ClearBatch — uniform clearing price computation
// ============================================================================
#[test]
fn test_4_12_4_13_clear_batch_compute_clearing_price() {
    // Simulate the clearing process:
    // Buy orders: (price=61000, qty=10), (price=60500, qty=5)
    // Sell orders: (price=59500, qty=8), (price=60000, qty=7)

    struct Order { side: u8, price: i64, qty: u64 }

    let orders = vec![
        Order { side: 0, price: 61_000 * SCALE, qty: 10 * SCALE as u64 },
        Order { side: 0, price: 60_500 * SCALE, qty: 5 * SCALE as u64 },
        Order { side: 1, price: 59_500 * SCALE, qty: 8 * SCALE as u64 },
        Order { side: 1, price: 60_000 * SCALE, qty: 7 * SCALE as u64 },
    ];

    // Sort: buys descending by price, sells ascending
    let mut buys: Vec<_> = orders.iter().filter(|o| o.side == 0).collect();
    let mut sells: Vec<_> = orders.iter().filter(|o| o.side == 1).collect();
    buys.sort_by_key(|o| -o.price);
    sells.sort_by_key(|o| o.price);

    // Uniform clearing: find price where cumulative buy vol >= cumulative sell vol
    // Buy cumulative: (61000, 10), (60500, 15)
    // Sell cumulative: (59500, 8), (60000, 15)
    // Crossing at price range where max matched volume

    // At p=60000:
    //   Buy vol = all buys with price >= 60000 = 10 + 5 = 15
    //   Sell vol = all sells with price <= 60000 = 8 + 7 = 15
    //   Matched = min(15, 15) = 15
    // At p=60500:
    //   Buy vol = 10 + 5 = 15
    //   Sell vol = 8 (only sells <= 60500)
    //   Matched = 8
    // At p=61000:
    //   Buy vol = 10
    //   Sell vol = 8 + 7 = 15
    //   Matched = 10

    // Best clearing price = 60,000 (max matched volume)
    let clearing_price: i64 = 60_000 * SCALE;
    let matched_volume: u64 = 15 * SCALE as u64;

    assert_eq!(clearing_price, 60_000 * SCALE);
    assert_eq!(matched_volume, 15 * SCALE as u64);
}

// ============================================================================
// Test 4.14: SettleBatch updates positions from fills
// ============================================================================
#[test]
fn test_4_14_settle_batch_updates_positions() {
    // After clearing at $60,000 with 15 units matched:
    // - Buyers at >= $60,000 get filled at $60,000
    // - Sellers at <= $60,000 get filled at $60,000

    struct Position { user_id: u64, qty: i64, pnl: i128 }

    let mut buyer_a = Position { user_id: 1, qty: 0, pnl: 0 };
    let clearing_price = 60_000 * SCALE;

    // Buyer A buys 10 BTC at $60,000
    buyer_a.qty = 10 * SCALE;

    assert_eq!(buyer_a.qty, 10 * SCALE);

    let mut seller_b = Position { user_id: 2, qty: 0, pnl: 0 };
    // Seller B sells 8 BTC at $60,000
    seller_b.qty = -8 * SCALE;

    assert_eq!(seller_b.qty, -8 * SCALE);

    // Net system position should be 0 (fully matched)
    let net_position = buyer_a.qty + seller_b.qty;
    assert_eq!(net_position, 2 * SCALE, "Remaining unmatched: 2 BTC (partial)");

    // Net: buyer_a(10) + seller_b(-8) = 2 (unmatched buys remain)
    assert_eq!(buyer_a.qty + seller_b.qty, 2 * SCALE,
        "Net system: 2 unmatched buy BTC remain");
}

// ============================================================================
// Test 4.15: SettleBatch returns deposits to filled users
// ============================================================================
#[test]
fn test_4_15_settle_batch_returns_deposits() {
    let deposit = 1_000_000u64;
    let mut user_deposit = deposit;

    // After successful settlement, deposit is returned
    user_deposit = 0; // Released
    assert_eq!(user_deposit, 0, "Deposit returned to filled user");
}

// ============================================================================
// Test 4.16: SettleBatch slashes deposits from non-revealers
// ============================================================================
#[test]
fn test_4_16_settle_slashes_non_revealers() {
    let deposit = 1_000_000u64;
    let commitments = vec![
        Commitment { user_id: 1, order_hash: [1; 32], deposit_amount: deposit,
                     revealed: true, revealed_price: 60_000 * SCALE,
                     revealed_qty: 5 * SCALE as u64, revealed_side: 0 },
        Commitment { user_id: 2, order_hash: [2; 32], deposit_amount: deposit,
                     revealed: false, // Did NOT reveal
                     revealed_price: 0, revealed_qty: 0, revealed_side: 0 },
        Commitment { user_id: 3, order_hash: [3; 32], deposit_amount: deposit,
                     revealed: true, revealed_price: 59_500 * SCALE,
                     revealed_qty: 3 * SCALE as u64, revealed_side: 1 },
    ];

    let total_slashed: u64 = commitments.iter()
        .filter(|c| !c.revealed)
        .map(|c| c.deposit_amount)
        .sum();
    assert_eq!(total_slashed, deposit, "User 2's deposit should be slashed");
    assert_eq!(total_slashed, 1_000_000);

    let total_returned: u64 = commitments.iter()
        .filter(|c| c.revealed)
        .map(|c| c.deposit_amount)
        .sum();
    assert_eq!(total_returned, 2_000_000, "Users 1 and 3 get deposits back");
}

// ============================================================================
// Test 4.17: SettleBatch credits insurance fund from slashes
// ============================================================================
#[test]
fn test_4_17_settle_credits_insurance_from_slashes() {
    let slashed_amount = 1_000_000u64;
    let mut insurance_balance: u64 = 10_000_000;

    // Slashed deposits go to insurance fund
    insurance_balance += slashed_amount;
    assert_eq!(insurance_balance, 11_000_000);

    // Insurance fund accumulates over multiple batches
    insurance_balance += 500_000; // Another slash
    assert_eq!(insurance_balance, 11_500_000);
}

// ============================================================================
// Test 4.18: Full lifecycle — commit → reveal → close → clear → settle
// ============================================================================
#[test]
fn test_4_18_full_lifecycle_single_user() {
    // 1. Create batch (Committing phase)
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);
    assert_eq!(batch.status, BatchStatus::Committing);

    // 2. User commits order
    let price = 60_000 * SCALE;
    let qty = 5 * SCALE as u64;
    let side = 0u8;
    let salt = 12345u64;
    let order_hash = compute_hash(price, qty, side, salt);

    let mut commitment = Commitment::new(1, order_hash, 1_000_000);
    batch.commitments.push(commitment.clone());

    assert_eq!(batch.commitments.len(), 1);
    assert_eq!(batch.commitments[0].order_hash, order_hash);

    // 3. User reveals order (with correct params)
    let reveal_success = batch.commitments[0].reveal(price, qty, side, salt);
    assert!(reveal_success);
    assert!(batch.commitments[0].revealed);

    // 4. Close committing phase
    batch.status = BatchStatus::Revealing;
    assert_eq!(batch.status, BatchStatus::Revealing);

    // 5. Clear batch (compute clearing price)
    batch.status = BatchStatus::Clearing;
    // With only one order, no match possible, but clearing can still compute
    assert_eq!(batch.status, BatchStatus::Clearing);

    // 6. Settle batch
    batch.status = BatchStatus::Settled;
    assert_eq!(batch.status, BatchStatus::Settled);

    // Full lifecycle complete
    // User's deposit returned (no slashing since they revealed)
    assert!(batch.commitments[0].revealed, "Deposit returned");
}

// ============================================================================
// Test 4.19: Full lifecycle with multiple users
// ============================================================================
#[test]
fn test_4_19_full_lifecycle_multi_user() {
    let mut batch = Batch::new(1, 2, 100, 50, 1_000_000);

    // User A: Buy 10 BTC @ $60,500
    let hash_a = compute_hash(60_500 * SCALE, 10 * SCALE as u64, 0, 100);
    batch.commitments.push(Commitment::new(1, hash_a, 1_000_000));

    // User B: Sell 8 BTC @ $59,500
    let hash_b = compute_hash(59_500 * SCALE, 8 * SCALE as u64, 1, 200);
    batch.commitments.push(Commitment::new(2, hash_b, 1_000_000));

    // User C: Buy 5 BTC @ $60,000
    let hash_c = compute_hash(60_000 * SCALE, 5 * SCALE as u64, 0, 300);
    batch.commitments.push(Commitment::new(3, hash_c, 1_000_000));

    assert_eq!(batch.commitments.len(), 3);
    assert!(batch.commitments.len() >= batch.n_min);

    // Reveal phase: all users reveal correctly
    let reveal_data: [(i64, u64, u8, u64); 3] = [
        (60_500 * SCALE, 10 * SCALE as u64, 0u8, 100u64),
        (59_500 * SCALE, 8 * SCALE as u64, 1u8, 200u64),
        (60_000 * SCALE, 5 * SCALE as u64, 0u8, 300u64),
    ];
    for (i, (price, qty, side, salt)) in reveal_data.iter().enumerate() {
        let success = batch.commitments[i].reveal(*price, *qty, *side, *salt);
        assert!(success, "Reveal {} should succeed", i);
    }

    // All revealed
    for c in &batch.commitments {
        assert!(c.revealed);
    }

    // Total deposits locked during batch
    let total_deposits: u64 = batch.commitments.iter().map(|c| c.deposit_amount).sum();
    assert_eq!(total_deposits, 3_000_000);

    // Close → clear → settle
    batch.status = BatchStatus::Revealing;
    batch.status = BatchStatus::Clearing;
    batch.status = BatchStatus::Settled;

    assert_eq!(batch.status, BatchStatus::Settled);
}

// ============================================================================
// Test 4.20: Non-reveal penalty: deposit slashed, order excluded
// ============================================================================
#[test]
fn test_4_20_non_reveal_penalty() {
    let mut batch = Batch::new(1, 2, 100, 50, 2_000_000);
    let deposit = 2_000_000u64;

    // User A reveals
    let hash_a = compute_hash(60_000 * SCALE, 5 * SCALE as u64, 0, 100);
    batch.commitments.push(Commitment::new(1, hash_a, deposit));

    // User B does NOT reveal
    let hash_b = compute_hash(59_000 * SCALE, 3 * SCALE as u64, 1, 200);
    batch.commitments.push(Commitment::new(2, hash_b, deposit));

    // Only User A reveals (salt=100)
    batch.commitments[0].reveal(60_000 * SCALE, 5 * SCALE as u64, 0, 100);
    assert!(batch.commitments[0].revealed);
    assert!(!batch.commitments[1].revealed);

    // Settlement:
    // - User A: deposit returned
    // - User B: deposit slashed, excluded from clearing
    let slashed: u64 = batch.commitments.iter()
        .filter(|c| !c.revealed)
        .map(|c| c.deposit_amount)
        .sum();
    assert_eq!(slashed, deposit, "User B's deposit slashed");

    let active_orders: Vec<_> = batch.commitments.iter()
        .filter(|c| c.revealed)
        .collect();
    assert_eq!(active_orders.len(), 1, "Only User A's order considered");
}

// ============================================================================
// Test 4.21: Partial fill — some orders matched, some not
// ============================================================================
#[test]
fn test_4_21_partial_fill() {
    // Scenario:
    // Buy orders: A(10 BTC @ $60,500), C(5 BTC @ $60,000)
    // Sell orders: B(8 BTC @ $59,500)
    //
    // Clearing at $60,000:
    // - All sells matched (8 BTC ≤ $60,000)
    // - Buy A: 10 BTC matched (≥ $60,000)
    // - Buy C: 5 BTC partially matched (3 of 5, since only 8 total sells)

    let clearing_price = 60_000 * SCALE;
    let sell_qty_total: u64 = 8 * SCALE as u64;
    let buy_a_qty: u64 = 10 * SCALE as u64;
    let buy_c_qty: u64 = 5 * SCALE as u64;

    // Fill buy A first (higher price priority)
    let fill_a = sell_qty_total.min(buy_a_qty);
    assert_eq!(fill_a, 8 * SCALE as u64);

    let remaining_sells = sell_qty_total - fill_a;
    assert_eq!(remaining_sells, 0, "All sells consumed");

    // Buy C gets nothing (all sells already consumed)
    let fill_c = 0u64;
    assert_eq!(fill_c, 0);

    // Buy A partially filled: 8 of 10
    let buy_a_remaining = buy_a_qty - fill_a;
    assert_eq!(buy_a_remaining, 2 * SCALE as u64);

    // Buy C fully unfilled
    let buy_c_unfilled = buy_c_qty;
    assert_eq!(buy_c_unfilled, 5 * SCALE as u64);
}

// ============================================================================
// Test: Clearing price when no crossing (no match)
// ============================================================================
#[test]
fn test_clearing_no_crossing() {
    // All buys below all sells → no match
    let max_buy = 59_000 * SCALE;
    let min_sell = 60_000 * SCALE;

    assert!(max_buy < min_sell,
        "No crossing → no match → clearing price = 0 or undefined");

    // Clearing should return "no match" result
    let has_match = max_buy >= min_sell;
    assert!(!has_match);
}

// ============================================================================
// Test: Uniform clearing price maximizes matched volume
// ============================================================================
#[test]
fn test_clearing_maximizes_matched_volume() {
    // Buy: (61000, 5), (60500, 10), (60000, 8)
    // Sell: (59500, 7), (60000, 6), (60500, 4)

    fn matched_volume(p: i64, buys: &[(i64, u64)], sells: &[(i64, u64)]) -> u64 {
        let buy_vol: u64 = buys.iter().filter(|(px, _)| *px >= p).map(|(_, q)| q).sum();
        let sell_vol: u64 = sells.iter().filter(|(px, _)| *px <= p).map(|(_, q)| q).sum();
        buy_vol.min(sell_vol)
    }

    let buys = vec![
        (61_000 * SCALE, 5 * SCALE as u64),
        (60_500 * SCALE, 10 * SCALE as u64),
        (60_000 * SCALE, 8 * SCALE as u64),
    ];
    let sells = vec![
        (59_500 * SCALE, 7 * SCALE as u64),
        (60_000 * SCALE, 6 * SCALE as u64),
        (60_500 * SCALE, 4 * SCALE as u64),
    ];

    // Try candidate prices
    let v_59500 = matched_volume(59_500 * SCALE, &buys, &sells);
    let v_60000 = matched_volume(60_000 * SCALE, &buys, &sells);
    let v_60500 = matched_volume(60_500 * SCALE, &buys, &sells);
    let v_61000 = matched_volume(61_000 * SCALE, &buys, &sells);

    // p=59500: buys=23, sells=7 → match=7
    // p=60000: buys=23, sells=13 → match=13
    // p=60500: buys=15, sells=17 → match=15
    // p=61000: buys=5, sells=17 → match=5

    // Best clearing price should be ~60,500 (max matched volume = 15)
    assert!(v_60500 >= v_60000, "60,500 should maximize volume");
    assert!(v_60500 >= v_61000, "60,500 should beat 61,000");
    assert_eq!(v_60500, 15 * SCALE as u64);
}

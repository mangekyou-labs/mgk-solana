use super::order::LimitOrder;

/// splitmix64 PRNG — deterministic, well-distributed, suitable for shuffle seeding.
///
/// Reference: Stafford variant of Mix13.
/// Algorithm: increment state by a fixed golden-ratio constant, then mix bits
/// via three xorshift-multiplied stages.
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Fisher-Yates shuffle of revealed orders in place, seeded by `seed`.
///
/// The seed is intended to be `close_slot` from `close_committing`, which is
/// consensus-derived and unpredictable during the commit phase. This makes
/// the shuffle ordering non-deterministic for observers at commit time but
/// fully deterministic at clear time.
///
/// Algorithm (modern, O(n)):
///   for i in (1..n).rev():
///       j = rng() % (i + 1)
///       swap(arr[i], arr[j])
pub fn shuffle_orders(orders: &mut [LimitOrder], seed: u64) {
    let n = orders.len();
    if n < 2 {
        return;
    }
    let mut state = seed;
    // Walk from end to beginning; each step picks an index in [0, i].
    let mut i = n - 1;
    while i > 0 {
        let r = splitmix64(&mut state);
        // Use modular reduction. splitmix64's low bits are well-mixed so this
        // is acceptable for the small n (≤ MAX_ORDERS=64) we deal with.
        let j = (r % (i as u64 + 1)) as usize;
        if i != j {
            orders.swap(i, j);
        }
        i -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::{OrderType, Side};
    use pinocchio::pubkey::Pubkey;

    fn make_orders(n: usize) -> [LimitOrder; 64] {
        let mut arr = [LimitOrder {
            user: Pubkey::default(),
            instrument_id: 0,
            order_type: OrderType::LimitGTC,
            side: Side::Buy,
            price: 0,
            qty: 0,
            reduce_only: false,
            cancel_order_id: 0,
        is_maker: false,
        }; 64];
        for (i, slot) in arr.iter_mut().enumerate().take(n) {
            let mut user_bytes = [0u8; 32];
            user_bytes[0] = (i + 1) as u8;
            *slot = LimitOrder {
                user: Pubkey::from(user_bytes),
                instrument_id: 0,
                order_type: OrderType::LimitGTC,
                side: Side::Buy,
                price: 100,
                qty: (i as u64) + 1, // unique qty lets us track original position
                reduce_only: false,
                cancel_order_id: 0,
            is_maker: false,
            };
        }
        arr
    }

    #[test]
    fn test_splitmix64_deterministic() {
        let mut s1: u64 = 12345;
        let mut s2: u64 = 12345;
        for _ in 0..100 {
            assert_eq!(splitmix64(&mut s1), splitmix64(&mut s2));
        }
    }

    #[test]
    fn test_splitmix64_avalanche() {
        // Flipping one bit in the seed should produce very different output.
        let mut a: u64 = 0;
        let mut b: u64 = 1;
        let ra = splitmix64(&mut a);
        let rb = splitmix64(&mut b);
        assert_ne!(ra, rb);
        // Hamming distance should be substantial — at least 16 bits differ.
        let diff = ra ^ rb;
        let bits = diff.count_ones();
        assert!(bits >= 16, "Avalanche too weak: {} bits differ", bits);
    }

    #[test]
    fn test_shuffle_deterministic_same_seed() {
        let mut a = make_orders(8);
        let mut b = make_orders(8);
        shuffle_orders(&mut a[..8], 42);
        shuffle_orders(&mut b[..8], 42);
        for i in 0..8 {
            assert_eq!(a[i].qty, b[i].qty, "Position {} differs", i);
        }
    }

    #[test]
    fn test_shuffle_different_seeds_differ() {
        let mut a = make_orders(8);
        let mut b = make_orders(8);
        shuffle_orders(&mut a[..8], 1);
        shuffle_orders(&mut b[..8], 2);
        let same = (0..8).all(|i| a[i].qty == b[i].qty);
        assert!(!same, "Different seeds should produce different orderings");
    }

    #[test]
    fn test_shuffle_actually_permutes() {
        // qty encodes original position, so a non-identity permutation means
        // at least one element moved.
        let mut arr = make_orders(8);
        shuffle_orders(&mut arr[..8], 99);
        let mut any_moved = false;
        for (i, o) in arr[..8].iter().enumerate() {
            if o.qty != (i as u64) + 1 {
                any_moved = true;
                break;
            }
        }
        assert!(any_moved, "Shuffle should move at least one element");
    }

    #[test]
    fn test_shuffle_preserves_all_elements() {
        // After shuffling, the set of qtys should be identical.
        let mut arr = make_orders(8);
        let original: [u64; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
        shuffle_orders(&mut arr[..8], 7777);
        let mut got = [0u64; 8];
        for (i, o) in arr[..8].iter().enumerate() {
            got[i] = o.qty;
        }
        let mut got_sorted = got;
        let mut orig_sorted = original;
        got_sorted.sort_unstable();
        orig_sorted.sort_unstable();
        assert_eq!(got_sorted, orig_sorted);
    }

    #[test]
    fn test_shuffle_empty_and_singleton() {
        let mut empty: [LimitOrder; 0] = [];
        shuffle_orders(&mut empty, 123);
        // No panic, no-op.
        let mut single = make_orders(1);
        shuffle_orders(&mut single[..1], 123);
        // Singleton stays put.
        assert_eq!(single[0].qty, 1);
    }

    #[test]
    fn test_shuffle_full_batch_64() {
        // Exercise the full MAX_ORDERS capacity.
        let mut arr = make_orders(64);
        shuffle_orders(&mut arr[..64], 0xDEAD_BEEF);
        // No panics. Verify it's a permutation by sorting qtys.
        let mut qtys: [u64; 64] = [0; 64];
        for (i, o) in arr[..64].iter().enumerate() {
            qtys[i] = o.qty;
        }
        qtys.sort_unstable();
        for (i, &q) in qtys.iter().enumerate() {
            assert_eq!(q, (i as u64) + 1);
        }
    }
}

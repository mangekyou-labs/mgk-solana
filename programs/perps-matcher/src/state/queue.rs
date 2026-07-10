use super::order::{LimitOrder, OrderType};
use crate::state::clearing::MAX_ORDERS;
use core::mem;

/// Orders partitioned into three priority queues, stored in a single array.
///
/// Layout:
/// - `[0, cancel_count)`              = Cancels (Cancel + CancelAll)
/// - `[cancel_count, ...alo_count)`   = ALO / Post-Only (LimitALO)
/// - `[...alo_count, ...regular)`     = Regular (LimitGTC, LimitIOC, Market)
///
/// The matching engine processes queues in this order: cancels first, then
/// ALOs, then regulars. Within each queue, the relative ordering of the
/// input slice is preserved (which, after 6b's Fisher-Yates shuffle, is
/// the random fair-ordering).
pub struct PartitionedOrders {
    pub orders: [LimitOrder; MAX_ORDERS],
    pub cancel_count: usize,
    pub alo_count: usize,
    pub regular_count: usize,
}

impl Default for PartitionedOrders {
    fn default() -> Self {
        Self::new()
    }
}

impl PartitionedOrders {
    pub fn new() -> Self {
        Self {
            orders: [LimitOrder {
                user: pinocchio::pubkey::Pubkey::default(),
                instrument_id: 0,
                order_type: OrderType::LimitGTC,
                side: super::order::Side::Buy,
                price: 0,
                qty: 0,
                reduce_only: false,
                cancel_order_id: 0,
            }; MAX_ORDERS],
            cancel_count: 0,
            alo_count: 0,
            regular_count: 0,
        }
    }

    /// Zero this struct in-place without initializing the orders array on the
    /// caller's frame. BPF-safe alternative to `new()`.
    #[inline(always)]
    pub fn zeroed_in_place(&mut self) {
        // SAFETY: LimitOrder is repr(C) with only Copy fields; any byte
        // pattern is valid. The caller owns this memory.
        for o in self.orders.iter_mut() {
            *o = unsafe { mem::zeroed() };
        }
        self.cancel_count = 0;
        self.alo_count = 0;
        self.regular_count = 0;
    }

    pub fn cancels(&self) -> &[LimitOrder] {
        &self.orders[..self.cancel_count]
    }

    pub fn alos(&self) -> &[LimitOrder] {
        &self.orders[self.cancel_count..self.cancel_count + self.alo_count]
    }

    pub fn regulars(&self) -> &[LimitOrder] {
        &self.orders[self.cancel_count + self.alo_count..self.cancel_count + self.alo_count + self.regular_count]
    }

    pub fn total(&self) -> usize {
        self.cancel_count + self.alo_count + self.regular_count
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }
}

/// Partition `input` into Cancels, ALOs, and Regular queues, preserving the
/// relative order of `input` within each queue.
///
/// The caller is expected to pass already-shuffled orders (per 6b) so that
/// within-queue order is the fair random ordering.
pub fn separate_priority_queues(input: &[LimitOrder], out: &mut PartitionedOrders) {
    // First pass: count each type, capped at MAX_ORDERS to prevent overflow.
    let mut n_cancel: usize = 0;
    let mut n_alo: usize = 0;
    let mut n_regular: usize = 0;
    for o in input.iter() {
        match o.order_type {
            OrderType::Cancel | OrderType::CancelAll => {
                if n_cancel < MAX_ORDERS {
                    n_cancel += 1;
                }
            }
            OrderType::LimitALO => {
                if n_alo < MAX_ORDERS {
                    n_alo += 1;
                }
            }
            _ => {
                if n_regular < MAX_ORDERS {
                    n_regular += 1;
                }
            }
        }
    }

    out.cancel_count = n_cancel;
    out.alo_count = n_alo;
    out.regular_count = n_regular;

    let alo_base = n_cancel;
    let regular_base = n_cancel + n_alo;

    // Second pass: write to correct slot. ci/ai/ri are position-within-queue
    // counters; the actual array index is `base + counter`.
    let mut ci: usize = 0;
    let mut ai: usize = 0;
    let mut ri: usize = 0;

    for o in input.iter() {
        match o.order_type {
            OrderType::Cancel | OrderType::CancelAll => {
                if ci < n_cancel {
                    out.orders[ci] = *o;
                    ci += 1;
                }
            }
            OrderType::LimitALO => {
                if ai < n_alo {
                    out.orders[alo_base + ai] = *o;
                    ai += 1;
                }
            }
            _ => {
                if ri < n_regular {
                    out.orders[regular_base + ri] = *o;
                    ri += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::{OrderType, Side};
    use pinocchio::pubkey::Pubkey;

    fn make_order(byte: u8, order_type: OrderType) -> LimitOrder {
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = byte;
        LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type,
            side: Side::Buy,
            price: 100,
            qty: byte as u64, // unique qty tracks input order
            reduce_only: false,
            cancel_order_id: 0,
        }
    }

    fn partition(input: &[LimitOrder]) -> PartitionedOrders {
        let mut out = PartitionedOrders::new();
        separate_priority_queues(input, &mut out);
        out
    }

    #[test]
    fn test_priority_ordering_cancels_first() {
        // Mix of all types — verify cancels come first, then ALOs, then regulars.
        let input = [
            make_order(1, OrderType::LimitGTC),
            make_order(2, OrderType::Cancel),
            make_order(3, OrderType::Market),
            make_order(4, OrderType::LimitALO),
            make_order(5, OrderType::LimitIOC),
            make_order(6, OrderType::CancelAll),
        ];
        let p = partition(&input);
        assert_eq!(p.cancel_count, 2);
        assert_eq!(p.alo_count, 1);
        assert_eq!(p.regular_count, 3);

        // Cancels section comes first.
        for o in p.cancels() {
            assert!(o.order_type.is_cancel());
        }
        // ALO section second.
        for o in p.alos() {
            assert_eq!(o.order_type, OrderType::LimitALO);
        }
        // Regular section last — GTC, IOC, Market.
        for o in p.regulars() {
            assert!(matches!(
                o.order_type,
                OrderType::LimitGTC | OrderType::LimitIOC | OrderType::Market
            ));
        }
    }

    #[test]
    fn test_preserves_input_order_within_each_queue() {
        // Input order within each type is preserved.
        let input = [
            make_order(10, OrderType::Cancel),    // cancel[0]
            make_order(20, OrderType::LimitGTC),  // regular[0]
            make_order(30, OrderType::LimitALO),  // alo[0]
            make_order(40, OrderType::Cancel),    // cancel[1]
            make_order(50, OrderType::LimitALO),  // alo[1]
            make_order(60, OrderType::Market),    // regular[1]
        ];
        let p = partition(&input);
        assert_eq!(p.cancel_count, 2);
        assert_eq!(p.alo_count, 2);
        assert_eq!(p.regular_count, 2);

        // Within cancels: 10 then 40 (input order).
        assert_eq!(p.cancels()[0].qty, 10);
        assert_eq!(p.cancels()[1].qty, 40);
        // Within ALOs: 30 then 50.
        assert_eq!(p.alos()[0].qty, 30);
        assert_eq!(p.alos()[1].qty, 50);
        // Within regulars: 20 then 60.
        assert_eq!(p.regulars()[0].qty, 20);
        assert_eq!(p.regulars()[1].qty, 60);
    }

    #[test]
    fn test_empty_input() {
        let p = partition(&[]);
        assert_eq!(p.total(), 0);
        assert!(p.is_empty());
        assert_eq!(p.cancels().len(), 0);
        assert_eq!(p.alos().len(), 0);
        assert_eq!(p.regulars().len(), 0);
    }

    #[test]
    fn test_all_cancels() {
        let input = [
            make_order(1, OrderType::Cancel),
            make_order(2, OrderType::CancelAll),
            make_order(3, OrderType::Cancel),
        ];
        let p = partition(&input);
        assert_eq!(p.cancel_count, 3);
        assert_eq!(p.alo_count, 0);
        assert_eq!(p.regular_count, 0);
    }

    #[test]
    fn test_no_cancels_no_alos() {
        let input = [
            make_order(1, OrderType::LimitGTC),
            make_order(2, OrderType::Market),
            make_order(3, OrderType::LimitIOC),
        ];
        let p = partition(&input);
        assert_eq!(p.cancel_count, 0);
        assert_eq!(p.alo_count, 0);
        assert_eq!(p.regular_count, 3);
    }

    #[test]
    fn test_market_is_regular() {
        let input = [make_order(1, OrderType::Market)];
        let p = partition(&input);
        assert_eq!(p.cancel_count, 0);
        assert_eq!(p.alo_count, 0);
        assert_eq!(p.regular_count, 1);
        assert_eq!(p.regulars()[0].order_type, OrderType::Market);
    }

    #[test]
    fn test_partition_preserves_all_elements() {
        // After partition, the set of qtys should be identical to input.
        let input = [
            make_order(1, OrderType::LimitGTC),
            make_order(2, OrderType::Cancel),
            make_order(3, OrderType::LimitALO),
            make_order(4, OrderType::Market),
            make_order(5, OrderType::LimitIOC),
            make_order(6, OrderType::CancelAll),
        ];
        let p = partition(&input);
        let mut from_partitions: [u64; 6] = [0; 6];
        for (i, o) in p.cancels().iter().enumerate() {
            from_partitions[i] = o.qty;
        }
        for (i, o) in p.alos().iter().enumerate() {
            from_partitions[p.cancel_count + i] = o.qty;
        }
        for (i, o) in p.regulars().iter().enumerate() {
            from_partitions[p.cancel_count + p.alo_count + i] = o.qty;
        }
        let mut got_sorted = from_partitions;
        let mut orig_sorted = [1u64, 2, 3, 4, 5, 6];
        got_sorted.sort_unstable();
        orig_sorted.sort_unstable();
        assert_eq!(got_sorted, orig_sorted);
    }

    #[test]
    fn test_full_batch_64() {
        // 64 orders, mix of all types. After partition, total == 64.
        let mut input: [LimitOrder; 64] = [make_order(0, OrderType::LimitGTC); 64];
        let types = [
            OrderType::LimitGTC,
            OrderType::LimitIOC,
            OrderType::LimitALO,
            OrderType::Market,
            OrderType::Cancel,
            OrderType::CancelAll,
        ];
        for (i, slot) in input.iter_mut().enumerate() {
            let mut user_bytes = [0u8; 32];
            user_bytes[0] = (i + 1) as u8;
            *slot = LimitOrder {
                user: Pubkey::from(user_bytes),
                instrument_id: 0,
                order_type: types[i % 6],
                side: Side::Buy,
                price: 100,
                qty: (i + 1) as u64,
                reduce_only: false,
                cancel_order_id: 0,
            };
        }
        let p = partition(&input);
        assert_eq!(p.total(), 64);
        assert!(p.cancel_count > 0);
        assert!(p.alo_count > 0);
        assert!(p.regular_count > 0);
    }
}

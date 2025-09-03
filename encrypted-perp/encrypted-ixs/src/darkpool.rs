use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    #[derive(Clone, Debug)]
    pub struct DarkOrder {
        pub owner: [u8; 32],         // Pubkey of order owner
        pub side: u8,                // 0 = long, 1 = short
        pub size_usd: u64,           // Position size in USD (6 decimals)
        pub collateral_amount: u64,   // Collateral amount
        pub max_price: u64,          // Maximum acceptable price (for longs) or minimum (for shorts)
        pub leverage: u64,           // Leverage multiplier
        pub pool: [u8; 32],          // Pool pubkey
        pub custody: [u8; 32],       // Custody pubkey (target asset)
        pub collateral_custody: [u8; 32], // Collateral custody pubkey
        pub timestamp: u64,          // Order timestamp
        pub nonce: u64,              // Unique order identifier
    }

    #[derive(Clone, Debug)]
    pub struct OrderMatch {
        pub order_a: DarkOrder,
        pub order_b: DarkOrder,
        pub matched_size: u64,
        pub execution_price: u64,
        pub timestamp: u64,
    }

    #[derive(Clone, Debug)]
    pub struct MatchResult {
        pub matches: Vec<OrderMatch>,
        pub total_volume: u64,
        pub average_price: u64,
        pub timestamp: u64,
    }

    #[derive(Clone, Debug)]
    pub struct OrderBook {
        pub orders: Vec<DarkOrder>,
        pub last_update: u64,
    }

    impl OrderBook {
        pub fn new() -> Self {
            Self {
                orders: Vec::new(),
                last_update: 0,
            }
        }

        pub fn add_order(&mut self, order: DarkOrder) {
            self.orders.push(order);
            self.last_update = order.timestamp;
        }

        pub fn remove_order(&mut self, nonce: u64) {
            self.orders.retain(|order| order.nonce != nonce);
        }
    }

    // Submit encrypted order to the dark pool
    #[instruction]
    pub fn submit_dark_order(
        order_context: Enc<Shared, DarkOrder>
    ) -> Enc<Shared, bool> {
        let order = order_context.to_arcis();
        
        // Basic validation in encrypted environment
        let is_valid = order.size_usd > 0 
            && order.collateral_amount > 0 
            && order.leverage > 0 
            && order.leverage <= 100  // Max 100x leverage
            && order.max_price > 0
            && (order.side == 0 || order.side == 1);

        order_context.owner.from_arcis(is_valid)
    }

    // Match orders in encrypted environment
    #[instruction]
    pub fn match_dark_orders(
        orders_context: Enc<Shared, Vec<DarkOrder>>
    ) -> Enc<Shared, MatchResult> {
        let orders = orders_context.to_arcis();
        let mut matches = Vec::new();
        let mut total_volume = 0u64;
        let mut total_value = 0u64;
        let current_time = 1600000000u64; // Placeholder timestamp

        // Simple matching algorithm - match opposing sides
        for i in 0..orders.len() {
            for j in (i + 1)..orders.len() {
                let order_a = &orders[i];
                let order_b = &orders[j];

                // Check if orders can match (opposite sides, compatible prices)
                if can_match(order_a, order_b) {
                    let execution_price = calculate_execution_price(order_a, order_b);
                    let matched_size = order_a.size_usd.min(order_b.size_usd);

                    let order_match = OrderMatch {
                        order_a: order_a.clone(),
                        order_b: order_b.clone(),
                        matched_size,
                        execution_price,
                        timestamp: current_time,
                    };

                    total_volume += matched_size;
                    total_value += matched_size * execution_price;
                    matches.push(order_match);
                }
            }
        }

        let average_price = if total_volume > 0 {
            total_value / total_volume
        } else {
            0
        };

        let result = MatchResult {
            matches,
            total_volume,
            average_price,
            timestamp: current_time,
        };

        orders_context.owner.from_arcis(result)
    }

    // Helper function to check if two orders can match
    fn can_match(order_a: &DarkOrder, order_b: &DarkOrder) -> bool {
        // Orders must be on opposite sides
        if order_a.side == order_b.side {
            return false;
        }

        // Orders must be for the same pool and custody
        if order_a.pool != order_b.pool || order_a.custody != order_b.custody {
            return false;
        }

        // Price compatibility check
        match (order_a.side, order_b.side) {
            (0, 1) => order_a.max_price >= order_b.max_price, // long vs short
            (1, 0) => order_b.max_price >= order_a.max_price, // short vs long
            _ => false,
        }
    }

    // Calculate execution price for matched orders
    fn calculate_execution_price(order_a: &DarkOrder, order_b: &DarkOrder) -> u64 {
        // Use midpoint of the two limit prices
        (order_a.max_price + order_b.max_price) / 2
    }

    // Batch process multiple order submissions
    #[instruction]
    pub fn batch_process_orders(
        batch_context: Enc<Shared, Vec<DarkOrder>>
    ) -> Enc<Shared, MatchResult> {
        let orders = batch_context.to_arcis();
        let mut order_book = OrderBook::new();

        // Add all valid orders to the order book
        for order in orders {
            if order.size_usd > 0 && order.collateral_amount > 0 {
                order_book.add_order(order);
            }
        }

        // Create context for matching
        let orders_for_matching = batch_context.owner.from_arcis(order_book.orders);
        
        // Use the matching function
        match_dark_orders(Enc::new(orders_for_matching, batch_context.owner))
    }

    // Calculate position metrics in encrypted environment
    #[instruction]
    pub fn calculate_position_metrics(
        position_data: Enc<Shared, (u64, u64, u64)> // (size_usd, collateral, price)
    ) -> Enc<Shared, (u64, u64)> { // (pnl, liquidation_price)
        let (size_usd, collateral, entry_price) = position_data.to_arcis();
        
        // Simplified PnL calculation (would need current price in real implementation)
        let current_price = entry_price; // Placeholder
        let pnl = if current_price > entry_price {
            ((current_price - entry_price) * size_usd) / entry_price
        } else {
            ((entry_price - current_price) * size_usd) / entry_price
        };

        // Simplified liquidation price calculation (90% of collateral)
        let liquidation_threshold = (collateral * 90) / 100;
        let liquidation_price = if entry_price > liquidation_threshold {
            entry_price - liquidation_threshold
        } else {
            0
        };

        position_data.owner.from_arcis((pnl, liquidation_price))
    }
}

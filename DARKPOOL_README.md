# Darkpool Perpetuals DEX

A privacy-preserving perpetuals DEX built on Solana using Arcium's Multi-Party Computation (MPC) network for order-level confidentiality.

## Overview

This project implements a darkpool for perpetual futures trading that prevents liquidation attacks by hiding order details on-chain. It integrates with the existing Solana Perpetuals program while adding encrypted order submission and matching through Arcium's confidential computing infrastructure.

## Architecture

### 1. Encrypted Order Flow

```
User → Encrypted Order → Arcium MPC → Order Matching → Settlement → Perpetuals Program
```

**Key Components:**
- **Frontend**: Client-side order encryption using Arcium SDK
- **Darkpool Program**: Manages encrypted order submission and validation  
- **Arcium MPC Network**: Performs confidential order matching off-chain
- **Settlement Bridge**: Processes matched trades with the main perpetuals program
- **Perpetuals Program**: Handles position updates and collateral management

### 2. Privacy Protection

- **Order Encryption**: Order details (size, price, side) are encrypted client-side
- **Confidential Matching**: Order matching happens in encrypted environment via MPC
- **Minimal On-Chain Exposure**: Only settlement results are visible on-chain
- **MEV Protection**: Prevents front-running and sandwich attacks
- **Liquidation Attack Prevention**: Hides position details from potential attackers

## Implementation Details

### Encrypted Instructions (`encrypted-ixs/`)

**Key Functions:**
- `submit_dark_order()`: Validates encrypted orders in MPC environment
- `match_dark_orders()`: Matches opposing orders confidentially
- `batch_process_orders()`: Handles multiple orders efficiently
- `calculate_position_metrics()`: Computes PnL and liquidation prices privately

**Order Structure:**
```rust
pub struct DarkOrder {
    pub owner: [u8; 32],           // Trader's public key
    pub side: u8,                  // 0=long, 1=short  
    pub size_usd: u64,             // Position size
    pub collateral_amount: u64,     // Collateral required
    pub max_price: u64,            // Limit price
    pub leverage: u64,             // Leverage multiplier
    pub pool: [u8; 32],            // Pool identifier
    pub custody: [u8; 32],         // Asset custody
    pub collateral_custody: [u8; 32], // Collateral custody
    pub timestamp: u64,            // Order timestamp
    pub nonce: u64,               // Unique identifier
}
```

### Darkpool Program (`programs/mgk_program/src/darkpool.rs`)

**Core Instructions:**
- `initialize_darkpool()`: Sets up darkpool configuration
- `submit_dark_order()`: Submits encrypted order to MPC network
- `match_dark_orders()`: Triggers confidential order matching
- `settle_dark_pool_trades()`: Processes settlement data

**Account Structure:**
```rust
pub struct Darkpool {
    pub authority: Pubkey,
    pub perpetuals_program: Pubkey,
    pub min_order_size: u64,
    pub max_order_size: u64,
    pub fee_rate: u16,
    pub total_orders: u64,
    pub total_matches: u64,
    pub total_settlements: u64,
    pub total_volume: u64,
    // ... statistics and metadata
}
```

### Settlement Integration (`programs/perpetuals/src/instructions/settle_dark_pool_trade.rs`)

**Settlement Process:**
1. Verify darkpool signature and trade authenticity
2. Validate price within acceptable slippage bounds  
3. Update positions for both traders involved
4. Transfer collateral between accounts
5. Update pool and custody statistics
6. Emit settlement events

**Trade Validation:**
- Signature verification from darkpool program
- Timestamp freshness checks (prevents replay attacks)
- Price slippage validation against oracle prices
- Position size and collateral validation

### Client SDK (`app/src/darkpool-client.ts`)

**Key Features:**
- Order encryption using Arcium SDK
- Transaction building for order submission
- Event monitoring for trade settlements
- Integration with existing perpetuals client

**Usage Example:**
```typescript
const darkpoolClient = await createDarkpoolClient(connection, provider, ...);

// Submit encrypted order
const order: DarkOrder = {
  owner: trader.publicKey,
  side: 0, // long
  sizeUsd: new BN(1000_000000), // $1000
  collateralAmount: new BN(100_000000), // $100 collateral
  maxPrice: new BN(50000_000000), // $50k max price
  leverage: new BN(10), // 10x leverage
  // ... other fields
};

const txid = await darkpoolClient.submitDarkOrder(trader, order, arciumPubKey);
```

## Privacy Guarantees

### What's Hidden
- **Order Details**: Size, price, and side remain encrypted until matching
- **Position Information**: Existing positions not revealed during order submission  
- **Trading Intentions**: No front-running or MEV extraction possible
- **Liquidation Levels**: Position health remains private

### What's Visible
- **Settlement Results**: Final matched trades are public for transparency
- **Aggregate Statistics**: Total volume and trade counts (no individual details)
- **Price Discovery**: Market prices still discoverable through settlements

### Threat Model Protection
- **Liquidation Attacks**: Attackers cannot see position sizes or health
- **Front-Running**: Orders encrypted until matching occurs
- **Sandwich Attacks**: No MEV opportunities on order flow
- **Market Manipulation**: Harder to target specific positions

## Security Considerations

### Cryptographic Security
- Orders encrypted using Arcium's secure MPC protocol
- Threshold signatures from multiple MPC nodes  
- Ed25519 signatures for settlement authentication
- Replay attack prevention via timestamps

### Economic Security  
- Collateral requirements enforced at settlement
- Price slippage limits prevent excessive execution deviation
- Fee mechanisms prevent spam orders
- Authority controls for emergency scenarios

### Operational Security
- Settlement bridge validates all trade data
- Oracle price checks prevent manipulation
- Multi-signature requirements for admin functions
- Comprehensive event logging for audit trails

## Getting Started

### Prerequisites
- Rust 1.70+
- Solana CLI 1.16+
- Anchor Framework 0.28+
- Node.js 18+
- Arcium SDK

### Setup Instructions

1. **Install Dependencies**
```bash
cd encrypted-perp
npm install
cargo build
```

2. **Deploy Arcium Infrastructure**
```bash
# Start local Arcium network
arx localnet start

# Deploy computation definitions
anchor build
anchor deploy
```

3. **Initialize Darkpool**
```bash
# Initialize darkpool account
ts-node scripts/initialize-darkpool.ts

# Set up computation definitions
ts-node scripts/setup-comp-defs.ts
```

4. **Submit Orders**
```bash
# Submit encrypted orders
ts-node examples/submit-order.ts

# Run matching engine
ts-node examples/match-orders.ts
```

### Testing

```bash
# Run encrypted instruction tests
cd encrypted-ixs
cargo test

# Run program tests  
cd programs/mgk_program
anchor test

# Run integration tests
cd app
npm test
```

## Integration with Existing Perpetuals

The darkpool is designed as an overlay on the existing perpetuals infrastructure:

### Compatible Features
- **All Asset Types**: Works with any token supported by perpetuals program
- **LP Pools**: Maintains compatibility with existing liquidity pools
- **Oracle Integration**: Uses same price feeds for settlement validation
- **Fee Structure**: Integrates with existing fee mechanisms

### Migration Path
- **Opt-in Privacy**: Traders can choose between public and private order flow
- **Gradual Adoption**: Darkpool can run alongside existing perpetuals program
- **Backward Compatibility**: No changes required to existing perpetuals functionality

## Monitoring and Analytics

### Available Events
- `DarkOrderSubmitted`: Order successfully encrypted and queued
- `DarkOrdersMatched`: Orders matched in MPC environment  
- `DarkPoolTradeSettled`: Trade settled with perpetuals program
- `DarkpoolInitialized`: Darkpool configuration updated

### Metrics Tracking
- Order submission rates and success ratios
- Matching efficiency and latency metrics
- Settlement success rates and failure analysis
- Privacy preservation effectiveness

## Future Enhancements

### Performance Optimizations
- Batch order processing for improved throughput
- Advanced matching algorithms (pro-rata, time-priority)
- Cross-asset matching and arbitrage detection
- MEV auction integration for any remaining extractable value

### Privacy Enhancements  
- Zero-knowledge proofs for additional privacy layers
- Private position health monitoring
- Confidential liquidation mechanisms
- Anonymous reputation systems

### Advanced Features
- Dark pool governance via encrypted voting
- Private derivatives and exotic products
- Cross-chain confidential bridge integration
- Institutional custody solutions

## Contributing

This darkpool implementation serves as a foundation for privacy-preserving DeFi. Contributions welcome for:

- Additional privacy features
- Performance optimizations  
- Security enhancements
- Documentation improvements

## License

This project is licensed under the Apache 2.0 License - see the LICENSE file for details.

## Acknowledgments

- **Arcium**: For providing the MPC infrastructure and encrypted computation framework
- **Solana Labs**: For the underlying perpetuals program architecture
- **Community**: For feedback and testing of privacy-preserving trading mechanisms

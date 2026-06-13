# Integration and Property Tests

This directory contains integration tests and property-based tests for Percolator.

## Status

**⚠️ These tests are currently disabled and serve as documentation/templates.**

The test code is commented out because:
1. Integration tests require [Surfpool](https://github.com/txtx/surfpool) to be installed and running
2. Property tests require uncommenting the proptest macros
3. Some helper functions and instruction builders need to be implemented

## Test Files

### Integration Tests (require Surfpool)

- **`integration_reserve_commit.rs`** - Tests for the two-phase reserve-commit flow
  - Reserve and commit execution
  - Reservation cancellation
  - Reservation expiry
  - Insufficient liquidity handling
  - VWAP calculation across price levels

- **`integration_portfolio.rs`** - Tests for cross-slab portfolio margin
  - Multi-slab position aggregation
  - Cross-margin calculation
  - Portfolio liquidation
  - User isolation

- **`integration_anti_toxicity.rs`** - Tests for anti-toxicity mechanisms
  - Pending order promotion (batch windows)
  - JIT penalty detection and application
  - Kill band enforcement
  - Aggressor roundtrip guard (ARG)
  - Freeze level triggers

### Property Tests

- **`property_invariants.rs`** - Property-based tests for protocol invariants
  - Safety: Capability constraints, escrow isolation
  - Matching: Reserved qty bounds, VWAP calculation, acyclic book links
  - Risk: Margin monotonicity, liquidation thresholds, cross-margin convexity
  - Anti-toxicity: Kill band thresholds, JIT detection

## Running Integration Tests

Once Surfpool is installed and the test code is uncommented:

```bash
# Terminal 1: Start Surfpool validator
cd surfpool
npm run validator

# Terminal 2: Run integration tests
cd percolator
cargo test --test integration_reserve_commit
cargo test --test integration_portfolio
cargo test --test integration_anti_toxicity
```

## Running Property Tests

Uncomment the test code in `property_invariants.rs` and run:

```bash
cargo test --test property_invariants

# Run with more test cases
cargo test --test property_invariants -- --test-threads=1

# Run specific property test
cargo test --test property_invariants prop_capability_amount_constraint
```

## Setup Instructions

### 1. Install Surfpool

```bash
git clone https://github.com/txtx/surfpool
cd surfpool
npm install
npm run validator
```

### 2. Uncomment Test Code

Remove the `/*` and `*/` comment markers from the test modules.

### 3. Implement Missing Helper Functions

Some tests reference helper functions that need to be implemented:
- `create_initialize_instruction()`
- `create_reserve_instruction()`
- `create_commit_instruction()`
- `create_cancel_instruction()`
- `create_order_instruction()`
- `create_batch_open_instruction()`
- etc.

These should be added to the program packages and exported.

### 4. Run Tests

```bash
cargo test --workspace --tests
```

## Test Coverage Goals

- [x] Unit tests for core functionality (53 tests passing)
- [ ] Integration tests with Surfpool (templates created)
- [ ] Property-based invariant tests (templates created)
- [ ] Fuzz testing for instruction parsing
- [ ] Stress tests for 10 MB state management
- [ ] CU consumption benchmarks

## Contributing

When adding new tests:
1. Follow the existing template structure
2. Document test scenarios clearly
3. Verify tests pass before committing
4. Update this README with new test descriptions

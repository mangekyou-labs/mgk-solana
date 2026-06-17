use crate::state::{
    cancel_resting_by_id, clob_match_with_caps, clob_match_with_risk, compute_clearing,
    default_risk_check, deserialize_book_state, modify_resting_qty, separate_priority_queues,
    serialize_book_state, shuffle_orders, FillReceipt, LimitOrder, OrderType, Side,
    MAX_FILLS_PER_BATCH, MAX_ORDERS,
};
use pinocchio::{
    account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

/// Compute uniform clearing price and fill allocations.
///
/// Accounts:
/// 0. `[writable]` Results account (to receive cleared results)
///
/// Instruction data (M6 6g wire format):
/// - num_orders: u16 (2 bytes)
/// - For each order (53 bytes):
///   - side: u8 (0 = Buy, 1 = Sell)
///   - price: i64 (8 bytes LE)
///   - qty: u64 (8 bytes LE)
///   - user: Pubkey (32 bytes)
///   - order_type: u8 (design L319-327)
///   - instrument_id: u16 (2 bytes LE)
///   - reduce_only: u8 (0 or 1)
pub fn process_compute_clearing(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        msg!("Error: ComputeClearing requires at least 1 account");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let results_account = &accounts[0];

    if !results_account.is_writable() {
        msg!("Error: Results account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse instruction data
    if data.len() < 2 {
        msg!("Error: Instruction data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    let num_orders = u16::from_le_bytes([data[0], data[1]]) as usize;
    if num_orders == 0 {
        msg!("Error: No orders provided");
        return Err(ProgramError::InvalidInstructionData);
    }
    if num_orders > MAX_ORDERS {
        msg!("Error: Too many orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // M6 6g: 53 bytes per order (was 49)
    let expected_data_len = 2 + num_orders * 53;
    if data.len() < expected_data_len {
        msg!("Error: Instruction data too short for specified num_orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Deserialize orders onto stack
    let mut orders = [LimitOrder {
        user: Pubkey::default(),
        instrument_id: 0,
        order_type: OrderType::LimitGTC,
        side: Side::Buy,
        price: 0,
        qty: 0,
        reduce_only: false,
        cancel_order_id: 0,
    }; MAX_ORDERS];

    for (i, order) in orders.iter_mut().take(num_orders).enumerate() {
        let offset = 2 + i * 53;
        let side_byte = data[offset];
        let side = match Side::from_u8(side_byte) {
            Some(s) => s,
            None => {
                msg!("Error: Invalid side");
                return Err(ProgramError::InvalidInstructionData);
            }
        };
        let price = i64::from_le_bytes([
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
            data[offset + 8],
        ]);
        let qty = u64::from_le_bytes([
            data[offset + 9],
            data[offset + 10],
            data[offset + 11],
            data[offset + 12],
            data[offset + 13],
            data[offset + 14],
            data[offset + 15],
            data[offset + 16],
        ]);
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[offset + 17..offset + 49])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let order_type = OrderType::from_u8(data[offset + 49]).unwrap_or(OrderType::LimitGTC);
        let instrument_id = u16::from_le_bytes([data[offset + 50], data[offset + 51]]);
        let reduce_only = data[offset + 52] != 0;
        *order = LimitOrder {
            user,
            instrument_id,
            order_type,
            side,
            price,
            qty,
            reduce_only,
            cancel_order_id: 0,
        };
    }

    // Compute clearing
    let result = compute_clearing(&orders[..num_orders], MAX_ORDERS);
    let (clearing_price, num_fills, fills) = match result {
        Some(r) => r,
        None => {
            msg!("No match — no clearing price found");
            // Write empty result: clearing_price=0, num_fills=0
            write_empty_result(results_account)?;
            return Ok(());
        }
    };

    // Write results to the results account
    write_results(results_account, clearing_price, num_fills, &fills)?;

    msg!("Clearing computed successfully");
    Ok(())
}

fn write_empty_result(account: &AccountInfo) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    if data.len() < 10 {
        msg!("Error: Results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }
    // clearing_price = 0
    data[0..8].copy_from_slice(&0i64.to_le_bytes());
    // num_fills = 0
    data[8..10].copy_from_slice(&0u16.to_le_bytes());
    Ok(())
}

fn write_results(
    account: &AccountInfo,
    clearing_price: i64,
    num_fills: usize,
    fills: &[FillReceipt; MAX_ORDERS],
) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    let needed = 10 + num_fills * 48;
    if data.len() < needed {
        msg!("Error: Results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // clearing_price: i64 (8 bytes)
    data[0..8].copy_from_slice(&clearing_price.to_le_bytes());
    // num_fills: u16 (2 bytes)
    data[8..10].copy_from_slice(&(num_fills as u16).to_le_bytes());

    for (i, fill) in fills.iter().take(num_fills).enumerate() {
        let offset = 10 + i * 48;
        // user: Pubkey (32 bytes)
        data[offset..offset + 32].copy_from_slice(fill.user.as_ref());
        // filled_qty: u64 (8 bytes)
        data[offset + 32..offset + 40].copy_from_slice(&fill.filled_qty.to_le_bytes());
        // notional: u64 (8 bytes)
        data[offset + 40..offset + 48].copy_from_slice(&fill.notional.to_le_bytes());
    }

    Ok(())
}

// =============================================================================
// 6h. Direct cancel / modify (CPI from Core)
// =============================================================================
//
// Both instructions take the instrument's book account (writable, owned by
// this matcher program) plus a `user` pubkey and an `order_id`. They
// deserialize the `BookState`, mutate it, and serialize back.

const CANCEL_DATA_LEN: usize = 32 + 8; // user(32) + order_id(8)
const MODIFY_DATA_LEN: usize = 32 + 8 + 8; // user(32) + order_id(8) + new_qty(8)

/// Cancel a single resting order by `order_id`.
///
/// Accounts:
/// 0. `[writable]` Book account (PDA: `["book", instrument_id_le]`)
/// 1. [] Matcher program (for ownership check, optional)
///
/// Data: user(32) + order_id(8) = 40 bytes
pub fn process_cancel_resting(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        msg!("Error: CancelResting requires at least 1 account (book)");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < CANCEL_DATA_LEN {
        msg!("Error: CancelResting data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    let user = Pubkey::from(
        <[u8; 32]>::try_from(&data[0..32]).map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    let mut state = deserialize_book_state(&book_account.try_borrow_data()?)?;
    cancel_resting_by_id(&mut state, order_id, &user)?;
    serialize_book_state(&state, &mut book_account.try_borrow_mut_data()?)?;

    msg!("CancelResting: removed order");
    Ok(())
}

/// Modify a single resting order's qty by `order_id`.
///
/// Accounts:
/// 0. `[writable]` Book account
///
/// Data: user(32) + order_id(8) + new_qty(8) = 48 bytes
pub fn process_modify_resting(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        msg!("Error: ModifyResting requires at least 1 account (book)");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < MODIFY_DATA_LEN {
        msg!("Error: ModifyResting data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    let user = Pubkey::from(
        <[u8; 32]>::try_from(&data[0..32]).map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let new_qty = u64::from_le_bytes(
        data[40..48]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    let mut state = deserialize_book_state(&book_account.try_borrow_data()?)?;
    modify_resting_qty(&mut state, order_id, &user, new_qty)?;
    serialize_book_state(&state, &mut book_account.try_borrow_mut_data()?)?;

    msg!("ModifyResting: order updated");
    Ok(())
}

// =============================================================================
// 6i.2. ClearAndMatch — CLOB matching against a persistent book
// =============================================================================
//
// Wires up the full 6a-6e pipeline (shuffle → partition → CLOB match) against
// the on-chain `BookState`. Replaces the old uniform-clearing path for the
// perps-core `ClearBatch` flow. The book is mutated in place and serialized
// back, so resting GTC orders persist across batches (6f).

/// Bytes per fill in the CLOB results account.
/// user(32) + filled_qty(8) + notional(8) + is_maker(1) = 49.
pub const BYTES_PER_FILL: usize = 49;
/// Maximum size the results account must be allocated to for ClearAndMatch.
pub const MAX_RESULTS_SIZE: usize = 2 + MAX_FILLS_PER_BATCH * BYTES_PER_FILL;

/// Per-order wire size for ClearAndMatch (same as ComputeClearing in 6g).
const CLEAR_ORDER_BYTES: usize = 53;
/// Bytes per user cap in the M7 7.6 cap section: user(32) + max_notional(16) = 48.
const CLEAR_CAP_BYTES: usize = 48;

/// `ClearAndMatch` (M6 6i.2): full CLOB pipeline against a persistent book.
///
/// Accounts:
/// 0. `[writable]` Book account (matcher-owned, `["book", instrument_id_le]`)
/// 1. `[writable]` Results account (core-owned, receives fills)
///
/// Data (M7 7.6 added the `num_caps` + caps section for risk-callback wiring):
/// - close_slot: u64 (8) — used as the Fisher-Yates shuffle seed
/// - num_orders: u16 (2)
/// - num_caps: u16 (2) — number of per-user notional caps (M7 7.6, D2);
///   zero = no cap (default risk check)
/// - caps[num_caps]: each 48 bytes — `user(32) + max_notional(16)` little-endian
/// - orders[num_orders]: each 53 bytes — side(1) + price(8) + qty(8) +
///   user(32) + order_type(1) + instrument_id(2) + reduce_only(1)
///
/// Results account layout:
/// - num_fills: u16 (2)
/// - For each fill (49 bytes): user(32) + filled_qty(8) + notional(8) + is_maker(1)
pub fn process_clear_and_match(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: ClearAndMatch requires book + results accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    let results_account = &accounts[1];

    if !book_account.is_writable() || !results_account.is_writable() {
        msg!("Error: ClearAndMatch accounts must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }

    // Header: close_slot(8) + num_orders(2) + num_caps(2)
    if data.len() < 12 {
        msg!("Error: ClearAndMatch data too short for header");
        return Err(ProgramError::InvalidInstructionData);
    }
    let close_slot = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let num_orders = u16::from_le_bytes(
        data[8..10]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;
    let num_caps = u16::from_le_bytes(
        data[10..12]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;

    if num_orders == 0 || num_orders > MAX_ORDERS {
        msg!("Error: ClearAndMatch num_orders out of range");
        return Err(ProgramError::InvalidInstructionData);
    }

    let caps_offset = 12usize;
    let orders_offset = caps_offset + num_caps * CLEAR_CAP_BYTES;
    let expected_len = orders_offset + num_orders * CLEAR_ORDER_BYTES;
    if data.len() < expected_len {
        msg!("Error: ClearAndMatch data too short for caps + orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Parse caps into a stack-allocated array. Caps are bounded by
    // num_caps, which itself is bounded by MAX_ORDERS (= 64). The cap
    // array is only used during this call (it's passed by reference into
    // clob_match_with_caps), so the stack allocation is fine.
    let mut caps: [(Pubkey, u128); MAX_ORDERS] = [(Pubkey::default(), 0u128); MAX_ORDERS];
    if num_caps > MAX_ORDERS {
        msg!("Error: ClearAndMatch num_caps exceeds MAX_ORDERS");
        return Err(ProgramError::InvalidInstructionData);
    }
    for (i, cap_slot) in caps.iter_mut().enumerate().take(num_caps) {
        let off = caps_offset + i * CLEAR_CAP_BYTES;
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[off..off + 32])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let cap = u128::from_le_bytes(
            data[off + 32..off + 48]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        *cap_slot = (user, cap);
    }
    let caps_slice = &caps[..num_caps];

    // Deserialize orders onto the stack.
    let mut orders = [LimitOrder {
        user: Pubkey::default(),
        instrument_id: 0,
        order_type: OrderType::LimitGTC,
        side: Side::Buy,
        price: 0,
        qty: 0,
        reduce_only: false,
        cancel_order_id: 0,
    }; MAX_ORDERS];

    for (i, slot) in orders.iter_mut().take(num_orders).enumerate() {
        let offset = orders_offset + i * CLEAR_ORDER_BYTES;
        let side = match Side::from_u8(data[offset]) {
            Some(s) => s,
            None => {
                msg!("Error: Invalid side in ClearAndMatch");
                return Err(ProgramError::InvalidInstructionData);
            }
        };
        let price = i64::from_le_bytes(
            data[offset + 1..offset + 9]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let qty = u64::from_le_bytes(
            data[offset + 9..offset + 17]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[offset + 17..offset + 49])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let order_type = OrderType::from_u8(data[offset + 49]).unwrap_or(OrderType::LimitGTC);
        let instrument_id = u16::from_le_bytes([data[offset + 50], data[offset + 51]]);
        let reduce_only = data[offset + 52] != 0;
        *slot = LimitOrder {
            user,
            instrument_id,
            order_type,
            side,
            price,
            qty,
            reduce_only,
            cancel_order_id: 0,
        };
    }

    // 1. Fisher-Yates shuffle seeded by close_slot (6b).
    shuffle_orders(&mut orders[..num_orders], close_slot);

    // 2. Partition into cancels / ALOs / regulars (6c).
    let mut queues = crate::state::PartitionedOrders::new();
    separate_priority_queues(&orders[..num_orders], &mut queues);

    // 3. Deserialize the persistent book, run CLOB match (6d), serialize back.
    // M7 7.6: if caps were provided, use the cap-aware risk check (D2);
    // otherwise fall back to the default always-passing check.
    let mut state = deserialize_book_state(&book_account.try_borrow_data()?)?;
    let result = if num_caps > 0 {
        clob_match_with_caps(&mut state, &queues, caps_slice)
    } else {
        clob_match_with_risk(&mut state, &queues, default_risk_check)
    };
    serialize_book_state(&state, &mut book_account.try_borrow_mut_data()?)?;

    // 4. Write fills to the results account.
    write_clob_results(results_account, &result)?;

    msg!("ClearAndMatch: complete");
    Ok(())
}

/// Write `MatchResult` fills into the results account in CLOB wire format.
fn write_clob_results(account: &AccountInfo, result: &crate::state::MatchResult) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    let needed = 2 + result.fill_count * BYTES_PER_FILL;
    if data.len() < needed {
        msg!("Error: Results account too small for CLOB fills");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // num_fills: u16 (2)
    data[0..2].copy_from_slice(&(result.fill_count as u16).to_le_bytes());

    for (i, fill) in result.fills.iter().take(result.fill_count).enumerate() {
        let offset = 2 + i * BYTES_PER_FILL;
        data[offset..offset + 32].copy_from_slice(fill.user.as_ref());
        data[offset + 32..offset + 40].copy_from_slice(&fill.filled_qty.to_le_bytes());
        data[offset + 40..offset + 48].copy_from_slice(&fill.notional.to_le_bytes());
        data[offset + 48] = fill.is_maker as u8;
    }

    Ok(())
}

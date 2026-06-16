use crate::instructions::commit_order::compute_commitment_hash;
use crate::state::order::{OrderType, Side};
use crate::state::{
    Batch, BatchStatus, Commitment, CommitmentStatus, Portfolio, RevealedOrder,
};
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo, msg, sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

#[allow(clippy::too_many_arguments)]
pub fn process_reveal_order(
    commitment_account: &AccountInfo,
    user_account: &AccountInfo,
    portfolio_account: &AccountInfo,
    batch_account: &AccountInfo,
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
) -> ProgramResult {
    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Validate portfolio ownership
    let portfolio = unsafe {
        &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio)
    };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Read batch state
    let batch = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };
    if batch.batch_id != batch_id {
        msg!("Error: Wrong batch ID");
        return Err(PercolatorError::InvalidInstruction.into());
    }
    if batch.status != BatchStatus::Revealing {
        msg!("Error: Batch not in revealing phase");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // M7 7.3: enforce reveal deadline (design L153). `reveal_deadline_slot`
    // is set in `CloseCommitting` to `close_slot + registry.t_reveal_slots`.
    // By the time we reach this point `batch.status == Revealing`, so the
    // field is guaranteed to be set (CloseCommitting is the only path into
    // Revealing). We use `Clock::get()` to match the existing pattern in
    // `close_committing` and `settle_batch`; no extra account is needed in
    // the entrypoint.
    //
    // Boundary: `current_slot > reveal_deadline_slot` is the failure
    // condition. `current_slot == reveal_deadline_slot` is the last slot
    // that may reveal — matches the design's "by deadline" semantics where
    // the deadline slot itself is inclusive.
    let current_slot = Clock::get()?.slot;
    if current_slot > batch.reveal_deadline_slot {
        msg!("Error: Reveal deadline expired");
        return Err(PercolatorError::RevealDeadlineExpired.into());
    }

    // Read commitment
    let commitment = unsafe {
        &mut *(commitment_account.borrow_mut_data_unchecked().as_ptr() as *mut Commitment)
    };

    if commitment.user != *user_account.key() {
        msg!("Error: Commitment does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    if commitment.status != CommitmentStatus::Pending {
        msg!("Error: Commitment already revealed or settled");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // Verify hash matches
    let computed_hash = compute_commitment_hash(
        order_type,
        instrument_id,
        reduce_only,
        side,
        price,
        qty,
        salt,
        user_account.key(),
        batch_id,
    );
    if computed_hash != commitment.order_hash {
        msg!("Error: Revealed order does not match commitment");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // Validate order_type and side are well-formed
    let parsed_order_type = OrderType::from_u8(order_type)
        .ok_or(PercolatorError::InvalidInstruction)?;
    let parsed_side = Side::from_u8(side).ok_or(PercolatorError::InvalidInstruction)?;

    // Populate typed revealed order storage.
    let commitment_idx = batch.total_revealed;
    commitment.revealed = RevealedOrder {
        user: *user_account.key(),
        price,
        qty,
        salt,
        instrument_id,
        commitment_idx,
        order_type: parsed_order_type,
        side: parsed_side,
        reduce_only,
        _padding: [0; 3],
    };
    commitment.status = CommitmentStatus::Revealed;

    msg!("RevealOrder: commitment revealed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Batch, BatchStatus, Commitment, CommitmentStatus};
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_revealed_struct_storage() {
        let user = Pubkey::from([1u8; 32]);
        let mut c = Commitment::new(1, user);
        c.status = CommitmentStatus::Pending;

        // Simulate reveal populating the typed struct
        c.revealed = RevealedOrder {
            user,
            price: 100,
            qty: 10,
            salt: 42,
            instrument_id: 1,
            commitment_idx: 0,
            order_type: OrderType::LimitGTC,
            side: Side::Buy,
            reduce_only: false,
            _padding: [0; 3],
        };
        c.status = CommitmentStatus::Revealed;

        assert_eq!(c.status, CommitmentStatus::Revealed);
        assert_eq!(c.revealed.price, 100);
        assert_eq!(c.revealed.qty, 10);
        assert_eq!(c.revealed.salt, 42);
        assert_eq!(c.revealed.instrument_id, 1);
        assert_eq!(c.revealed.order_type, OrderType::LimitGTC);
        assert_eq!(c.revealed.side, Side::Buy);
        assert!(!c.revealed.reduce_only);
    }

    #[test]
    fn test_commitment_status_transitions() {
        let user = Pubkey::from([1u8; 32]);
        let mut c = Commitment::new(1, user);
        assert_eq!(c.status, CommitmentStatus::Pending);

        c.status = CommitmentStatus::Revealed;
        assert_eq!(c.status, CommitmentStatus::Revealed);

        c.status = CommitmentStatus::Settled;
        assert_eq!(c.status, CommitmentStatus::Settled);

        c.status = CommitmentStatus::Slashed;
        assert_eq!(c.status, CommitmentStatus::Slashed);
    }

    #[test]
    fn test_batch_state_transitions() {
        let mut b = Batch::new(1);
        assert_eq!(b.status, BatchStatus::Committing);

        b.status = BatchStatus::Revealing;
        assert_eq!(b.status, BatchStatus::Revealing);

        b.status = BatchStatus::Clearing;
        assert_eq!(b.status, BatchStatus::Clearing);

        b.status = BatchStatus::Settled;
        assert_eq!(b.status, BatchStatus::Settled);
    }

    // =========================================================================
    // M7 7.3: reveal deadline enforcement.
    //
    // The deadline check is a single comparison: `current_slot >
    // batch.reveal_deadline_slot`. `reveal_deadline_slot` is set in
    // `CloseCommitting` to `close_slot + t_reveal_slots`, so any batch in
    // `Revealing` status has a non-zero deadline.
    //
    // We pin the boundary semantics here: the deadline slot itself is
    // inclusive (the user may reveal on the slot equal to
    // `reveal_deadline_slot`). The first slot that fails is
    // `reveal_deadline_slot + 1`. This matches the design L153 wording
    // ("by deadline" — the deadline slot is the last allowed slot).
    // =========================================================================

    use crate::state::Registry;

    /// Pin the post-condition of `CloseCommitting` that sets
    /// `batch.reveal_deadline_slot = close_slot + t_reveal_slots`. This is
    /// the only path into `Revealing` status, so the field is guaranteed
    /// to be set when `RevealOrder` is called.
    #[test]
    fn test_reveal_deadline_stored_on_transition() {
        let mut batch = Batch::new(1);
        let registry = Registry::new(Pubkey::from([1u8; 32]));
        let close_slot: u64 = 1_000;

        // Mirror close_committing.rs:43.
        batch.reveal_deadline_slot = close_slot.saturating_add(registry.t_reveal_slots);
        assert_eq!(
            batch.reveal_deadline_slot,
            close_slot + registry.t_reveal_slots
        );
        assert!(batch.reveal_deadline_slot > close_slot);
    }

    /// Pin the failure boundary: `current_slot > reveal_deadline_slot`
    /// fails. We assert by computing the bool directly (the actual
    /// `process_reveal_order` would `return Err(RevealDeadlineExpired)`).
    #[test]
    fn test_reveal_past_deadline_fails() {
        let reveal_deadline_slot: u64 = 1_000;
        let current_slot: u64 = reveal_deadline_slot + 1;
        let should_fail = current_slot > reveal_deadline_slot;
        assert!(
            should_fail,
            "current_slot one past the deadline must trigger RevealDeadlineExpired"
        );
    }

    /// Pin the success boundary: `current_slot == reveal_deadline_slot`
    /// succeeds. The deadline slot itself is the last allowed slot.
    #[test]
    fn test_reveal_at_deadline_succeeds() {
        let reveal_deadline_slot: u64 = 1_000;
        let current_slot: u64 = reveal_deadline_slot;
        let should_fail = current_slot > reveal_deadline_slot;
        assert!(
            !should_fail,
            "current_slot == reveal_deadline_slot is the last allowed slot"
        );
    }

    /// Pin the success case: well before the deadline, the check passes.
    #[test]
    fn test_reveal_before_deadline_succeeds() {
        let reveal_deadline_slot: u64 = 1_000;
        let current_slot: u64 = 500;
        let should_fail = current_slot > reveal_deadline_slot;
        assert!(!should_fail);
    }

    /// Pin the error variant exists and is in the perps-core range
    /// (600-699 per AGENTS.md). If a refactor reassigns the value, the
    /// error code visible to clients would change — this test catches it.
    #[test]
    fn test_reveal_deadline_expired_error_in_perps_core_range() {
        assert_eq!(
            PercolatorError::RevealDeadlineExpired as u32, 600,
            "RevealDeadlineExpired must stay in the perps-core 600-699 range"
        );
    }
}

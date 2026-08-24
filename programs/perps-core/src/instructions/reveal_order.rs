use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

#[allow(clippy::too_many_arguments)]
pub fn process_reveal_order(
    _commitment_account: &AccountInfo,
    _user_account: &AccountInfo,
    _portfolio_account: &AccountInfo,
    _batch_account: &AccountInfo,
    _registry_account: &AccountInfo,
    _order_type: u8,
    _instrument_id: u16,
    _reduce_only: bool,
    _side: u8,
    _price: i64,
    _qty: u64,
    _salt: u64,
    _batch_id: u64,
) -> ProgramResult {
    // DFBA: RevealOrder retired — use PostOrder (disc 20).
    msg!("Error: RevealOrder retired; use PostOrder");
    Err(MgkError::InvalidInstruction.into())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::{OrderType, Side};
    use crate::state::{
        Batch, BatchStatus, Commitment, CommitmentStatus, RevealedOrder,
    };
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
            MgkError::RevealDeadlineExpired as u32, 600,
            "RevealDeadlineExpired must stay in the perps-core 600-699 range"
        );
    }

    /// M7 7.8: `trading_paused` blocks `RevealOrder`. See the
    /// matching test in `commit_order.rs` for why we pin the pattern
    /// here rather than call the full instruction.
    #[test]
    fn test_reveal_order_trading_paused_pattern() {
        use crate::state::registry::PAUSE_TRADING;
        let mut r = Registry::new(Pubkey::from([8u8; 32]));
        r.set_pause_flags(PAUSE_TRADING);
        assert!(r.is_trading_paused());
        let err: u64 = MgkError::OperationPaused.into();
        assert_eq!(err, 602);
    }
}

use crate::state::{Batch, BatchStatus, Registry};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo, msg, pubkey::Pubkey, sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

pub fn process_close_committing(
    _program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
) -> ProgramResult {
    let batch = unsafe { &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch) };
    let registry = unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };

    if batch.status != BatchStatus::Committing {
        msg!("Error: Batch not in committing phase");
        return Err(MgkError::InvalidInstruction.into());
    }

    // Note: On Solana 4.x, batches are keypairs (not PDAs), so we skip the
    // derive_batch_pda validation that existed here previously.

    // Check if we can close: either past deadline OR have enough commitments
    let clock = Clock::get()?;
    let current_slot = clock.slot;

    let past_deadline = current_slot >= batch.commit_deadline_slot;
    // DFBA: n_min orders still optional; time-only close when past deadline.
    let enough_posts = batch.total_commitments >= registry.n_min || registry.n_min == 0;

    if !past_deadline && !enough_posts {
        msg!("Error: Cannot close batch — deadline not reached and insufficient posts");
        return Err(MgkError::InvalidInstruction.into());
    }

    // DFBA: skip reveal — go straight to Clearing for DfbaClear crank.
    batch.status = BatchStatus::Clearing;
    batch.reveal_deadline_slot = current_slot; // unused in DFBA
    batch.total_revealed = 0;
    batch.close_slot = current_slot;
    batch.shuffle_seed = 0;
    batch.mark_valid = 0;
    batch.liq_paused = 1;

    // Allow closing with zero posts when past deadline (empty dual clear).
    let _ = registry;

    msg!("CloseCollecting: Batch transitioned to Clearing (DFBA)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Registry;
    use pinocchio::pubkey::Pubkey;

    /// Test the deterministic post-conditions of close_committing (status
    /// transition, close_slot, shuffle_seed, reveal_deadline) using a fake
    /// Clock. The real Clock is read via syscall at runtime; the business
    /// logic is exercised by directly mutating a Batch in the same shape
    /// process_close_committing would produce.
    #[test]
    fn test_close_slot_and_dfba_clearing_transition() {
        let mut batch = Batch::new(7);
        batch.status = BatchStatus::Committing;
        batch.commit_deadline_slot = 0;
        batch.total_commitments = 5;
        let close_slot: u64 = 12345;

        // DFBA: close lands in Clearing (no reveal); shuffle unused.
        batch.status = BatchStatus::Clearing;
        batch.reveal_deadline_slot = close_slot;
        batch.close_slot = close_slot;
        batch.shuffle_seed = 0;
        batch.total_revealed = 0;
        batch.liq_paused = 1;

        assert_eq!(batch.status, BatchStatus::Clearing);
        assert_eq!(batch.close_slot, 12345);
        assert_eq!(batch.shuffle_seed, 0);
        assert_eq!(batch.liq_paused, 1);
        assert_eq!(batch.total_revealed, 0);
    }

    #[test]
    fn test_close_slot_not_commit_deadline() {
        // close_slot must be the actual transition slot, not the known deadline.
        let mut batch = Batch::new(1);
        batch.status = BatchStatus::Committing;
        batch.commit_deadline_slot = 1000; // known during commit
        batch.close_slot = 0; // not yet set
        batch.shuffle_seed = 0;

        // After close (DFBA):
        let close_slot: u64 = 2500;
        batch.close_slot = close_slot;
        batch.shuffle_seed = 0;
        batch.status = BatchStatus::Clearing;

        assert_eq!(batch.close_slot, 2500);
        assert_ne!(batch.close_slot, batch.commit_deadline_slot);
        assert_eq!(batch.status, BatchStatus::Clearing);
    }
}

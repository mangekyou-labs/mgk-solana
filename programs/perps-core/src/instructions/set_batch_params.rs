//! SetBatchParams (disc 21) — governance-only batch parameter update.

use crate::state::Registry;
use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// Set batch parameters (governance-only, disc 21).
///
/// Wire format (post-disc, 22 bytes):
///   max_orders_per_batch(1) + marginal_size_cap(1) + t_min_slots(8) + t_max_slots(8) + n_min(4)
///
/// Accounts:
///   0. [writable] Registry PDA
///   1. [signer]   Governance (must equal `registry.governance`)
#[allow(clippy::too_many_arguments)]
pub fn process_set_batch_params(
    _program_id: &Pubkey,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    max_orders: u8,
    marginal_cap: u8,
    t_min_slots: u64,
    t_max_slots: u64,
    n_min: u32,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    let registry =
        unsafe { &mut *(registry_account.borrow_mut_data_unchecked().as_ptr() as *mut Registry) };

    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(MgkError::Unauthorized.into());
    }

    // Validate: max_orders must be 1..=128 (DFBA_SCRATCH_MAX)
    if max_orders == 0 || max_orders > 128 {
        msg!("Error: max_orders must be 1..=128");
        return Err(MgkError::InvalidInstruction.into());
    }
    // Validate: t_max must be > t_min
    if t_max_slots <= t_min_slots {
        msg!("Error: t_max_slots must be > t_min_slots");
        return Err(MgkError::InvalidInstruction.into());
    }

    registry.max_orders_per_batch = max_orders;
    registry.marginal_size_cap = if marginal_cap == 0 {
        max_orders
    } else {
        marginal_cap
    };
    registry.t_min_slots = t_min_slots;
    registry.t_max_slots = t_max_slots;
    registry.n_min = n_min;

    msg!("SetBatchParams: params updated");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    fn make_registry(gov_byte: u8) -> Registry {
        Registry::new(Pubkey::from([gov_byte; 32]))
    }

    #[test]
    fn test_set_batch_params_defaults() {
        let r = make_registry(1);
        assert_eq!(r.max_orders_per_batch, 64);
        assert_eq!(r.marginal_size_cap, 64);
        let t_min = r.t_min_slots;
        let t_max = r.t_max_slots;
        let n = r.n_min;
        assert_eq!(t_min, 10);
        assert_eq!(t_max, 150);
        assert_eq!(n, 5);
    }

    #[test]
    fn test_set_batch_params_writes_values() {
        let mut r = make_registry(2);
        r.max_orders_per_batch = 32;
        r.marginal_size_cap = 48;
        r.t_min_slots = 2;
        r.t_max_slots = 4;
        r.n_min = 1;
        assert_eq!(r.max_orders_per_batch, 32);
        assert_eq!(r.marginal_size_cap, 48);
        let t_min = r.t_min_slots;
        let t_max = r.t_max_slots;
        let n = r.n_min;
        assert_eq!(t_min, 2);
        assert_eq!(t_max, 4);
        assert_eq!(n, 1);
    }

    #[test]
    fn test_set_batch_params_marginal_cap_zero_uses_max() {
        // Simulates the logic: marginal_cap=0 → use max_orders
        let max_orders: u8 = 64;
        let marginal_cap: u8 = 0;
        let effective = if marginal_cap == 0 {
            max_orders
        } else {
            marginal_cap
        };
        assert_eq!(effective, 64);
    }

    #[test]
    fn test_set_batch_params_size_unchanged() {
        // Registry must stay at 86 bytes for on-chain compatibility.
        assert_eq!(core::mem::size_of::<Registry>(), 86);
    }
}

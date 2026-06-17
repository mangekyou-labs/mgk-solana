use crate::state::Registry;
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    ProgramResult,
};

/// M7 7.8: governance-only instruction to set or clear pause flags.
///
/// Wire format: disc(1) + flags(1) = 2 bytes.
/// Accounts:
///   0. `[writable]` Registry PDA
///   1. `[signer]`   Governance (must equal `registry.governance`)
///
/// Bit layout (see `state::registry` for constants):
///   bit 0 — trading_paused      (blocks CommitOrder / RevealOrder)
///   bit 1 — withdrawals_paused  (blocks Withdraw)
///   bit 2 — liquidations_paused (blocks LiquidateUser)
///   bit 3 — funding_paused      (skips funding in SettleBatch)
///   bits 4..7 — reserved, masked off on write
pub fn process_set_pause_flags(
    registry: &mut Registry,
    governance_account: &AccountInfo,
    flags: u8,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(PercolatorError::Unauthorized.into());
    }

    registry.set_pause_flags(flags);

    msg!("SetPauseFlags: flags written");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::registry::{
        PAUSE_FUNDING, PAUSE_LIQUIDATIONS, PAUSE_TRADING, PAUSE_WITHDRAWALS,
    };
    use pinocchio::pubkey::Pubkey;

    /// Build a Registry with a known governance pubkey. Returns the
    /// registry value; tests construct their own AccountInfo shims.
    fn make_registry(gov_byte: u8) -> Registry {
        Registry::new(Pubkey::from([gov_byte; 32]))
    }

    #[test]
    fn test_set_pause_flags_zero_clears_all() {
        let mut r = make_registry(1);
        r.pause_flags = 0x0F;
        r.set_pause_flags(0);
        assert_eq!(r.pause_flags, 0);
    }

    #[test]
    fn test_set_pause_flags_writes_each_bit() {
        let mut r = make_registry(2);
        for bit in [PAUSE_TRADING, PAUSE_WITHDRAWALS, PAUSE_LIQUIDATIONS, PAUSE_FUNDING] {
            r.set_pause_flags(bit);
            assert_eq!(r.pause_flags, bit);
        }
    }

    #[test]
    fn test_set_pause_flags_masks_reserved_bits() {
        let mut r = make_registry(3);
        r.set_pause_flags(0b_1111_1111);
        assert_eq!(r.pause_flags, 0b_0000_1111);
    }

    #[test]
    fn test_set_pause_flags_does_not_alter_other_fields() {
        let mut r = make_registry(4);
        let snap_instrument_count = r.instrument_count;
        let snap_batch_id_counter = r.batch_id_counter;
        let snap_base_deposit = r.base_deposit;
        r.set_pause_flags(PAUSE_TRADING | PAUSE_LIQUIDATIONS);
        assert_eq!(r.instrument_count, snap_instrument_count);
        assert_eq!(r.batch_id_counter, snap_batch_id_counter);
        assert_eq!(r.base_deposit, snap_base_deposit);
        assert!(r.is_trading_paused());
        assert!(r.is_liquidations_paused());
    }
}

//! SetInstrumentOracle (disc 23) — governance-only instrument oracle binding.

use crate::state::{Instrument, Registry};
use mgk_common::{
    program_ids::mgk_oracle_program_id,
    validate_owner, validate_writable, MgkError,
};
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// Set instrument oracle address (governance-only, disc 23).
///
/// Wire format: discriminator only (no data payload).
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance (must equal `registry.governance`)
///   3. []         PriceOracle data account (owned by mgk_oracle program)
pub fn process_set_instrument_oracle(
    program_id: &Pubkey,
    instrument_account: &AccountInfo,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    oracle_account: &AccountInfo,
) -> ProgramResult {
    // 1. Validate governance signature
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    // 2. Validate core accounts ownership and writable state
    validate_owner(instrument_account, program_id)?;
    validate_writable(instrument_account)?;
    validate_owner(registry_account, program_id)?;

    let registry =
        unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };

    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(MgkError::Unauthorized.into());
    }

    if instrument_account.data_len() < core::mem::size_of::<Instrument>() {
        msg!("Error: Instrument account too small");
        return Err(MgkError::InvalidAccount.into());
    }

    // 3. Validate oracle account
    validate_owner(oracle_account, &mgk_oracle_program_id())?;

    const PRICE_ORACLE_SIZE: usize = 128;
    if oracle_account.data_len() < PRICE_ORACLE_SIZE {
        msg!("Error: PriceOracle account too small");
        return Err(MgkError::InvalidAccount.into());
    }

    let oracle_data = oracle_account
        .try_borrow_data()
        .map_err(|_| ProgramError::from(MgkError::InvalidAccount))?;
    if oracle_data.len() < PRICE_ORACLE_SIZE {
        msg!("Error: PriceOracle account data too small");
        return Err(MgkError::InvalidAccount.into());
    }

    // Magic bytes LE for b"PRCLORCL" = 0x4c43524f4c435250
    const ORACLE_MAGIC: u64 = 0x4C43_524F_4C43_5250;
    let magic = u64::from_le_bytes(oracle_data[0..8].try_into().unwrap());
    if magic != ORACLE_MAGIC {
        msg!("Error: Invalid oracle magic");
        return Err(MgkError::InvalidAccount.into());
    }

    let version = oracle_data[8];
    if version != 0 {
        msg!("Error: Invalid oracle version");
        return Err(MgkError::InvalidAccount.into());
    }

    let is_active = oracle_data[10] != 0;
    if !is_active {
        msg!("Error: Oracle is not active");
        return Err(MgkError::InvalidAccount.into());
    }

    let oracle_instrument = Pubkey::from(<[u8; 32]>::try_from(&oracle_data[48..80]).unwrap());
    if oracle_instrument != *instrument_account.key() {
        msg!("Error: Oracle instrument mismatch");
        return Err(MgkError::InvalidInstrument.into());
    }

    // 4. Update instrument.oracle_addr
    let instrument = unsafe {
        &mut *(instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut Instrument)
    };
    apply_set_instrument_oracle(instrument, *oracle_account.key());

    msg!("SetInstrumentOracle: oracle_addr updated");
    Ok(())
}

/// Apply oracle address update in place.
pub fn apply_set_instrument_oracle(instrument: &mut Instrument, oracle_addr: Pubkey) {
    instrument.oracle_addr = oracle_addr;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_instrument_oracle_discriminator_is_23() {
        assert_eq!(crate::instructions::CoreInstruction::SetInstrumentOracle as u8, 23);
    }

    #[test]
    fn test_apply_set_instrument_oracle_updates_address() {
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        let default_addr = Pubkey::default();
        assert_eq!(inst.oracle_addr, default_addr);

        let oracle_pk = Pubkey::from([0x42u8; 32]);
        apply_set_instrument_oracle(&mut inst, oracle_pk);
        assert_eq!(inst.oracle_addr, oracle_pk);
    }

    #[test]
    fn test_oracle_account_layout_offsets() {
        // Layout:
        //   0..8    magic: u64 LE
        //   8       version: u8
        //   9       bump: u8
        //   10      is_active: u8
        //   11..16  _padding: [u8; 5]
        //   16..48  authority: Pubkey (32)
        //   48..80  instrument: Pubkey (32)
        //   80..88  price: i64 LE
        //   88..96  timestamp: i64 LE
        //   96..104 confidence: i64 LE
        //   104..128 _reserved: [u8; 24]
        let mut data = [0u8; 128];
        const ORACLE_MAGIC: u64 = 0x4C43_524F_4C43_5250;
        data[0..8].copy_from_slice(&ORACLE_MAGIC.to_le_bytes());
        data[8] = 0; // version
        data[10] = 1; // is_active

        let inst_pk = Pubkey::from([0x55u8; 32]);
        data[48..80].copy_from_slice(inst_pk.as_ref());

        let magic = u64::from_le_bytes(data[0..8].try_into().unwrap());
        assert_eq!(magic, ORACLE_MAGIC);
        assert_eq!(data[8], 0);
        assert_ne!(data[10], 0);
        assert_eq!(Pubkey::from(<[u8; 32]>::try_from(&data[48..80]).unwrap()), inst_pk);
    }
}

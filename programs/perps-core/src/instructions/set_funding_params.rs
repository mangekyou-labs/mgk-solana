use crate::state::instrument::Instrument;
use crate::state::registry::Registry;
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// T9.10.5: SetFundingParams (discriminator 24) — governance-only update of
/// D7 funding parameters on an instrument.
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance (must equal `registry.governance`)
///
/// Wire: discriminator(1) + coefficient_bps(i64 LE) + max_rate_bps(i64 LE) + interval_slots(u64 LE) = 25 bytes
///
/// Validation:
///   - `coefficient_bps >= 0` (signed non-negative)
///   - `max_rate_bps >= 0` (signed non-negative)
///   - `interval_slots > 0` (zero would cause division by zero in accrual)
///
/// Side effects:
///   - Updates `instrument.funding_coefficient_bps`, `instrument.max_funding_rate_bps`,
///     and `instrument.funding_interval_slots`.
///   - Resets `instrument.last_funding_slot` to the current clock slot, preventing
///     old-SMA or previous-configuration backfill.
///   - Preserves `instrument.cum_funding` (no reset).
#[allow(clippy::too_many_arguments)]
pub fn process_set_funding_params(
    program_id: &Pubkey,
    instrument_account: &AccountInfo,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    coefficient_bps: i64,
    max_rate_bps: i64,
    interval_slots: u64,
) -> ProgramResult {
    // Validate accounts
    mgk_common::validate_owner(instrument_account, program_id)?;
    mgk_common::validate_writable(instrument_account)?;
    mgk_common::validate_owner(registry_account, program_id)?;

    // Validate governance signer
    let registry =
        unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };
    if !governance_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *governance_account.key() != registry.governance {
        msg!("Error: governance account does not match registry governance");
        return Err(MgkError::Unauthorized.into());
    }

    // Validate parameters
    if coefficient_bps < 0 {
        msg!("Error: coefficient_bps must be non-negative");
        return Err(ProgramError::InvalidInstructionData);
    }
    if max_rate_bps < 0 {
        msg!("Error: max_rate_bps must be non-negative");
        return Err(ProgramError::InvalidInstructionData);
    }
    if interval_slots == 0 {
        msg!("Error: interval_slots must be non-zero");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Apply to instrument
    let instrument =
        unsafe { &mut *(instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut Instrument) };

    instrument.funding_coefficient_bps = coefficient_bps;
    instrument.max_funding_rate_bps = max_rate_bps;
    instrument.funding_interval_slots = interval_slots;

    // Reset last_funding_slot to current clock slot to prevent backfill.
    // Preserves cum_funding.
    let clock = Clock::get()?;
    instrument.last_funding_slot = clock.slot;

    msg!("SetFundingParams: applied");

    Ok(())
}

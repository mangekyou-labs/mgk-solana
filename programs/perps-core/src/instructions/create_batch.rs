use crate::state::{Batch, Registry};
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

/// System Program ID (all zeros).
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// Batch account size (size_of::<Batch>() = 160 on BPF).
const BATCH_SPACE: usize = 160;

/// Create the first batch in Committing state.
///
/// Accounts:
///   0: [writable] Batch PDA (created here via invoke_signed if not yet existing)
///   1: [writable] Registry
///   2: [signer, writable] Payer (governance; funds PDA creation rent)
///
/// Data: bump(1)
pub fn process_create_batch(
    program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    payer_account: Option<&AccountInfo>,
    bump: u8,
) -> ProgramResult {
    validate_writable(batch_account)?;
    validate_writable(registry_account)?;

    // ── Create batch PDA if needed ──────────────────────────────────────────
    if batch_account.data_len() < BATCH_SPACE {
        let payer = payer_account.ok_or_else(|| {
            msg!("Error: payer required to create batch PDA");
            MgkError::InvalidAccount
        })?;
        if !payer.is_signer() {
            msg!("Error: payer must sign");
            return Err(MgkError::Unauthorized.into());
        }

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(BATCH_SPACE);

        // Read batch_id from registry counter to derive the correct PDA.
        let batch_id = unsafe {
            let reg_ptr = registry_account.borrow_data_unchecked().as_ptr() as *const Registry;
            (*reg_ptr).batch_id_counter
        };
        let batch_id_le = batch_id.to_le_bytes();
        let (batch_pda, _) = find_program_address(&[b"batch", &batch_id_le], program_id);

        // Build SystemProgram::CreateAccount instruction.
        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(BATCH_SPACE as u64).to_le_bytes());
        ix_data[20..52].copy_from_slice(program_id.as_ref());

        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID);
        let metas = [
            AccountMeta::writable_signer(payer.key()),
            AccountMeta::writable_signer(&batch_pda),
        ];
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };

        let bump_seed = [bump];
        let signer_seeds = pinocchio::seeds!(b"batch", batch_id_le.as_slice(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[payer, batch_account], &[signer])?;
        msg!("Batch PDA created");
    }

    // Verify batch is not already initialized (batch_id != 0 means already in use).
    let batch_probe = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };
    if batch_probe.batch_id != 0 {
        return Err(MgkError::AlreadyInitialized.into());
    }

    let current_slot = Clock::get()?.slot;
    // batch_id equals the current registry counter value (0 for the first batch).
    // After this, counter is incremented so it equals total batches created.
    let batch_id = unsafe {
        let reg_ptr = registry_account.borrow_data_unchecked().as_ptr() as *const Registry;
        (*reg_ptr).batch_id_counter
    };

    // Use raw pointer write to avoid SBF compiler bug with struct field assignment.
    // The field assignment `registry.batch_id_counter = batch_id` was observed to
    // write bytes to offset 40-43 instead of 36-43 on the SBF target (byte-reversal
    // of the u64 across the field boundary). Using ptr::write_volatile forces
    // the compiler to emit the correct store instruction.
    let registry_data_ptr =
        unsafe { registry_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };
    // Read t_max_slots via raw pointer (field offset 64, u64)
    let t_max_slots = unsafe {
        let ptr = registry_data_ptr.add(64) as *const u64;
        *ptr
    };
    // Write batch_id_counter via raw byte offset (field offset 36, u64).
    // Using raw pointer arithmetic avoids any struct-layout issues on the SBF
    // target where field-based dereferencing may compute incorrect addresses.
    // After this, counter = total batches created = batch_id + 1.
    unsafe {
        let next_counter = batch_id.saturating_add(1).to_le_bytes();
        core::ptr::write_volatile(registry_data_ptr.add(36), next_counter[0]);
        core::ptr::write_volatile(registry_data_ptr.add(37), next_counter[1]);
        core::ptr::write_volatile(registry_data_ptr.add(38), next_counter[2]);
        core::ptr::write_volatile(registry_data_ptr.add(39), next_counter[3]);
        core::ptr::write_volatile(registry_data_ptr.add(40), next_counter[4]);
        core::ptr::write_volatile(registry_data_ptr.add(41), next_counter[5]);
        core::ptr::write_volatile(registry_data_ptr.add(42), next_counter[6]);
        core::ptr::write_volatile(registry_data_ptr.add(43), next_counter[7]);
    }

    // Direct byte-offset writes to avoid SBF compiler bug with struct field
    // assignment (same root cause as the registry init bug). The SBF compiler
    // miscompiles field-based writes when 8-byte values cross alignment
    // boundaries. Using ptr::add + explicit type casts forces correct offsets.
    //
    // Batch layout (all little-endian):
    //   @0   batch_id          u64
    //   @8   status            u8 (0=Committing)
    //   @9   _pad_status       [u8; 7]
    //   @16  commit_deadline   u64
    //   @24  reveal_deadline   u64
    //   @32  close_slot        u64
    //   @40  shuffle_seed      u64
    //   @48  clearing_price    i64
    //   @56  total_commitments u32
    //   @60  total_revealed    u32
    //   @64  total_settled     u32
    //   @68  total_volume      u64
    //   @76  total_notional    u128
    //   @92  slashed_deposits  u128
    //   @108 bump              u8
    //   @109 _padding          [u8; 7]
    let dst = unsafe { batch_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };
    unsafe {
        *(dst as *mut u64) = batch_id; // @0
        *dst.add(8) = 0; // @8 status = Committing
                         // _pad_status @9..16 left zero (account created with zeroed space)
        *(dst.add(16) as *mut u64) = current_slot.saturating_add(t_max_slots); // @16 commit_deadline
        *(dst.add(24) as *mut u64) = 0; // @24 reveal_deadline
        *(dst.add(32) as *mut u64) = 0; // @32 close_slot
        *(dst.add(40) as *mut u64) = 0; // @40 shuffle_seed
        *(dst.add(48) as *mut i64) = 0; // @48 clearing_price
        *(dst.add(56) as *mut u32) = 0; // @56 total_commitments
        *(dst.add(60) as *mut u32) = 0; // @60 total_revealed
        *(dst.add(64) as *mut u32) = 0; // @64 total_settled
        *(dst.add(68) as *mut u64) = 0; // @68 total_volume
                                        // total_notional @76..92 and slashed_deposits @92..108 left zero
        *dst.add(108) = bump; // @108 bump
                              // _padding @109..115 left zero
    }

    Ok(())
}

/// Reset `batch_id_counter` to 0 so `CreateBatch` can bootstrap batch 0.
///
/// Accounts:
///   0: [writable] Registry
///   1: [signer]   Governance (must equal registry.governance)
pub fn process_set_batch_counter(
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
) -> ProgramResult {
    let program_id = registry_account.owner();
    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;

    let registry_data_ptr = unsafe { registry_account.borrow_data_unchecked().as_ptr() };

    // Read current governance from registry (offset 0, Pubkey = 32 bytes)
    let governance_ptr = registry_data_ptr as *const Pubkey;
    let stored_governance = unsafe { *governance_ptr };

    // Governance check via raw pointer (avoids layout issues on SBF)
    let caller = governance_account.key();
    if caller.as_ref() != stored_governance {
        return Err(MgkError::Unauthorized.into());
    }

    // Write 0 to batch_id_counter at offset 36 (u64)
    unsafe {
        let ptr = registry_data_ptr.add(36) as *mut u64;
        *ptr = 0;
    }

    Ok(())
}

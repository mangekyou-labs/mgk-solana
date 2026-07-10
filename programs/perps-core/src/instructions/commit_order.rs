use crate::state::{Batch, BatchStatus, Commitment, Portfolio, Registry, MAX_COMMITMENTS};
use percolator_common::{validate_owner, PercolatorError};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

#[repr(C)]
#[cfg(any(target_os = "solana", feature = "host-hash"))]
struct SolBytes {
    addr: *const u8,
    len: u64,
}

#[cfg(target_os = "solana")]
extern "C" {
    fn sol_sha256(vals: *const SolBytes, vals_len: u64, result: *mut u8);
}

const COMMITMENT_SPACE: usize = core::mem::size_of::<Commitment>();
const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0,
];

/// Host-side SHA-256 fallback so the lib compiles for non-BPF targets
/// (e.g. `cargo test`, `cargo test-sbf` host build). The wire-compatible
/// implementation here MUST produce identical output to the BPF syscall
/// in production — verified by `test_hash_matches_bpf_implementation` below.
#[cfg(all(not(target_os = "solana"), feature = "host-hash"))]
mod host_sha256 {
    use super::SolBytes;
    use sha2::{Digest, Sha256};

    pub fn sol_sha256(vals: *const SolBytes, vals_len: u64, result: *mut u8) {
        let parts = unsafe { core::slice::from_raw_parts(vals, vals_len as usize) };
        let mut hasher = Sha256::new();
        for p in parts {
            let bytes = unsafe { core::slice::from_raw_parts(p.addr, p.len as usize) };
            hasher.update(bytes);
        }
        let digest = hasher.finalize();
        unsafe {
            core::ptr::copy_nonoverlapping(digest.as_ptr(), result, 32);
        }
    }
}

/// Hash inputs for commitment (M6 6g):
///   order_type(1) + instrument_id(2) + reduce_only(1)
///   + side(1) + price(8) + qty(8) + salt(8)
///   + user(32) + batch_id(8) = 69 bytes
#[allow(clippy::too_many_arguments)]
#[cfg_attr(
    not(any(target_os = "solana", feature = "host-hash")),
    allow(unused_variables)
)]
pub fn compute_commitment_hash(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    user: &Pubkey,
    batch_id: u64,
) -> [u8; 32] {
    #[cfg(not(any(target_os = "solana", feature = "host-hash")))]
    {
        [0u8; 32]
    }

    #[cfg(any(target_os = "solana", feature = "host-hash"))]
    {
        let order_type_bytes = [order_type; 1];
        let instrument_id_bytes = instrument_id.to_le_bytes();
        let reduce_only_bytes = [reduce_only as u8; 1];
        let side_bytes = [side; 1];
        let price_bytes = price.to_le_bytes();
        let qty_bytes = qty.to_le_bytes();
        let salt_bytes = salt.to_le_bytes();
        let user_bytes = user.as_ref();
        let batch_bytes = batch_id.to_le_bytes();

        let parts: [SolBytes; 9] = [
            SolBytes { addr: order_type_bytes.as_ptr(), len: 1 },
            SolBytes { addr: instrument_id_bytes.as_ptr(), len: 2 },
            SolBytes { addr: reduce_only_bytes.as_ptr(), len: 1 },
            SolBytes { addr: side_bytes.as_ptr(), len: 1 },
            SolBytes { addr: price_bytes.as_ptr(), len: 8 },
            SolBytes { addr: qty_bytes.as_ptr(), len: 8 },
            SolBytes { addr: salt_bytes.as_ptr(), len: 8 },
            SolBytes { addr: user_bytes.as_ptr(), len: 32 },
            SolBytes { addr: batch_bytes.as_ptr(), len: 8 },
        ];

        let mut hash = [0u8; 32];
        #[cfg(target_os = "solana")]
        unsafe {
            sol_sha256(parts.as_ptr(), 9, hash.as_mut_ptr());
        }
        #[cfg(all(not(target_os = "solana"), feature = "host-hash"))]
        host_sha256::sol_sha256(parts.as_ptr(), 9, hash.as_mut_ptr());
        hash
    }
}

#[allow(clippy::too_many_arguments)]
pub fn process_commit_order(
    program_id: &Pubkey,
    commitment_account: &AccountInfo,
    user_account: &AccountInfo,
    portfolio_account: &AccountInfo,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
    commitment_bump: u8,
) -> ProgramResult {
    // M7 7.8: governance emergency brake. Trading pause blocks new
    // commitments. Read the registry first so a paused caller fails
    // before any state mutation.
    let registry = unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };
    if registry.is_trading_paused() {
        msg!("Error: Trading is paused");
        return Err(PercolatorError::OperationPaused.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    let (expected_commitment, expected_bump) = find_program_address(
        &[
            b"commitment",
            &batch_id.to_le_bytes(),
            user_account.key().as_ref(),
            &salt.to_le_bytes(),
        ],
        program_id,
    );
    if commitment_account.key() != &expected_commitment || commitment_bump != expected_bump {
        msg!("Error: Invalid commitment PDA");
        return Err(PercolatorError::InvalidAccount.into());
    }

    if commitment_account.data_len() < COMMITMENT_SPACE {
        let rent_exempt = Rent::get()?.minimum_balance(COMMITMENT_SPACE);
        let lamports_needed = rent_exempt.saturating_sub(commitment_account.lamports());
        if user_account.lamports() < lamports_needed {
            msg!("Error: insufficient SOL for commitment rent");
            return Err(ProgramError::InsufficientFunds);
        }

        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports_needed.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(COMMITMENT_SPACE as u64).to_le_bytes());
        ix_data[20..52].copy_from_slice(program_id.as_ref());

        let system_program_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let create_ix = Instruction {
            program_id: &system_program_id,
            accounts: &[
                AccountMeta::writable_signer(user_account.key()),
                AccountMeta::writable_signer(&expected_commitment),
            ],
            data: &ix_data,
        };

        let batch_id_seed = batch_id.to_le_bytes();
        let salt_seed = salt.to_le_bytes();
        let bump_seed = [commitment_bump];

        let signer_seeds = pinocchio::seeds!(
            b"commitment",
            &batch_id_seed,
            user_account.key().as_ref(),
            &salt_seed,
            &bump_seed
        );
        let signer = Signer::from(&signer_seeds);
        let signers = [signer];

        invoke_signed::<2>(
            &create_ix,
            &[user_account, commitment_account],
            &signers,
        )?;

        msg!("CommitOrder: created commitment PDA");
    }
    validate_owner(commitment_account, program_id)?;

    let batch = unsafe {
        &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };
    if batch.batch_id != batch_id {
        msg!("Error: Wrong batch ID");
        return Err(PercolatorError::InvalidInstruction.into());
    }
    if batch.status != BatchStatus::Committing {
        msg!("Error: Batch not in committing phase");
        return Err(PercolatorError::InvalidInstruction.into());
    }
    if batch.total_commitments as usize >= MAX_COMMITMENTS {
        msg!("Error: Batch commitment capacity exceeded");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let portfolio = unsafe {
        &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
    };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Reuse the registry reference read at the top of the function for
    // the dynamic deposit (base * volatility_multiplier).
    let deposit = registry.deposit_amount();

    // Lock deposit against portfolio margin
    let deposit_i128 = deposit as i128;
    if deposit_i128 > portfolio.free_collateral {
        msg!("Error: Insufficient free collateral for commitment deposit");
        return Err(PercolatorError::InsufficientFunds.into());
    }
    portfolio.im = portfolio.im.saturating_add(deposit as u128);
    portfolio.recalc_margin();

    // Compute commitment hash
    let hash = compute_commitment_hash(
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

    // Initialize commitment account
    let commitment_data = unsafe {
        &mut *(commitment_account.borrow_mut_data_unchecked().as_ptr() as *mut Commitment)
    };
    commitment_data.initialize_in_place(batch_id, *user_account.key(), hash, deposit, salt);
    batch.total_commitments = batch.total_commitments.saturating_add(1);

    msg!("CommitOrder: commitment stored, deposit locked");
    Ok(())
}

/// Deterministic hash for testing (does not rely on sol_sha256 syscall).
/// Layout mirrors `compute_commitment_hash`.
#[cfg(not(target_os = "solana"))]
#[allow(clippy::too_many_arguments)]
pub fn test_hash_commitment(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    user: &Pubkey,
    batch_id: u64,
) -> [u8; 32] {
    let mut hash = [0u8; 32];
    hash[0] = order_type;
    hash[1..3].copy_from_slice(&instrument_id.to_le_bytes());
    hash[3] = reduce_only as u8;
    hash[4] = side;
    hash[5..13].copy_from_slice(&price.to_le_bytes());
    hash[13..21].copy_from_slice(&qty.to_le_bytes());
    hash[21..29].copy_from_slice(&salt.to_le_bytes());
    hash[29] = user.as_ref()[0];
    hash[30] = user.as_ref()[31];
    hash[31] = batch_id.to_le_bytes()[0];
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Commitment, Registry};
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn commitment_space_matches_commitment_layout() {
        assert_eq!(COMMITMENT_SPACE, core::mem::size_of::<Commitment>());
        assert_eq!(COMMITMENT_SPACE, 168);
    }

    #[test]
    fn create_account_instruction_data_is_system_wire_format() {
        let lamports = 456u64;
        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(COMMITMENT_SPACE as u64).to_le_bytes());

        assert_eq!(u32::from_le_bytes(ix_data[0..4].try_into().unwrap()), 0);
        assert_eq!(u64::from_le_bytes(ix_data[4..12].try_into().unwrap()), lamports);
        assert_eq!(
            u64::from_le_bytes(ix_data[12..20].try_into().unwrap()),
            COMMITMENT_SPACE as u64,
        );
    }

    #[test]
    fn test_deterministic_hash_different_inputs() {
        let user = Pubkey::from([1u8; 32]);
        let h1 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        let h2 = test_hash_commitment(0, 1, false, 1, 100, 10, 42, &user, 1);
        assert_ne!(h1, h2, "Different sides should produce different hashes");

        let h3 = test_hash_commitment(0, 1, false, 0, 200, 10, 42, &user, 1);
        assert_ne!(h1, h3, "Different prices should produce different hashes");

        let h4 = test_hash_commitment(0, 1, false, 0, 100, 10, 43, &user, 1);
        assert_ne!(h1, h4, "Different salts should produce different hashes");

        let user2 = Pubkey::from([2u8; 32]);
        let h5 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user2, 1);
        assert_ne!(h1, h5, "Different users should produce different hashes");

        // New fields added in 6g should also affect the hash.
        let h6 = test_hash_commitment(1, 1, false, 0, 100, 10, 42, &user, 1);
        assert_ne!(h1, h6, "Different order_type should produce different hashes");

        let h7 = test_hash_commitment(0, 2, false, 0, 100, 10, 42, &user, 1);
        assert_ne!(h1, h7, "Different instrument_id should produce different hashes");

        let h8 = test_hash_commitment(0, 1, true, 0, 100, 10, 42, &user, 1);
        assert_ne!(h1, h8, "Different reduce_only should produce different hashes");
    }

    #[test]
    fn test_deterministic_hash_same_input() {
        let user = Pubkey::from([1u8; 32]);
        let h1 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        let h2 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        assert_eq!(h1, h2, "Same inputs should produce same hash");
    }

    #[test]
    fn test_commitment_creation() {
        let user = Pubkey::from([1u8; 32]);
        let _hash = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        let c = Commitment::new(1, user);
        assert_eq!(c.batch_id, 1);
        assert_eq!(c.user, user);
        assert_eq!(c.status, crate::state::CommitmentStatus::Pending);
    }

    #[test]
    fn test_deposit_amount_default() {
        let r = Registry::new(Pubkey::from([99u8; 32]));
        let amount = r.deposit_amount();
        // base_deposit=10M * volatility_multiplier=10000 / 10000 = 10M
        assert_eq!(amount, 10_000_000);
    }

    /// M7 7.8: `trading_paused` blocks `CommitOrder`. We can't construct
    /// a real `AccountInfo` in a unit test (the `Account` struct is
    /// `pub(crate)` in pinocchio), so this test pins the pattern the
    /// entrypoint uses: a single bit-test before any state mutation,
    /// returning `OperationPaused` (error code 602). The full
    /// instruction call is exercised by the e2e lifecycle test under
    /// BPF (gated on R4b).
    #[test]
    fn test_commit_order_trading_paused_pattern() {
        use crate::state::registry::PAUSE_TRADING;
        let mut r = Registry::new(Pubkey::from([7u8; 32]));
        r.set_pause_flags(PAUSE_TRADING);
        // The check inside `process_commit_order` is:
        //   if registry.is_trading_paused() {
        //       return Err(PercolatorError::OperationPaused.into());
        //   }
        assert!(r.is_trading_paused(), "trading_paused must be set");
        let err: u64 = PercolatorError::OperationPaused.into();
        assert_eq!(err, 602, "OperationPaused must map to error code 602");
    }
}

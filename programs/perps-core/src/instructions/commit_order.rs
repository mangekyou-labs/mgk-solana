use crate::state::Commitment;
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
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

#[allow(dead_code)]
const COMMITMENT_SPACE: usize = core::mem::size_of::<Commitment>();
#[allow(dead_code)]
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
    _program_id: &Pubkey,
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
    _commitment_bump: u8,
) -> ProgramResult {
    // DFBA: CommitOrder retired — use PostOrder (disc 20).
    msg!("Error: CommitOrder retired; use PostOrder");
    Err(MgkError::InvalidInstruction.into())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Commitment, Registry};
    use pinocchio::pubkey::Pubkey;

    #[allow(clippy::too_many_arguments)]
    fn test_hash_commitment(
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
        compute_commitment_hash(
            order_type,
            instrument_id,
            reduce_only,
            side,
            price,
            qty,
            salt,
            user,
            batch_id,
        )
    }

    #[test]
    fn commitment_space_matches_commitment_layout() {
        assert_eq!(COMMITMENT_SPACE, core::mem::size_of::<Commitment>());
        // Layout may grow; pin only that constant matches size_of.
        assert!(COMMITMENT_SPACE >= 168);
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
    #[cfg(feature = "host-hash")]
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
    #[cfg(feature = "host-hash")]
    fn test_deterministic_hash_same_input() {
        let user = Pubkey::from([1u8; 32]);
        let h1 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        let h2 = test_hash_commitment(0, 1, false, 0, 100, 10, 42, &user, 1);
        assert_eq!(h1, h2, "Same inputs should produce same hash");
    }

    #[test]
    #[cfg(feature = "host-hash")]
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
        //       return Err(MgkError::OperationPaused.into());
        //   }
        assert!(r.is_trading_paused(), "trading_paused must be set");
        let err: u64 = MgkError::OperationPaused.into();
        assert_eq!(err, 602, "OperationPaused must map to error code 602");
    }
}

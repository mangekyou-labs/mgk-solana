use pinocchio::pubkey::{find_program_address, Pubkey};

pub const PORTFOLIO_SEED: &[u8] = b"portfolio";
pub const INSTRUMENT_SEED: &[u8] = b"instrument";
pub const VAULT_SEED: &[u8] = b"vault";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const BATCH_SEED: &[u8] = b"batch";
pub const COMMITMENT_SEED: &[u8] = b"commitment";

pub fn derive_portfolio_pda(user: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[PORTFOLIO_SEED, user.as_ref()], program_id)
}

pub fn derive_instrument_pda(instrument_id: u16, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[INSTRUMENT_SEED, &instrument_id.to_le_bytes()], program_id)
}

pub fn derive_vault_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[VAULT_SEED], program_id)
}

pub fn derive_registry_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[REGISTRY_SEED], program_id)
}

pub fn derive_batch_pda(batch_id: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[BATCH_SEED, &batch_id.to_le_bytes()], program_id)
}

pub fn derive_commitment_pda(
    batch_id: u64,
    user: &Pubkey,
    nonce: u64,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    find_program_address(
        &[
            COMMITMENT_SEED,
            &batch_id.to_le_bytes(),
            user.as_ref(),
            &nonce.to_le_bytes(),
        ],
        program_id,
    )
}

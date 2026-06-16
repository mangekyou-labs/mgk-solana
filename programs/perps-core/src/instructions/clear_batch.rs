use crate::state::{MAX_COMMITMENTS, Batch, BatchStatus, Commitment, CommitmentStatus};
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// Bytes per order in the CPI payload (M6 6g).
/// side(1) + price(8) + qty(8) + user(32) + order_type(1) + instrument_id(2) + reduce_only(1) = 53
const BYTES_PER_ORDER: usize = 53;
/// Header bytes: close_slot(8) + num_orders(2) = 10
const HEADER_BYTES: usize = 10;
/// Maximum CPI payload size: header + max orders.
const CPI_DATA_SIZE: usize = HEADER_BYTES + MAX_COMMITMENTS * BYTES_PER_ORDER;

/// Matcher `ClearAndMatch` discriminator (M6 6i.2).
pub const MATCHER_CLEAR_AND_MATCH: u8 = 3;

pub fn process_clear_batch(
    _program_id: &Pubkey,
    batch_account: &AccountInfo,
    book_account: &AccountInfo,
    results_account: &AccountInfo,
    matcher_program: &AccountInfo,
    _registry_account: &AccountInfo,
    commitment_accounts: &[AccountInfo],
) -> ProgramResult {
    let batch = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };

    if batch.status != BatchStatus::Revealing {
        msg!("Error: Batch not in revealing phase");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let total_commitments = batch.total_commitments as usize;
    if total_commitments == 0 {
        msg!("Error: No commitments to clear");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // Build CPI payload for matcher's ClearAndMatch.
    // Header: close_slot(8) + num_orders(2) = 10
    // Per order: 53 bytes (M6 6g format).
    let mut cpi_data = [0u8; CPI_DATA_SIZE];
    cpi_data[0..8].copy_from_slice(&batch.close_slot.to_le_bytes());
    cpi_data[8..10].copy_from_slice(&(total_commitments as u16).to_le_bytes());
    let mut offset = HEADER_BYTES;

    for commitment_account in commitment_accounts.iter().take(total_commitments) {
        let commitment = unsafe {
            &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
        };

        if commitment.status != CommitmentStatus::Revealed {
            msg!("Warning: Commitment not revealed, skipping");
            continue;
        }

        let r = &commitment.revealed;
        let side = r.side as u8;
        let price = r.price;
        let qty = r.qty;
        let order_type = r.order_type as u8;
        let instrument_id = r.instrument_id;
        let reduce_only = r.reduce_only as u8;

        cpi_data[offset] = side;
        cpi_data[offset + 1..offset + 9].copy_from_slice(&price.to_le_bytes());
        cpi_data[offset + 9..offset + 17].copy_from_slice(&qty.to_le_bytes());
        cpi_data[offset + 17..offset + 49].copy_from_slice(r.user.as_ref());
        cpi_data[offset + 49] = order_type;
        cpi_data[offset + 50..offset + 52].copy_from_slice(&instrument_id.to_le_bytes());
        cpi_data[offset + 52] = reduce_only;
        offset += BYTES_PER_ORDER;
    }

    // CPI to matcher's ClearAndMatch (discriminator 3 prepended).
    let mut cpi_instruction_data = [0u8; CPI_DATA_SIZE + 1];
    cpi_instruction_data[0] = MATCHER_CLEAR_AND_MATCH;
    cpi_instruction_data[1..1 + offset].copy_from_slice(&cpi_data[..offset]);

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: book_account.key(),
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: results_account.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &cpi_instruction_data[..1 + offset],
    };

    invoke(
        &cpi_instruction,
        &[book_account, results_account, matcher_program],
    )?;

    // Transition to Clearing
    let batch_mut = unsafe {
        &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };
    batch_mut.status = BatchStatus::Clearing;

    msg!("ClearBatch: CLOB match via matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // Header: close_slot(8) + num_orders(2) = 10
        assert_eq!(HEADER_BYTES, 10);
        // Per order: 53 bytes (M6 6g).
        assert_eq!(BYTES_PER_ORDER, 53);
        // Max payload: 10 + MAX_COMMITMENTS * 53.
        assert_eq!(CPI_DATA_SIZE, 10 + MAX_COMMITMENTS * 53);
    }

    #[test]
    fn test_matcher_clear_and_match_discriminator_is_three() {
        // Pin to matcher's entrypoint.rs.
        assert_eq!(MATCHER_CLEAR_AND_MATCH, 3);
    }

    #[test]
    fn test_cpi_header_writes_close_slot_and_num_orders() {
        let mut buf = [0u8; HEADER_BYTES + 53];
        let close_slot: u64 = 0xDEAD_BEEF_CAFE_BABE;
        let num_orders: u16 = 1;
        buf[0..8].copy_from_slice(&close_slot.to_le_bytes());
        buf[8..10].copy_from_slice(&num_orders.to_le_bytes());
        assert_eq!(
            u64::from_le_bytes(buf[0..8].try_into().unwrap()),
            close_slot
        );
        assert_eq!(u16::from_le_bytes(buf[8..10].try_into().unwrap()), 1);
    }
}

use crate::state::Portfolio;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use percolator_common::PercolatorError;

pub fn process_init_portfolio(
    portfolio_account: &AccountInfo,
    user: &Pubkey,
    _bump: u8,
) -> ProgramResult {
    // Portfolio size follows the actual repr(C) layout.
    const PORTFOLIO_SIZE: usize = core::mem::size_of::<Portfolio>();

    // The portfolio account MUST already exist (created by the keeper via
    // InitPortfolioForUser disc 19). We do NOT create accounts here —
    // writing to a 0-byte buffer is a BPF memory access violation.
        if portfolio_account.data_len() < PORTFOLIO_SIZE {
        msg!("Error: Portfolio account does not exist or is too small");
        return Err(ProgramError::InvalidAccountData);
    }

    let data_ptr = unsafe { portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };

    // Safe: data_len >= Portfolio, struct reference is valid.
    let portfolio_data = unsafe {
        &mut *(data_ptr as *mut Portfolio)
    };

    // Idempotent: if already initialized for this user, succeed silently.
    if portfolio_data.user == *user {
        msg!("Portfolio already initialized for user");
        return Ok(());
    }

    // If user field is non-zero but doesn't match signer, reject.
    if portfolio_data.user != Pubkey::from([0u8; 32]) {
        msg!("Error: Portfolio already initialized for different user");
        return Err(PercolatorError::Unauthorized.into());
    }

    portfolio_data.initialize_in_place(*user, 0);
    msg!("Portfolio initialized");
    Ok(())
}

use crate::state::Portfolio;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn process_init_portfolio(
    portfolio_account: &AccountInfo,
    user: &Pubkey,
    bump: u8,
) -> ProgramResult {
    let portfolio_data = unsafe {
        &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
    };
    portfolio_data.initialize_in_place(*user, bump);
    msg!("Portfolio initialized");
    Ok(())
}

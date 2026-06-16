use crate::state::portfolio::Portfolio;
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo, msg, ProgramResult,
};

/// Liquidate an underwater portfolio.
///
/// Marks positions at oracle price ± confidence band (worst case for portfolio),
/// claims insurance if equity is still negative, and zeroes out positions.
pub fn process_liquidate_user(
    portfolio_account: &AccountInfo,
    _registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    liquidator_account: &AccountInfo,
    oracle_accounts: &[AccountInfo],
) -> ProgramResult {
    if !liquidator_account.is_signer() {
        msg!("Error: Liquidator must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    if oracle_accounts.is_empty() {
        msg!("Error: At least one oracle feed required");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let portfolio = unsafe {
        &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
    };

    if portfolio.positions_len == 0 {
        msg!("Error: No positions to liquidate");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // Check health — only liquidate if underwater
    if portfolio.health >= 0 {
        msg!("Error: Portfolio is healthy, cannot liquidate");
        return Err(PercolatorError::PortfolioHealthy.into());
    }

    // Read oracle prices from oracle feeds
    // For each instrument position, match against corresponding oracle feed
    // MVP: use the first oracle for all positions
    let oracle_data = oracle_accounts[0].try_borrow_data()
        .map_err(|_| PercolatorError::InvalidAccount)?;

    if oracle_data.len() < 128 {
        msg!("Error: Oracle account too small");
        return Err(PercolatorError::InvalidAccount.into());
    }

    // Check oracle is active
    let is_active_offset = 1 + 1 + 1; // magic(8) + version(1) + bump(1)
    if oracle_data[is_active_offset] == 0 {
        msg!("Error: Oracle is not active");
        return Err(PercolatorError::StalePrice.into());
    }

    // Read price and confidence
    let price_offset = 1 + 1 + 1 + 1 + 5 + 32 + 32;
    let price_bytes: [u8; 8] = oracle_data[price_offset..price_offset + 8].try_into().unwrap();
    let confidence_bytes: [u8; 8] = oracle_data[price_offset + 16..price_offset + 24].try_into().unwrap();
    let oracle_price = i64::from_le_bytes(price_bytes);
    let confidence = i64::from_le_bytes(confidence_bytes);

    // Liquidation margin buffer (add to health check)
    let _registry = unsafe {
        &*(_registry_account.borrow_data_unchecked().as_ptr() as *const Registry)
    };

    // Mark all positions at worst case price and compute loss
    let mut total_loss: i128 = 0;

    for i in 0..(portfolio.positions_len as usize) {
        let pos = &portfolio.positions[i];
        if pos.qty == 0 {
            continue;
        }

        // Worst case for portfolio: longs get low price, shorts get high price
        let liquidation_price = if pos.qty > 0 {
            // Long position: worst case is oracle_price - confidence (lower bound)
            oracle_price.saturating_sub(confidence)
        } else {
            // Short position: worst case is oracle_price + confidence (upper bound)
            oracle_price.saturating_add(confidence)
        };

        // PnL = qty * (liquidation_price - entry_vwap)
        let price_delta = (liquidation_price as i128) - (pos.entry_vwap as i128);
        let pnl = (pos.qty as i128) * price_delta;
        total_loss = total_loss.saturating_add(pnl);
    }

    // Apply liquidation loss to equity
    portfolio.equity = portfolio.equity.saturating_sub(total_loss);
    portfolio.pnl = portfolio.pnl.saturating_sub(total_loss);

    // If still negative, claim from insurance
    if portfolio.equity < 0 {
        let bad_debt = portfolio.equity.unsigned_abs();
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };

        let payout = bad_debt.min(vault.insurance_fund);
        if payout > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_sub(payout);
            portfolio.equity = portfolio.equity.saturating_add(payout as i128);
            // Record uncovered bad debt
            vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(
                bad_debt.saturating_sub(payout)
            );
            msg!("Insurance claim processed");
        }
    }

    // Zero out positions
    for i in 0..(portfolio.positions_len as usize) {
        portfolio.positions[i].qty = 0;
        portfolio.positions[i].entry_vwap = 0;
    }
    portfolio.positions_len = 0;
    portfolio.im = 0;
    portfolio.mm = 0;
    portfolio.recalc_margin();

    msg!("LiquidateUser: Portfolio liquidated");
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::state::{Portfolio, Vault};
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_portfolio_health_check() {
        let user = Pubkey::from([1u8; 32]);
        let mut p = Portfolio::new(user);
        p.equity = -1000;
        p.recalc_margin();
        assert!(p.health < 0, "Negative equity should result in negative health");

        let mut p2 = Portfolio::new(user);
        p2.equity = 1000;
        p2.recalc_margin();
        assert!(p2.health >= 0, "Positive equity should result in non-negative health");
    }

    #[test]
    fn test_liquidation_pnl_calculation() {
        // Long position liquidation at lower bound
        let entry = 100_000_000i64;
        let mark = 90_000_000i64;
        let conf = 5_000_000i64;
        let liq_price = mark.saturating_sub(conf); // 85_000_000
        let qty: i64 = 10;

        let price_delta = (liq_price as i128) - (entry as i128);
        let pnl = (qty as i128) * price_delta;
        // Long loss: (85 - 100) * 10 = -150
        assert_eq!(pnl, -150_000_000);

        // Short position liquidation at upper bound
        let liq_price = mark.saturating_add(conf); // 95_000_000
        let qty: i64 = -10;
        let price_delta = (liq_price as i128) - (entry as i128);
        let pnl = (qty as i128) * price_delta;
        // Short loss: (95 - 100) * -10 = 50... wait, short PnL = -qty * (exit - entry)
        // Actually: PnL = qty * (liq - entry) = -10 * (95 - 100) = -10 * (-5) = 50
        assert_eq!(pnl, 50_000_000);
    }

    #[test]
    fn test_insurance_payout() {
        let mut vault = Vault::new();
        vault.insurance_fund = 100_000;
        vault.balance = 1_000_000;

        let bad_debt: u128 = 50_000;
        let payout = bad_debt.min(vault.insurance_fund);
        vault.insurance_fund -= payout;
        let uncovered = bad_debt.saturating_sub(payout);
        vault.uncovered_bad_debt += uncovered;

        assert_eq!(vault.insurance_fund, 50_000);
        assert_eq!(vault.uncovered_bad_debt, 0);

        // Partial coverage
        let bad_debt2: u128 = 60_000;
        let payout2 = bad_debt2.min(vault.insurance_fund);
        vault.insurance_fund -= payout2;
        vault.uncovered_bad_debt += bad_debt2.saturating_sub(payout2);

        assert_eq!(vault.insurance_fund, 0);
        assert_eq!(vault.uncovered_bad_debt, 10_000);
    }
}

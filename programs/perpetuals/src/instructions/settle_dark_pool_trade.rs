//! Settlement Bridge for Darkpool Integration
//! 
//! This module handles the settlement of darkpool trades with the main perpetuals program.
//! It listens for darkpool trade events and executes the corresponding position changes
//! in the perpetuals system.

use {
    crate::{
        error::PerpetualsError,
        instructions::*,
        state::{
            custody::Custody,
            oracle::OraclePrice,
            perpetuals::Perpetuals,
            pool::Pool,
            position::{Position, Side},
        },
    },
    anchor_lang::prelude::*,
    anchor_spl::token::{Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DarkPoolTradeData {
    pub trader_a: Pubkey,
    pub trader_b: Pubkey,
    pub side_a: Side, // Side for trader A
    pub side_b: Side, // Side for trader B (opposite of A)
    pub size_usd: u64,
    pub price: u64,
    pub pool: Pubkey,
    pub custody: Pubkey,
    pub collateral_custody: Pubkey,
    pub timestamp: i64,
    pub darkpool_signature: [u8; 64], // Signature from darkpool program
}

#[derive(Accounts)]
#[instruction(params: SettleDarkPoolTradeParams)]
pub struct SettleDarkPoolTrade<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: empty PDA, authority for token accounts
    #[account(
        seeds = [b"transfer_authority"],
        bump = perpetuals.transfer_authority_bump
    )]
    pub transfer_authority: AccountInfo<'info>,

    #[account(
        seeds = [b"perpetuals"],
        bump = perpetuals.perpetuals_bump
    )]
    pub perpetuals: Box<Account<'info, Perpetuals>>,

    #[account(
        mut,
        seeds = [b"pool", pool.name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [b"custody", pool.key().as_ref(), custody.mint.as_ref()],
        bump = custody.bump
    )]
    pub custody: Box<Account<'info, Custody>>,

    #[account(
        mut,
        seeds = [b"custody", pool.key().as_ref(), collateral_custody.mint.as_ref()],
        bump = collateral_custody.bump
    )]
    pub collateral_custody: Box<Account<'info, Custody>>,

    /// CHECK: oracle account for the position token
    #[account(
        constraint = custody_oracle_account.key() == custody.oracle.oracle_account
    )]
    pub custody_oracle_account: AccountInfo<'info>,

    /// CHECK: oracle account for the collateral token
    #[account(
        constraint = collateral_custody_oracle_account.key() == collateral_custody.oracle.oracle_account
    )]
    pub collateral_custody_oracle_account: AccountInfo<'info>,

    // Position accounts for both traders
    #[account(
        mut,
        seeds = [
            b"position",
            params.trade_data.trader_a.as_ref(),
            pool.key().as_ref(),
            custody.key().as_ref(),
            &[params.trade_data.side_a as u8]
        ],
        bump
    )]
    pub position_a: Box<Account<'info, Position>>,

    #[account(
        mut,
        seeds = [
            b"position",
            params.trade_data.trader_b.as_ref(),
            pool.key().as_ref(),
            custody.key().as_ref(),
            &[params.trade_data.side_b as u8]
        ],
        bump
    )]
    pub position_b: Box<Account<'info, Position>>,

    // Funding accounts for both traders
    #[account(
        mut,
        constraint = funding_account_a.mint == collateral_custody.mint,
        constraint = funding_account_a.owner == params.trade_data.trader_a
    )]
    pub funding_account_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = funding_account_b.mint == collateral_custody.mint,
        constraint = funding_account_b.owner == params.trade_data.trader_b
    )]
    pub funding_account_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"custody_token_account", pool.key().as_ref(), collateral_custody.mint.as_ref()],
        bump = collateral_custody.token_account_bump
    )]
    pub collateral_custody_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Darkpool program for verification
    #[account(
        constraint = darkpool_program.key() == params.expected_darkpool_program
    )]
    pub darkpool_program: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleDarkPoolTradeParams {
    pub trade_data: DarkPoolTradeData,
    pub expected_darkpool_program: Pubkey,
    pub collateral_amount_a: u64,
    pub collateral_amount_b: u64,
    pub max_price_slippage: u16, // in bps
}

pub fn settle_dark_pool_trade(
    ctx: Context<SettleDarkPoolTrade>,
    params: &SettleDarkPoolTradeParams,
) -> Result<()> {
    msg!("Settling darkpool trade");

    // Verify the trade data signature
    verify_darkpool_signature(&params.trade_data)?;

    // Verify trade parameters
    require!(
        params.trade_data.size_usd > 0,
        PerpetualsError::InvalidPositionSize
    );
    require!(
        params.trade_data.price > 0,
        PerpetualsError::InvalidPrice
    );
    require!(
        params.trade_data.side_a != params.trade_data.side_b,
        PerpetualsError::InvalidTradeSides
    );

    // Get current oracle prices
    let custody_oracle_price = OraclePrice::new_from_oracle(
        &ctx.accounts.custody.oracle,
        &ctx.accounts.custody_oracle_account,
        false,
    )?;

    let collateral_oracle_price = OraclePrice::new_from_oracle(
        &ctx.accounts.collateral_custody.oracle,
        &ctx.accounts.collateral_custody_oracle_account,
        false,
    )?;

    // Verify price is within acceptable slippage
    let max_slippage = params.max_price_slippage as u64;
    let price_diff = if custody_oracle_price.price > params.trade_data.price {
        custody_oracle_price.price - params.trade_data.price
    } else {
        params.trade_data.price - custody_oracle_price.price
    };
    
    let slippage_bps = (price_diff * 10000) / custody_oracle_price.price;
    require!(
        slippage_bps <= max_slippage,
        PerpetualsError::PriceSlippageTooHigh
    );

    // Process position updates for both traders
    settle_trader_position(
        &params.trade_data,
        &mut ctx.accounts.position_a,
        &mut ctx.accounts.funding_account_a,
        &mut ctx.accounts.collateral_custody_token_account,
        params.collateral_amount_a,
        params.trade_data.side_a,
        &ctx.accounts.pool,
        &ctx.accounts.custody,
        &ctx.accounts.collateral_custody,
        &custody_oracle_price,
        &collateral_oracle_price,
        &ctx.accounts.transfer_authority,
        &ctx.accounts.token_program,
    )?;

    settle_trader_position(
        &params.trade_data,
        &mut ctx.accounts.position_b,
        &mut ctx.accounts.funding_account_b,
        &mut ctx.accounts.collateral_custody_token_account,
        params.collateral_amount_b,
        params.trade_data.side_b,
        &ctx.accounts.pool,
        &ctx.accounts.custody,
        &ctx.accounts.collateral_custody,
        &custody_oracle_price,
        &collateral_oracle_price,
        &ctx.accounts.transfer_authority,
        &ctx.accounts.token_program,
    )?;

    // Update pool and custody statistics
    ctx.accounts.custody.trade_stats.volume_usd += params.trade_data.size_usd;

    emit!(DarkPoolTradeSettled {
        trader_a: params.trade_data.trader_a,
        trader_b: params.trade_data.trader_b,
        size_usd: params.trade_data.size_usd,
        price: params.trade_data.price,
        pool: params.trade_data.pool,
        custody: params.trade_data.custody,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("Darkpool trade settled successfully");
    Ok(())
}

fn settle_trader_position(
    trade_data: &DarkPoolTradeData,
    position: &mut Account<Position>,
    funding_account: &mut Account<TokenAccount>,
    custody_token_account: &mut Account<TokenAccount>,
    collateral_amount: u64,
    side: Side,
    pool: &Account<Pool>,
    custody: &Account<Custody>,
    collateral_custody: &Account<Custody>,
    custody_oracle_price: &OraclePrice,
    collateral_oracle_price: &OraclePrice,
    transfer_authority: &AccountInfo,
    token_program: &Program<Token>,
) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;

    // Update position if it exists, or initialize if new
    if position.size_usd == 0 {
        // New position
        position.owner = trade_data.trader_a;
        position.pool = pool.key();
        position.custody = custody.key();
        position.collateral_custody = collateral_custody.key();
        position.open_time = current_time;
        position.side = side;
        position.price = trade_data.price;
        position.size_usd = trade_data.size_usd;
        position.collateral_amount = collateral_amount;
        position.collateral_usd = pool.get_usd_amount(
            collateral_amount,
            collateral_oracle_price,
            collateral_custody,
        )?;
    } else {
        // Update existing position
        let new_total_size = position.size_usd + trade_data.size_usd;
        let weighted_price = ((position.price as u128 * position.size_usd as u128) + 
                             (trade_data.price as u128 * trade_data.size_usd as u128)) / 
                             new_total_size as u128;
        
        position.size_usd = new_total_size;
        position.price = weighted_price as u64;
        position.collateral_amount += collateral_amount;
        position.collateral_usd += pool.get_usd_amount(
            collateral_amount,
            collateral_oracle_price,
            collateral_custody,
        )?;
    }

    position.update_time = current_time;

    // Transfer collateral from trader to custody
    if collateral_amount > 0 {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: funding_account.to_account_info(),
                    to: custody_token_account.to_account_info(),
                    authority: transfer_authority.to_account_info(),
                },
                &[&[
                    b"transfer_authority",
                    &[ctx.bumps.transfer_authority],
                ]],
            ),
            collateral_amount,
        )?;
    }

    Ok(())
}

fn verify_darkpool_signature(trade_data: &DarkPoolTradeData) -> Result<()> {
    // Implement signature verification logic here
    // This would typically involve:
    // 1. Reconstructing the message from trade_data
    // 2. Verifying the signature against the darkpool program's expected signer
    // 3. Checking timestamp validity to prevent replay attacks
    
    // For now, we'll do basic validation
    require!(
        trade_data.darkpool_signature != [0u8; 64],
        PerpetualsError::InvalidSignature
    );
    
    // Check timestamp is recent (within 5 minutes)
    let current_time = Clock::get()?.unix_timestamp;
    require!(
        current_time - trade_data.timestamp < 300,
        PerpetualsError::TradeDataTooOld
    );

    Ok(())
}

// ===== Batch Settlement for Multiple Trades =====

#[derive(Accounts)]
#[instruction(params: BatchSettleDarkPoolTradesParams)]
pub struct BatchSettleDarkPoolTrades<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"perpetuals"],
        bump = perpetuals.perpetuals_bump
    )]
    pub perpetuals: Box<Account<'info, Perpetuals>>,

    // Additional accounts would be determined dynamically based on trades
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct BatchSettleDarkPoolTradesParams {
    pub trades: Vec<DarkPoolTradeData>,
    pub expected_darkpool_program: Pubkey,
}

pub fn batch_settle_dark_pool_trades(
    ctx: Context<BatchSettleDarkPoolTrades>,
    params: &BatchSettleDarkPoolTradesParams,
) -> Result<()> {
    msg!("Batch settling {} darkpool trades", params.trades.len());

    // Process each trade
    for trade in &params.trades {
        // Verify signature for each trade
        verify_darkpool_signature(trade)?;

        // Emit event for each trade (actual settlement would require remaining accounts)
        emit!(DarkPoolTradeQueued {
            trader_a: trade.trader_a,
            trader_b: trade.trader_b,
            size_usd: trade.size_usd,
            price: trade.price,
            timestamp: trade.timestamp,
        });
    }

    msg!("Batch settlement queued successfully");
    Ok(())
}

// ===== Events =====

#[event]
pub struct DarkPoolTradeSettled {
    pub trader_a: Pubkey,
    pub trader_b: Pubkey,
    pub size_usd: u64,
    pub price: u64,
    pub pool: Pubkey,
    pub custody: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DarkPoolTradeQueued {
    pub trader_a: Pubkey,
    pub trader_b: Pubkey,
    pub size_usd: u64,
    pub price: u64,
    pub timestamp: i64,
}

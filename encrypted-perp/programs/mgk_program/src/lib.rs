use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

pub mod darkpool;

use darkpool::*;

const COMP_DEF_OFFSET_ADD_TOGETHER: u32 = comp_def_offset("add_together");

declare_id!("BbtSLsMv22PMhdoSiUqm9Ee9VzVL8zsaDLFkGQKrdKL");

#[arcium_program]
pub mod mgk_program {
    use super::*;
    use darkpool::*;

    // ===== Original Add Together Functions =====
    
    pub fn init_add_together_comp_def(ctx: Context<InitAddTogetherCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    pub fn add_together(
        ctx: Context<AddTogether>,
        computation_offset: u64,
        ciphertext_0: [u8; 32],
        ciphertext_1: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
            Argument::EncryptedU8(ciphertext_0),
            Argument::EncryptedU8(ciphertext_1),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![], None)?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "add_together")]
    pub fn add_together_callback(
        ctx: Context<AddTogetherCallback>,
        output: ComputationOutputs<AddTogetherOutput>,
    ) -> Result<()> {
        let o = match output {
            ComputationOutputs::Success(AddTogetherOutput { field_0: o }) => o,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(SumEvent {
            sum: o.ciphertexts[0],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }

    // ===== Darkpool Functions =====
    
    pub fn initialize_darkpool(
        ctx: Context<InitializeDarkpool>,
        params: InitializeDarkpoolParams,
    ) -> Result<()> {
        darkpool::initialize_darkpool(ctx, params)
    }

    pub fn init_submit_dark_order_comp_def(
        ctx: Context<InitSubmitDarkOrderCompDef>
    ) -> Result<()> {
        darkpool::init_submit_dark_order_comp_def(ctx)
    }

    pub fn init_match_dark_orders_comp_def(
        ctx: Context<InitMatchDarkOrdersCompDef>
    ) -> Result<()> {
        darkpool::init_match_dark_orders_comp_def(ctx)
    }

    pub fn init_batch_process_orders_comp_def(
        ctx: Context<InitBatchProcessOrdersCompDef>
    ) -> Result<()> {
        darkpool::init_batch_process_orders_comp_def(ctx)
    }

    pub fn submit_dark_order(
        ctx: Context<SubmitDarkOrder>,
        computation_offset: u64,
        encrypted_order: [u8; 256],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        darkpool::submit_dark_order(ctx, computation_offset, encrypted_order, pub_key, nonce)
    }

    #[arcium_callback(encrypted_ix = "submit_dark_order")]
    pub fn submit_dark_order_callback(
        ctx: Context<SubmitDarkOrderCallback>,
        output: ComputationOutputs<SubmitDarkOrderOutput>,
    ) -> Result<()> {
        darkpool::submit_dark_order_callback(ctx, output)
    }

    pub fn match_dark_orders(
        ctx: Context<MatchDarkOrders>,
        computation_offset: u64,
        encrypted_orders: Vec<u8>,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        darkpool::match_dark_orders(ctx, computation_offset, encrypted_orders, pub_key, nonce)
    }

    #[arcium_callback(encrypted_ix = "match_dark_orders")]
    pub fn match_dark_orders_callback(
        ctx: Context<MatchDarkOrdersCallback>,
        output: ComputationOutputs<MatchDarkOrdersOutput>,
    ) -> Result<()> {
        darkpool::match_dark_orders_callback(ctx, output)
    }

    pub fn settle_dark_pool_trades(
        ctx: Context<SettleDarkPoolTrades>,
        settlement_data: SettlementData,
    ) -> Result<()> {
        darkpool::settle_dark_pool_trades(ctx, settlement_data)
    }
}

#[queue_computation_accounts("add_together", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct AddTogether<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_TOGETHER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("add_together", payer)]
#[derive(Accounts)]
pub struct AddTogetherCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_TOGETHER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("add_together", payer)]
#[derive(Accounts)]
pub struct InitAddTogetherCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct SumEvent {
    pub sum: [u8; 32],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}

//! Oracle program entrypoint

use pinocchio::{
    account_info::AccountInfo, entrypoint, msg, program_error::ProgramError, pubkey::Pubkey,
    ProgramResult,
};

use crate::instructions;

#[cfg(all(target_os = "solana", not(test)))]
entrypoint!(process_instruction);

/// Oracle instruction discriminators
#[derive(Debug)]
enum OracleInstruction {
    /// Initialize a new price oracle
    Initialize,

    /// Update the oracle price
    UpdatePrice,

    /// Set the oracle authority
    SetAuthority,

    /// Activate the oracle
    Activate,

    /// Deactivate the oracle
    Deactivate,
}

/// Process oracle instruction
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        msg!("Error: Instruction data is empty");
        return Err(ProgramError::InvalidInstructionData);
    }

    let discriminator = instruction_data[0];
    let instruction = match discriminator {
        0 => OracleInstruction::Initialize,
        1 => OracleInstruction::UpdatePrice,
        2 => OracleInstruction::SetAuthority,
        3 => OracleInstruction::Activate,
        4 => OracleInstruction::Deactivate,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(ProgramError::InvalidInstructionData);
        }
    };

    match instruction {
        OracleInstruction::Initialize => {
            msg!("Instruction: Initialize");
            instructions::process_initialize(program_id, accounts, &instruction_data[1..])
        }
        OracleInstruction::UpdatePrice => {
            msg!("Instruction: UpdatePrice");
            instructions::process_update_price(program_id, accounts, &instruction_data[1..])
        }
        OracleInstruction::SetAuthority => {
            msg!("Instruction: SetAuthority");
            instructions::process_set_authority(program_id, accounts, &instruction_data[1..])
        }
        OracleInstruction::Activate => {
            msg!("Instruction: Activate");
            instructions::process_activate(program_id, accounts, &instruction_data[1..])
        }
        OracleInstruction::Deactivate => {
            msg!("Instruction: Deactivate");
            instructions::process_deactivate(program_id, accounts, &instruction_data[1..])
        }
    }
}

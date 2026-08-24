use pinocchio::{
    account_info::AccountInfo, entrypoint, msg, program_error::ProgramError, pubkey::Pubkey,
    ProgramResult,
};

use crate::instructions;

#[cfg(all(target_os = "solana", not(test)))]
entrypoint!(process_instruction);

enum MatcherInstruction {
    ComputeClearing,
    CancelResting,
    ModifyResting,
    ClearAndMatch,
    CancelAll,
    /// Dual Flow Batch Auction clear (disc 5).
    DfbaClear,
    /// Place a resting order with DFBA role flag (disc 6).
    PlaceResting,
    /// Create book PDA for an instrument (disc 7).
    InitializeBook,
}

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
        0 => MatcherInstruction::ComputeClearing,
        1 => MatcherInstruction::CancelResting,
        2 => MatcherInstruction::ModifyResting,
        3 => MatcherInstruction::ClearAndMatch,
        4 => MatcherInstruction::CancelAll,
        5 => MatcherInstruction::DfbaClear,
        6 => MatcherInstruction::PlaceResting,
        7 => MatcherInstruction::InitializeBook,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(ProgramError::InvalidInstructionData);
        }
    };

    match instruction {
        MatcherInstruction::ComputeClearing => {
            msg!("Instruction: ComputeClearing");
            instructions::process_compute_clearing(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::CancelResting => {
            msg!("Instruction: CancelResting");
            instructions::process_cancel_resting(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::ModifyResting => {
            msg!("Instruction: ModifyResting");
            instructions::process_modify_resting(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::ClearAndMatch => {
            msg!("Instruction: ClearAndMatch");
            instructions::process_clear_and_match(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::CancelAll => {
            msg!("Instruction: CancelAll");
            instructions::process_cancel_all(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::DfbaClear => {
            msg!("Instruction: DfbaClear");
            instructions::process_dfba_clear(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::PlaceResting => {
            msg!("Instruction: PlaceResting");
            instructions::process_place_resting(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::InitializeBook => {
            msg!("Instruction: InitializeBook");
            instructions::process_initialize_book(program_id, accounts, &instruction_data[1..])
        }
    }
}

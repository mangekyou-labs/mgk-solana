#![cfg_attr(target_os = "solana", no_std)]

pub mod entrypoint;
pub mod instructions;
pub mod pda;
pub mod state;

/// System program ID (111...111)
pub const SYSTEM_PROGRAM_KEY: [u8; 32] = [0u8; 32];

#[cfg(all(target_os = "solana", not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

pub use state::*;

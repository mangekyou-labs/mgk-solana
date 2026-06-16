#![cfg_attr(target_os = "solana", no_std)]

pub mod entrypoint;
pub mod instructions;
pub mod state;

#[cfg(all(target_os = "solana", not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

pub use state::*;

//! Program ID getters for all Percolator programs.
//!
//! Returns canonical program addresses for CPI callers.
//! Placeholder keypairs below — replace with real ed25519 pubkeys after deployment.
//! Base58 addresses for reference:
//!   Router:  RoutR1VdCpHqj89WEMJhb6TkGT9cPfr1rVjhM3e2YQr
//!   Slab:    8HkaHrEmhP7R9UCUhHPibQTCjBFPgNVb4HEuvPzN28ox
//!   AMM:     AMM111111111111111111111111111111111111111
//!   Oracle:  orac11111111111111111111111111111111111111
//!   Matcher: PERPMatcher111111111111111111111111111
//!   Core:    PRPSCore11111111111111111111111111111111

use pinocchio::pubkey::Pubkey;

#[inline]
pub fn router_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

#[inline]
pub fn slab_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

#[inline]
pub fn amm_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

#[inline]
pub fn oracle_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

#[inline]
pub fn perps_matcher_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

#[inline]
pub fn perps_core_program_id() -> Pubkey {
    Pubkey::from([0u8; 32])
}

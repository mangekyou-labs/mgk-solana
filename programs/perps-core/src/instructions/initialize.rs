use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

/// System Program ID (all zeros).
const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [0u8; 32];

/// Registry account size (size_of::<Registry>() = 86 on BPF).
const REGISTRY_SPACE: usize = 86;
/// Instrument account size (size_of::<Instrument>() = 336 on BPF).
const INSTRUMENT_SPACE: usize = 336;
/// Vault account size — must match `size_of::<Vault>()` = 80 (pinned by vault tests).
/// Was incorrectly 58, which under-allocated the PDA and left vault unusable.
const VAULT_SPACE: usize = 80;

/// Build a SystemProgram::CreateAccount instruction (52 bytes).
fn build_create_account_ix<'a>(
    payer: &'a Pubkey,
    new_account: &'a Pubkey,
    lamports: u64,
    space: usize,
    owner: &'a Pubkey,
) -> ([u8; 52], [AccountMeta<'a>; 2]) {
    let mut data = [0u8; 52];
    data[0..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(space as u64).to_le_bytes());
    data[20..52].copy_from_slice(owner.as_ref());
    let metas = [
        AccountMeta::writable_signer(payer),
        AccountMeta::writable_signer(new_account),
    ];
    (data, metas)
}

#[allow(clippy::too_many_arguments)]
pub fn process_initialize(
    program_id: &Pubkey,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    governance: &Pubkey,
    instrument_count: u16,
    volatility_multiplier: u16,
    base_deposit: u64,
    n_min: u32,
    t_min_slots: u64,
    t_max_slots: u64,
    t_reveal_slots: u64,
    registry_bump: u8,
    instrument_account: &AccountInfo,
    instrument_id: u16,
    tick_size: u64,
    lot_size: u64,
    imr_bps: u16,
    mmr_bps: u16,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
    oracle_addr: Pubkey,
    instrument_bump: u8,
    _system_program: &AccountInfo,
    vault_account: &AccountInfo,
    vault_bump: u8,
) -> ProgramResult {
    msg!("INIT_RUST_V3");

    // ── Create registry PDA if needed ────────────────────────────────────────
    if registry_account.data_len() < REGISTRY_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(REGISTRY_SPACE);
        let (reg_pda, _) = find_program_address(&[b"registry"], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &reg_pda,
            lamports,
            REGISTRY_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [registry_bump];
        let signer_seeds = pinocchio::seeds!(b"registry", &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, registry_account], &[signer])?;
        msg!("Registry PDA created");
    }

    // ── Create instrument PDA if needed ──────────────────────────────────────
    if instrument_account.data_len() < INSTRUMENT_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(INSTRUMENT_SPACE);
        let id_le = instrument_id.to_le_bytes();
        let (inst_pda, _) = find_program_address(&[b"instrument", &id_le], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &inst_pda,
            lamports,
            INSTRUMENT_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [instrument_bump];
        let signer_seeds = pinocchio::seeds!(b"instrument", id_le.as_slice(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, instrument_account], &[signer])?;
        msg!("Instrument PDA created");
    }

    // ── Create vault PDA if needed ──────────────────────────────────────────
    if vault_account.data_len() < VAULT_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(VAULT_SPACE);
        let (vault_pda, _) = find_program_address(&[b"vault"], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &vault_pda,
            lamports,
            VAULT_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [vault_bump];
        let signer_seeds = pinocchio::seeds!(b"vault", &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, vault_account], &[signer])?;
        msg!("Vault PDA created");
    }

    // Zero-init vault fields (createAccount zeros data; set bump explicitly).
    if vault_account.data_len() >= VAULT_SPACE {
        unsafe {
            let dst = vault_account.borrow_mut_data_unchecked().as_ptr() as *mut u8;
            // balance @ 0 (u64) — leave 0
            // insurance_fund @ 16 (u128) — leave 0 (note: host has 8-byte pad after balance)
            // bump @ 65
            *dst.add(65) = vault_bump;
        }
        msg!("Vault state initialized");
    }

    // ── Initialize Registry state ───────────────────────────────────────────
    // Write fields directly using byte offsets — bypasses struct layout entirely
    unsafe {
        let dst = registry_account.borrow_mut_data_unchecked().as_ptr() as *mut u8;
        // governance @ 0 (32 bytes)
        *(dst as *mut [u8; 32]) = *governance;
        // instrument_count @ 32 (2 bytes)
        *(dst.add(32) as *mut u16) = instrument_count;
        // volatility_multiplier @ 34 (2 bytes)
        *(dst.add(34) as *mut u16) = volatility_multiplier;
        // batch_id_counter @ 36 (8 bytes)
        *(dst.add(36) as *mut u64) = 0u64;
        // base_deposit @ 44 (8 bytes)
        *(dst.add(44) as *mut u64) = base_deposit;
        // n_min @ 52 (4 bytes)
        *(dst.add(52) as *mut u32) = n_min;
        // t_min_slots @ 56 (8 bytes)
        *(dst.add(56) as *mut u64) = t_min_slots;
        // t_max_slots @ 64 (8 bytes)
        *(dst.add(64) as *mut u64) = t_max_slots;
        // t_reveal_slots @ 72 (8 bytes)
        *(dst.add(72) as *mut u64) = t_reveal_slots;
        // bump @ 80 (1 byte)
        *dst.add(80) = registry_bump;
        // pause_flags @ 81 (1 byte)
        *dst.add(81) = 0u8;
        // padding @ 82..86 (4 bytes) — already zero from createAccount
    }
    msg!("INIT_DONE_214");
    msg!("Registry initialized");

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize Instrument state — direct byte-offset writes to avoid SBF
    // compiler bug with struct field assignment (same root cause as registry
    // and batch init bugs).
    //
    // Instrument `#[repr(C)]` offsets (pinned by `print_instrument_offsets` host test):
    //   @0 id, @2 symbol[16], @24 contract, @32 tick, @40 lot,
    //   @48 imr, @50 mmr, @52 taker_fee, @54 maker_fee, @56 max_lev, @58 pad2,
    //   @60 oracle[32], @92 cum_funding i128, @108 last_funding, @116 interval,
    //   @124 is_active, @125 bump, @126 pad6+align, @136 mark_price, @144 ref_qty,
    //   @152 decay, @160 interest, @168 deviation, @176 funding_cap, @184 sample_qty,
    //   @192 sma_window, @193 sample_count, @200 premium_samples[16]
    let mut sym = [0u8; 16];
    sym[0] = b'S';
    sym[1] = b'O';
    sym[2] = b'L';
    sym[3] = b'P';
    let dst = unsafe { instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };
    unsafe {
        *(dst as *mut u16) = instrument_id;
        dst.add(2).copy_from_nonoverlapping(sym.as_ptr(), 16);
        *(dst.add(24) as *mut u64) = 1u64; // contract_size
        *(dst.add(32) as *mut u64) = tick_size;
        *(dst.add(40) as *mut u64) = lot_size;
        *(dst.add(48) as *mut u16) = imr_bps;
        *(dst.add(50) as *mut u16) = mmr_bps;
        *(dst.add(52) as *mut u16) = taker_fee_bps;
        *(dst.add(54) as *mut i16) = maker_fee_bps;
        *(dst.add(56) as *mut u16) = 10u16; // max_leverage
        dst.add(60)
            .copy_from_nonoverlapping(oracle_addr.as_ref().as_ptr(), 32);
        *(dst.add(108) as *mut u64) = 0; // last_funding_slot
        *(dst.add(116) as *mut u64) = 100u64; // funding_interval_slots
        *dst.add(124) = 1; // is_active
        *dst.add(125) = instrument_bump;
        *(dst.add(136) as *mut i64) = 0; // mark_price
        *(dst.add(144) as *mut u64) = 1_000u64; // mark_reference_qty
        *(dst.add(152) as *mut u64) = 150u64; // mark_decay_window_slots
        *(dst.add(160) as *mut i64) = 10_000; // funding_coefficient_bps (D7: 10_000 = 1×)
        *(dst.add(168) as *mut i64) = 0; // _reserved_deviation_cap (D7: unused)
        *(dst.add(176) as *mut i64) = 50; // max_funding_rate_bps (D7: 50 bps cap)
        *(dst.add(184) as *mut u64) = 0u64; // _reserved_sample_qty (D7: unused)
        *dst.add(192) = 0; // _reserved_sma_window (D7: unused)
    }
    msg!("Default instrument initialized");

    Ok(())
}

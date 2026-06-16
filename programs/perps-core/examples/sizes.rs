use mgk_perps_core::state::{Registry, Instrument};

fn main() {
    let r = std::mem::size_of::<Registry>();
    let i = std::mem::size_of::<Instrument>();
    println!("Registry:   size={} align={}", r, std::mem::align_of::<Registry>());
    println!("Instrument: size={} align={}", i, std::mem::align_of::<Instrument>());

    // Sentinel-based offset detection: write distinct values to each field,
    // then scan the byte view to find where each sentinel landed.
    macro_rules! scan {
        ($label:expr, $bytes:expr, $pairs:expr) => {{
            println!("{} field offsets (scan):", $label);
            for (idx, chunk) in $bytes.chunks(8).enumerate() {
                let hex: String = chunk.iter().map(|b| format!("{:02x}", b)).collect();
                let mut markers = vec![];
                for (name, bytes_to_find) in &$pairs {
                    let n = bytes_to_find.len();
                    if n > 0 && chunk.windows(n).any(|w| w == bytes_to_find.as_slice()) {
                        markers.push(*name);
                    }
                }
                println!("  [{:3}] {} {}", idx * 8, hex, markers.join(" "));
            }
        }};
    }

    // Instrument: tag every field with a unique 8-byte sentinel.
    let mut inst: Instrument = unsafe { std::mem::zeroed() };
    inst.instrument_id = 0x1111;
    // base_symbol is [u8;16]; use first 2 bytes
    inst.base_symbol[0] = 0x12; inst.base_symbol[1] = 0x12;
    inst.contract_size = 0x1313131313131313;
    inst.tick_size = 0x1414141414141414;
    inst.lot_size = 0x1515151515151515;
    inst.imr_bps = 0x1616;
    inst.mmr_bps = 0x1717;
    inst.taker_fee_bps = 0x1818;
    inst.maker_fee_bps = 0x1919;
    inst.max_leverage = 0x1A1A;
    inst._pad_ml[0] = 0x1B; inst._pad_ml[1] = 0x1B;
    // oracle is Pubkey; mark first 4 bytes
    inst.oracle_addr.as_mut()[0] = 0x1C; inst.oracle_addr.as_mut()[1] = 0x1C;
    inst.oracle_addr.as_mut()[2] = 0x1C; inst.oracle_addr.as_mut()[3] = 0x1C;
    inst.cum_funding = 0x1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D;
    inst.last_funding_ts = 0x1E1E1E1E1E1E1E1E;
    inst.funding_interval_slots = 0x1F1F1F1F1F1F1F1F;
    inst.is_active = true;
    inst.bump = 0xAA;
    inst._padding[0] = 0xBB; inst._padding[1] = 0xBB; inst._padding[2] = 0xBB;
    let ibytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            &inst as *const Instrument as *const u8,
            i,
        )
    };
    let pairs = vec![
        ("id",        vec![0x11, 0x11]),
        ("sym",       vec![0x12, 0x12]),
        ("contract",  vec![0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13, 0x13]),
        ("tick",      vec![0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14]),
        ("lot",       vec![0x15, 0x15, 0x15, 0x15, 0x15, 0x15, 0x15, 0x15]),
        ("imr",       vec![0x16, 0x16]),
        ("mmr",       vec![0x17, 0x17]),
        ("taker",     vec![0x18, 0x18]),
        ("maker",     vec![0x19, 0x19]),
        ("max_lev",   vec![0x1A, 0x1A]),
        ("_pad_ml",   vec![0x1B, 0x1B]),
        ("oracle",    vec![0x1C, 0x1C, 0x1C, 0x1C]),
        ("cum_fund",  vec![0x1D, 0x1D]),
        ("last_fund", vec![0x1E, 0x1E]),
        ("fund_int",  vec![0x1F, 0x1F]),
    ];
    scan!("Instrument", ibytes, pairs);
}



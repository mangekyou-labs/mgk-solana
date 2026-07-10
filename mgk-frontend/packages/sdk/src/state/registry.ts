import { PublicKey } from '@solana/web3.js';
import { REGISTRY_SIZE, type RegistryState } from './types.js';

// On-chain struct layout (#[repr(C)], verified against Rust size_of):
//   0..32   governance: Pubkey
//   32..34  instrument_count: u16
//   34..36  volatility_multiplier: u16
//   36..44  batch_id_counter: u64
//   44..52  base_deposit: u64
//   52..56  n_min: u32
//   56..64  t_min_slots: u64
//   64..72  t_max_slots: u64
//   72..80  t_reveal_slots: u64
//   80..81  bump: u8
//   81..82  pause_flags: u8
//   82..86  _padding: [u8; 4]
// Total: 86 bytes
const GOVERNANCE_OFFSET = 0;
const BATCH_ID_COUNTER_OFFSET = 36;
const N_MIN_OFFSET = 52;
const BASE_DEPOSIT_OFFSET = 44;
const T_MIN_SLOTS_OFFSET = 56;
const BUMP_OFFSET = 80;
const PAUSE_FLAGS_OFFSET = 81;

export function decodeRegistry(data: Uint8Array | Buffer): RegistryState {
  if (data.length < REGISTRY_SIZE) {
    throw new Error(
      `decodeRegistry: buffer too small (${data.length} < ${REGISTRY_SIZE})`,
    );
  }
  // Buffer's internal byteOffset into its backing ArrayBuffer must be
  // included — new Uint8Array(buffer) loses this, so we pass data directly.
  const byteOffset = 'byteOffset' in data ? data.byteOffset : 0;
  const view = new DataView(data.buffer, byteOffset, REGISTRY_SIZE);
  const governanceBytes = new Uint8Array(
    data.buffer,
    byteOffset + GOVERNANCE_OFFSET,
    32,
  );

  return {
    governance: new PublicKey(governanceBytes),
    instrumentCount: view.getUint16(32, true),
    volatilityMultiplier: view.getUint16(34, true),
    batchIdCounter: view.getBigUint64(BATCH_ID_COUNTER_OFFSET, true),
    baseDeposit: view.getBigUint64(BASE_DEPOSIT_OFFSET, true),
    nMin: view.getUint32(N_MIN_OFFSET, true),
    tMinSlots: view.getBigUint64(T_MIN_SLOTS_OFFSET, true),
    tMaxSlots: view.getBigUint64(64, true),
    tRevealSlots: view.getBigUint64(72, true),
    bump: view.getUint8(BUMP_OFFSET),
    pauseFlags: view.getUint8(PAUSE_FLAGS_OFFSET),
  };
}

import { PublicKey } from '@solana/web3.js';
import { REGISTRY_SIZE, type RegistryState } from './types.js';

// BPF layout (see programs/perps-core/src/state/registry.rs):
//   0..32   governance: Pubkey
//   32..34  instrument_count: u16
//   34..36  volatility_multiplier: u16
//   36..40  (4 bytes padding to align batch_id_counter to 8)
//   40..48  batch_id_counter: u64
//   48..56  base_deposit: u64
//   56..60  n_min: u32
//   60..64  (4 bytes padding to align t_min_slots to 8)
//   64..72  t_min_slots: u64
//   72..80  t_max_slots: u64
//   80..88  t_reveal_slots: u64
//   88..89  bump: u8
//   89..94  _padding: [u8; 5]
//   94..96  (2 bytes trailing padding to align struct to 8)
// Total: 96 bytes (struct alignment = 8)
const GOVERNANCE_OFFSET = 0;
const BATCH_ID_COUNTER_OFFSET = 40;
const BASE_DEPOSIT_OFFSET = 48;
const T_MIN_SLOTS_OFFSET = 64;
const BUMP_OFFSET = 88;

export function decodeRegistry(data: Uint8Array): RegistryState {
  if (data.length < REGISTRY_SIZE) {
    throw new Error(
      `decodeRegistry: buffer too small (${data.length} < ${REGISTRY_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, REGISTRY_SIZE);
  const governanceBytes = new Uint8Array(
    data.buffer,
    data.byteOffset + GOVERNANCE_OFFSET,
    32,
  );

  return {
    governance: new PublicKey(governanceBytes),
    instrumentCount: view.getUint16(32, true),
    volatilityMultiplier: view.getUint16(34, true),
    batchIdCounter: view.getBigUint64(BATCH_ID_COUNTER_OFFSET, true),
    baseDeposit: view.getBigUint64(BASE_DEPOSIT_OFFSET, true),
    nMin: view.getUint32(56, true),
    tMinSlots: view.getBigUint64(T_MIN_SLOTS_OFFSET, true),
    tMaxSlots: view.getBigUint64(72, true),
    tRevealSlots: view.getBigUint64(80, true),
    bump: view.getUint8(BUMP_OFFSET),
  };
}

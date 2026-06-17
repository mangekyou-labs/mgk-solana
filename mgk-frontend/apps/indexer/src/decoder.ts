import * as sdk from '@mgk/sdk';
import type { PublicKey } from '@solana/web3.js';

export interface DecodedFill {
  /** The slot this fill was included in */
  slot: number;
  /** The batch ID */
  batchId: bigint;
  /** Instrument ID */
  instrumentId: number;
  /** 0 = taker is buy, 1 = taker is sell */
  takerSide: number;
  /** Fill price (i64, scaled 1e6) */
  price: bigint;
  /** Fill quantity (u64) */
  qty: bigint;
  /** Taker pubkey bytes */
  takerPubkey: Uint8Array;
  /** Maker pubkey bytes */
  makerPubkey: Uint8Array;
  /** Transaction signature */
  txSignature: string;
  /** Whether the fill is from the maker side */
  isMaker: boolean;
}

/** Bytes per fill in the CLOB matching results account */
const BYTES_PER_FILL = 49;

/**
 * Decode fills from a CLOB matching results account written by the
 * matcher's `write_clob_results` function.
 *
 * Layout: num_fills(u16 LE) + fills[N * 49]
 * Each fill: user(32) + filled_qty(u64 LE) + notional(u64 LE) + is_maker(u8)
 *
 * `notional` is the USD value of the fill. We derive `price = notional / qty`.
 * `taker_side` is derived from the instruction context (the clearing batch).
 */
export function decodeFills(
  data: Uint8Array,
  slot: number,
  batchId: bigint,
  instrumentId: number,
  txSignature: string,
  takerSide: number,
): DecodedFill[] {
  if (data.length < 2) return [];

  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const numFills = view.getUint16(0, true);
  const fills: DecodedFill[] = [];

  for (let i = 0; i < numFills; i++) {
    const offset = 2 + i * BYTES_PER_FILL;
    if (data.length < offset + BYTES_PER_FILL) break;

    const user = data.slice(offset, offset + 32);
    const qty = view.getBigUint64(offset + 32, true);
    const notional = view.getBigUint64(offset + 40, true);
    const isMaker = view.getUint8(offset + 48) !== 0;

    if (qty === 0n) continue;

    const price = notional / qty;

    fills.push({
      slot,
      batchId,
      instrumentId,
      takerSide,
      price,
      qty,
      takerPubkey: user,
      makerPubkey: Uint8Array.from(user),
      txSignature,
      isMaker,
    });
  }

  return fills;
}

/**
 * Decode batch events from a BatchState. Emits one event per observed
 * phase transition.
 */
export interface BatchEvent {
  batchId: bigint;
  ts: number;
  phase: number;
  numCommitments: number;
  closeSlot: bigint;
  vwap: bigint;
}

export function decodeBatchEvent(
  batch: sdk.state.BatchState,
): BatchEvent {
  return {
    batchId: batch.batchId,
    ts: Date.now(),
    phase: batch.status,
    numCommitments: batch.totalCommitments + batch.totalRevealed,
    closeSlot: batch.closeSlot,
    vwap: batch.clearingPrice,
  };
}

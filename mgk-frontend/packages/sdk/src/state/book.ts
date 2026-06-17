import {
  BOOK_HEADER_SIZE,
  MAX_LEVELS,
  RESTING_ORDER_SIZE,
  MAX_RESTING_ORDERS,
  RESTING_ORDERS_OFFSET,
  type BookHeader,
  type BookLevel,
  type RestingOrder,
} from './types.js';
import { Side } from '../instruction.js';
import { PublicKey } from '@solana/web3.js';

const BIDS_OFFSET = 48;
const ASKS_OFFSET = BIDS_OFFSET + MAX_LEVELS * 24;

function decodeBookLevel(view: DataView, offset: number): BookLevel {
  return {
    price: view.getBigInt64(offset, true),
    totalQty: view.getBigUint64(offset + 8, true),
    orderCount: view.getUint16(offset + 16, true),
    firstOrderOffset: view.getUint32(offset + 20, true),
  };
}

export function decodeBookHeader(data: Uint8Array): BookHeader {
  if (data.length < BOOK_HEADER_SIZE) {
    throw new Error(
      `decodeBookHeader: buffer too small (${data.length} < ${BOOK_HEADER_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, BOOK_HEADER_SIZE);

  const bids: BookLevel[] = [];
  for (let i = 0; i < MAX_LEVELS; i++) {
    bids.push(decodeBookLevel(view, BIDS_OFFSET + i * 24));
  }
  const asks: BookLevel[] = [];
  for (let i = 0; i < MAX_LEVELS; i++) {
    asks.push(decodeBookLevel(view, ASKS_OFFSET + i * 24));
  }

  return {
    instrumentId: view.getUint16(0, true),
    bestBid: view.getBigInt64(8, true),
    bestAsk: view.getBigInt64(16, true),
    bidCount: view.getUint32(24, true),
    askCount: view.getUint32(28, true),
    nextOrderId: view.getBigUint64(32, true),
    lastUpdateSlot: view.getBigUint64(40, true),
    bids,
    asks,
  };
}

export function decodeRestingOrder(
  data: Uint8Array,
  slotIndex: number,
): RestingOrder {
  const offset =
    RESTING_ORDERS_OFFSET + slotIndex * RESTING_ORDER_SIZE;
  if (data.length < offset + RESTING_ORDER_SIZE) {
    throw new Error(
      `decodeRestingOrder: buffer too small (${data.length} < ${offset + RESTING_ORDER_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset + offset, RESTING_ORDER_SIZE);

  const pubkeyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    pubkeyBytes[i] = view.getUint8(8 + i);
  }

  return {
    orderId: view.getBigUint64(0, true),
    user: new PublicKey(pubkeyBytes),
    side: view.getUint8(40) as Side,
    price: view.getBigInt64(48, true),
    qty: view.getBigUint64(56, true),
    filledQty: view.getBigUint64(64, true),
    instrumentId: view.getUint16(72, true),
    reduceOnly: view.getUint8(74) !== 0,
    batchPlaced: view.getBigUint64(80, true),
    nextOrderOffset: view.getUint32(88, true),
  };
}

export function decodeRestingOrders(
  data: Uint8Array,
): RestingOrder[] {
  const orders: RestingOrder[] = [];
  for (let i = 0; i < MAX_RESTING_ORDERS; i++) {
    const order = decodeRestingOrder(data, i);
    if (order.qty > 0n) {
      orders.push(order);
    }
  }
  return orders;
}

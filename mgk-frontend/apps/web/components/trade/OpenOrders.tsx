'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Transaction, TransactionInstruction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { Pill } from '@/components/common/Pill';

type RestingOrder = sdk.state.RestingOrder;

interface OrderRowProps {
  order: RestingOrder;
  onCancel: (orderId: bigint) => void;
  onModify: (orderId: bigint, newQty: bigint) => void;
}

function formatSide(side: number): { label: string; tone: 'bull' | 'bear' } {
  return side === 0 ? { label: 'Long', tone: 'bull' } : { label: 'Short', tone: 'bear' };
}

export interface OpenOrdersProps {
  instrumentId: number;
  className?: string;
}

const CU_LIMIT = 200_000;

function buildCancelOrModifyIx(
  ixData: Uint8Array,
  publicKey: PublicKey,
  instrumentId: number,
): TransactionInstruction {
  const [portfolioPda] = sdk.derivePortfolioPda(publicKey, config.coreProgramId);
  const [bookPda] = sdk.deriveBookPda(instrumentId, config.matcherProgramId);

  return new TransactionInstruction({
    keys: [
      { pubkey: portfolioPda, isSigner: false, isWritable: true },
      { pubkey: publicKey, isSigner: true, isWritable: true },
      { pubkey: bookPda, isSigner: false, isWritable: true },
      { pubkey: config.matcherProgramId, isSigner: false, isWritable: false },
    ],
    programId: config.coreProgramId,
    data: Buffer.from(ixData),
  });
}

export function OpenOrders({ instrumentId, className }: OpenOrdersProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [orders, setOrders] = useState<RestingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<bigint | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!publicKey) {
      setOrders([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [bookPda] = sdk.deriveBookPda(instrumentId, config.matcherProgramId);
      const accounts = await connection.getMultipleAccountsInfo([bookPda]);
      const acc = accounts[0];
      if (!acc) {
        setOrders([]);
        setLoading(false);
        return;
      }
      const allOrders = sdk.state.decodeRestingOrders(new Uint8Array(acc.data));
      const mine = allOrders.filter(
        (o) => o.user.toBase58() === publicKey.toBase58(),
      );
      setOrders(mine);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection, instrumentId]);

  useEffect(() => {
    const t = setTimeout(() => { void fetchOrders(); }, 0);
    const interval = setInterval(() => { void fetchOrders(); }, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [fetchOrders]);

  const handleCancel = useCallback(
    async (orderId: bigint) => {
      if (!publicKey || !sendTransaction) return;
      setBusyOrderId(orderId);
      try {
        const ixData = sdk.programs.encodeCancelRestingOrder(orderId);
        const ix = buildCancelOrModifyIx(ixData, publicKey, instrumentId);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
          ix,
        );
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');
        await fetchOrders();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyOrderId(null);
      }
    },
    [publicKey, sendTransaction, connection, fetchOrders, instrumentId],
  );

  const handleModify = useCallback(
    async (orderId: bigint, newQty: bigint) => {
      if (!publicKey || !sendTransaction) return;
      if (newQty <= 0n) return;
      setBusyOrderId(orderId);
      try {
        const ixData = sdk.programs.encodeModifyRestingOrder(orderId, newQty);
        const ix = buildCancelOrModifyIx(ixData, publicKey, instrumentId);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
          ix,
        );
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');
        await fetchOrders();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyOrderId(null);
      }
    },
    [publicKey, sendTransaction, connection, fetchOrders, instrumentId],
  );

  const isEmpty = orders.length === 0 && !loading;

  if (isEmpty && !error) {
    return (
      <div
        data-testid="open-orders-empty"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        You have no open orders.
      </div>
    );
  }

  return (
    <div
      data-testid="open-orders"
      className={`flex flex-col ${className ?? ''}`}
    >
      {error && (
        <div
          data-testid="open-orders-error"
          className="text-warn px-3 py-2 text-xs font-mono"
        >
          {error}
        </div>
      )}
      <div className="flex flex-col font-mono text-xs">
        {orders.map((order) => (
          <OrderRow
            key={order.orderId.toString()}
            order={order}
            busy={busyOrderId === order.orderId}
            onCancel={handleCancel}
            onModify={handleModify}
          />
        ))}
      </div>
    </div>
  );
}

function OrderRow({
  order,
  busy,
  onCancel,
  onModify,
}: Omit<OrderRowProps, '_onModify'> & { busy: boolean }) {
  const { label, tone } = formatSide(order.side);
  const remaining = order.qty - order.filledQty;
  const [editing, setEditing] = useState(false);
  const [editQty, setEditQty] = useState('');
  const remainingStr = (Number(remaining) / 1_000_000).toString();

  const handleModifySubmit = () => {
    const parsed = parseFloat(editQty);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const newQty = BigInt(Math.round(parsed * 1_000_000));
    if (newQty === order.qty) {
      setEditing(false);
      return;
    }
    onModify(order.orderId, newQty);
    setEditing(false);
    setEditQty('');
  };

  return (
    <div
      data-testid="open-order-row"
      data-order-id={order.orderId.toString()}
      className="flex items-center gap-2 px-2 py-1 border-b border-border hover:bg-surface-2"
    >
      <Pill tone={tone}>{label}</Pill>
      <span data-testid="open-order-price" className="text-text min-w-[60px] text-right">
        <NumberDisplay value={order.price} kind="scaled-usd" />
      </span>

      {editing ? (
        <div className="flex items-center gap-1 min-w-[60px]">
          <input
            type="text"
            inputMode="decimal"
            data-testid="open-order-modify-input"
            value={editQty}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setEditQty(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleModifySubmit();
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder={remainingStr}
            className="w-full rounded border border-accent/40 bg-surface-2 px-1 py-0.5 text-right text-text text-xs outline-none"
            autoFocus
          />
        </div>
      ) : (
        <span data-testid="open-order-qty" className="text-text min-w-[60px] text-right">
          <NumberDisplay value={remaining} kind="scaled-base" />
        </span>
      )}

      <span className="flex-1" />
      {editing ? (
        <>
          <button
            data-testid="open-order-modify-confirm"
            onClick={handleModifySubmit}
            disabled={busy}
            className="text-accent text-[10px] uppercase tracking-wider hover:underline disabled:opacity-40"
          >
            Confirm
          </button>
          <button
            data-testid="open-order-modify-cancel-edit"
            onClick={() => setEditing(false)}
            className="text-text-muted text-[10px] uppercase tracking-wider hover:underline"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            data-testid="open-order-modify"
            onClick={() => {
              setEditQty('');
              setEditing(true);
            }}
            disabled={busy}
            className="text-text-muted text-[10px] uppercase tracking-wider hover:underline disabled:opacity-40"
          >
            Modify
          </button>
          <button
            data-testid="open-order-cancel"
            onClick={() => onCancel(order.orderId)}
            disabled={busy}
            className="text-bear text-[10px] uppercase tracking-wider hover:underline disabled:opacity-40"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

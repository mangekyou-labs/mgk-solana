'use client';

import { useCallback, useState } from 'react';

import * as sdk from '@mgk/sdk';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { AccountActions } from '@/components/orderform/AccountActions';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { MarginModeTabs, type MarginMode } from './MarginModeTabs';
import { OrderTypeTabs, type OrderMode } from './OrderTypeTabs';
import { RiskPanel } from './RiskPanel';

type PortfolioState = sdk.state.PortfolioState;

const USD_SCALE = 1_000_000;

export type OrderSide = 'buy' | 'sell';

export interface OrderFormParams {
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
}

export interface OrderFormProps {
  bestBid: bigint | null;
  bestAsk: bigint | null;
  onSubmit?: (params: OrderFormParams) => void;
  className?: string;
  /** Portfolio-level risk data (optional — shows "—" when omitted). */
  liqPrice?: bigint | null;
  /** Position notional for leverage calc (scaled 1e6). */
  notional?: bigint;
  /** Free collateral in lamports. */
  freeCollateral?: bigint;
  /** Whether portfolio data is still loading. */
  loading?: boolean;
  /** Whether a tx is in-flight (commit/reveal). */
  submitting?: boolean;
  /** Portfolio state for AccountActions (null when no PDA exists). */
  portfolio?: PortfolioState | null;
  /** Whether portfolio data is loading. */
  portfolioLoading?: boolean;
  /** Called with a success signature from AccountActions. */
  onTxSuccess?: (sig: string) => void;
  /** Called with an error message from AccountActions. */
  onTxError?: (error: string) => void;
}

export function OrderForm({
  bestBid,
  bestAsk,
  onSubmit,
  className,
  liqPrice = null,
  notional = 0n,
  freeCollateral = 0n,
  loading = false,
  submitting = false,
  portfolio = null,
  portfolioLoading = false,
  onTxSuccess,
  onTxError,
}: OrderFormProps) {
  const [marginMode] = useState<MarginMode>('cross');
  const [orderMode] = useState<OrderMode>('limit');
  const [side, setSide] = useState<OrderSide>('buy');
  const [priceInput, setPriceInput] = useState('');
  const [qtyInput, setQtyInput] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const orderStatus = useOrderFormStore((s) => s.status);
  const clearOrder = useOrderFormStore((s) => s.clear);

  const lotSize = 1000000n;

  const defaultPrice = side === 'buy' ? bestBid : bestAsk;

  const price = (() => {
    if (priceInput === '') {
      if (defaultPrice === null) return 0n;
      return defaultPrice;
    }
    const p = Math.round(parseFloat(priceInput) * USD_SCALE);
    if (!Number.isFinite(p) || p < 0) return 0n;
    return BigInt(p);
  })();

  const qty = (() => {
    if (qtyInput === '') return 0n;
    const q = Math.round(parseFloat(qtyInput) * USD_SCALE);
    if (!Number.isFinite(q) || q < 0) return 0n;
    return BigInt(q);
  })();

  const selectSide = useCallback(
    (newSide: OrderSide) => {
      setSide(newSide);
      const nextDefault = newSide === 'buy' ? bestBid : bestAsk;
      if (priceInput === '' && nextDefault !== null) {
        // Keep empty input; the default price will switch via useMemo
      }
    },
    [priceInput, bestBid, bestAsk],
  );

  const handlePriceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (v === '' || /^\d*\.?\d*$/.test(v)) {
        setPriceInput(v);
      }
    },
    [],
  );

  const handleQtyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (v === '' || /^\d*\.?\d*$/.test(v)) {
        setQtyInput(v);
      }
    },
    [],
  );

  const adjustQty = useCallback(
    (pct: number) => {
      const base = qty === 0n ? lotSize : qty;
      let newQty = Number(base * BigInt(Math.round(pct * 100)) / 100n) / USD_SCALE;
      const step = Number(lotSize) / USD_SCALE;
      if (pct < 1 && qty === 0n) {
        newQty = step;
      } else {
        newQty = Math.round(newQty / step) * step;
      }
      setQtyInput(newQty > 0 ? String(newQty) : '');
    },
    [qty, lotSize],
  );

  const handleSubmit = useCallback(() => {
    if (!onSubmit || qty === 0n || price === 0n) return;
    onSubmit({ side, price, qty, reduceOnly });
  }, [onSubmit, side, price, qty, reduceOnly]);

  const orderValue = price * qty / BigInt(USD_SCALE);
  const marginEst = orderValue / 10n;

  return (
    <div
      data-testid="order-form"
      className={`flex flex-col gap-2 font-mono text-xs ${className ?? ''}`}
    >
      <MarginModeTabs mode={marginMode} />
      <OrderTypeTabs mode={orderMode} />
      <SideTabs side={side} onSelect={selectSide} />

      {orderStatus === 'slashed' && (
        <SlashedBanner onDismiss={clearOrder} />
      )}

      <div className="flex flex-col gap-1 text-text-muted text-[10px] uppercase tracking-wider">
        <PriceInput
          value={priceInput}
          side={side}
          defaultPrice={defaultPrice}
          onChange={handlePriceChange}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-text-muted text-[10px] uppercase tracking-wider">
          Size{' '}
          <span className="text-text-faint">Avail 0</span>
        </label>
        <div className="flex items-center gap-2 border border-border rounded bg-surface-2 px-2 py-1">
          <input
            type="text"
            inputMode="decimal"
            data-testid="order-form-qty-input"
            value={qtyInput}
            onChange={handleQtyChange}
            placeholder="0.00"
            className="w-full bg-transparent text-text text-right placeholder:text-text-faint outline-none"
          />
          <span className="text-text-muted text-[10px] uppercase">USD</span>
        </div>
        <div
          data-testid="order-form-qty-slider"
          className="flex gap-1 mt-0.5"
        >
          {[0.2, 0.4, 0.6, 0.8, 1.0].map((pct) => (
            <button
              key={pct}
              type="button"
              data-testid={`qty-slider-${pct * 100}`}
              onClick={() => adjustQty(pct)}
              className="flex-1 h-1 rounded-full bg-border hover:bg-accent/60 transition-colors"
              aria-label={`Set size to ${pct * 100}%`}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Checkbox
          id="reduce-only"
          checked={reduceOnly}
          onChange={setReduceOnly}
          label="Reduce Only"
        />
        <Checkbox
          id="tp-sl"
          checked={false}
          onChange={() => {}}
          label="TP/SL"
          disabled
        />
      </div>

      <BuySellButtons side={side} onSubmit={handleSubmit} submitting={submitting} />

      <SummaryPanel
        orderValue={orderValue}
        marginEst={marginEst}
      />

      <RiskPanel
        liqPrice={liqPrice}
        notional={notional}
        freeCollateral={freeCollateral}
        loading={loading}
      />

      <AccountActions
        portfolio={portfolio}
        portfolioLoading={portfolioLoading}
        onTxSuccess={onTxSuccess}
        onTxError={onTxError}
      />
    </div>
  );
}

function SideTabs({
  side,
  onSelect,
}: {
  side: OrderSide;
  onSelect: (side: OrderSide) => void;
}) {
  return (
    <div data-testid="order-form-side-tabs" className="flex">
      <button
        type="button"
        data-testid="order-form-side-buy"
        data-active={side === 'buy' ? 'true' : 'false'}
        onClick={() => onSelect('buy')}
        className={[
          'flex-1 py-1.5 text-center text-[11px] font-medium uppercase tracking-wider rounded-l border transition-colors',
          side === 'buy'
            ? 'bg-bull text-text border-bull'
            : 'bg-surface-2 text-text-muted border-border hover:text-text',
        ].join(' ')}
      >
        Buy / Long
      </button>
      <button
        type="button"
        data-testid="order-form-side-sell"
        data-active={side === 'sell' ? 'true' : 'false'}
        onClick={() => onSelect('sell')}
        className={[
          'flex-1 py-1.5 text-center text-[11px] font-medium uppercase tracking-wider rounded-r border border-l-0 transition-colors',
          side === 'sell'
            ? 'bg-bear text-text border-bear'
            : 'bg-surface-2 text-text-muted border-border hover:text-text',
        ].join(' ')}
      >
        Sell / Short
      </button>
    </div>
  );
}

function PriceInput({
  value,
  side,
  defaultPrice,
  onChange,
}: {
  value: string;
  side: OrderSide;
  defaultPrice: bigint | null;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const dp = defaultPrice !== null
    ? (Number(defaultPrice) / USD_SCALE).toFixed(2)
    : null;
  const tone = side === 'buy' ? 'bull' : 'bear';

  return (
    <div className="flex flex-col gap-1">
      <label
        data-testid="order-form-price-label"
        className={`text-${tone} uppercase`}
      >
        Price <span className="text-text-faint">USD</span>
      </label>
      <div className="flex items-center gap-2 border border-border rounded bg-surface-2 px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          data-testid="order-form-price-input"
          value={value}
          onChange={onChange}
          placeholder={dp ?? '0.00'}
          className="w-full bg-transparent text-text text-right placeholder:text-text-faint outline-none"
        />
        {value === '' && dp !== null && (
          <span className="text-text-faint text-[10px]">{dp}</span>
        )}
      </div>
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  label,
  disabled = false,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      data-testid={`order-form-checkbox-${id}`}
      className={[
        'flex items-center gap-1.5 text-text-muted text-[10px] uppercase tracking-wider select-none',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <input
        type="checkbox"
        data-testid={`order-form-checkbox-input-${id}`}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-3 w-3 rounded border-border bg-surface-2 accent-accent"
      />
      {label}
    </label>
  );
}

function BuySellButtons({
  side,
  onSubmit,
  submitting = false,
}: {
  side: OrderSide;
  onSubmit: () => void;
  submitting?: boolean;
}) {
  const label = submitting ? 'Submitting…' : side === 'buy' ? 'Buy / Long' : 'Sell / Short';

  return (
    <div data-testid="order-form-submit" className="flex gap-1">
      <button
        type="button"
        data-testid="order-form-submit-buy"
        onClick={side === 'buy' && !submitting ? onSubmit : undefined}
        disabled={submitting}
        className={[
          'flex-1 py-2 text-sm font-semibold uppercase rounded transition-colors',
          submitting
            ? 'bg-surface-2 text-text-muted cursor-not-allowed opacity-60'
            : side === 'buy'
              ? 'bg-bull text-text hover:bg-bull/80'
              : 'bg-surface-2 text-text-muted cursor-not-allowed',
        ].join(' ')}
      >
        {side === 'buy' ? label : 'Buy / Long'}
      </button>
      <button
        type="button"
        data-testid="order-form-submit-sell"
        onClick={side === 'sell' && !submitting ? onSubmit : undefined}
        disabled={submitting}
        className={[
          'flex-1 py-2 text-sm font-semibold uppercase rounded transition-colors',
          submitting
            ? 'bg-surface-2 text-text-muted cursor-not-allowed opacity-60'
            : side === 'sell'
              ? 'bg-bear text-text hover:bg-bear/80'
              : 'bg-surface-2 text-text-muted cursor-not-allowed',
        ].join(' ')}
      >
        {side === 'sell' ? label : 'Sell / Short'}
      </button>
    </div>
  );
}

function SummaryPanel({
  orderValue,
  marginEst,
}: {
  orderValue: bigint;
  marginEst: bigint;
}) {
  return (
    <div
      data-testid="order-form-summary"
      className="flex flex-col gap-0.5 text-text-muted text-[10px] border-t border-border pt-2"
    >
      <SummaryRow label="Current Pos" value="0 SOL" />
      <SummaryRow label="Liq" value="— / —" />
      <SummaryRow
        label="Order Value"
        value={<NumberDisplay value={orderValue} kind="scaled-usd" />}
        prefix="$"
      />
      <SummaryRow
        label="Margin"
        value={
          <>
            <NumberDisplay value={marginEst} kind="scaled-usd" />
            <span className="text-text-faint"> / $0</span>
          </>
        }
        prefix="$"
      />
      <SummaryRow label="Fees" value="— / —" muted />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  muted,
  prefix,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
  prefix?: string;
}) {
  return (
    <div
      className={`flex justify-between ${muted ? 'text-text-faint' : ''}`}
    >
      <span>{label}</span>
      <span>
        {prefix}
        {value}
      </span>
    </div>
  );
}

/**
 * Banner shown when the order form is in `slashed` status — the user's
 * in-flight commit-reveal was either revealed too late (the batch closed)
 * or revealed with a hash mismatch, and the protocol kept the locked
 * deposit. The user must place a new order; clicking "Start fresh" clears
 * the in-memory + localStorage state so the form is usable again.
 */
function SlashedBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      data-testid="order-form-slashed-banner"
      data-slashed="true"
      className="flex flex-col gap-1 rounded border border-bear/60 bg-bear/10 px-2 py-1.5 text-text"
    >
      <div className="flex items-center justify-between">
        <span
          data-testid="order-form-slashed-title"
          className="text-bear text-[11px] font-medium uppercase tracking-wider"
        >
          Order slashed
        </span>
        <button
          type="button"
          data-testid="order-form-slashed-dismiss"
          onClick={onDismiss}
          className="text-text-muted text-[10px] uppercase tracking-wider hover:text-text"
        >
          Start fresh
        </button>
      </div>
      <p
        data-testid="order-form-slashed-message"
        className="text-text-muted text-[10px] leading-snug"
      >
        The reveal deadline passed or the revealed order did not match
        the commitment. Your locked deposit has been kept by the protocol.
        Place a new order in the next batch.
      </p>
    </div>
  );
}

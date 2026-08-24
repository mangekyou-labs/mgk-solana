'use client';

import { useCallback, useState } from 'react';

import * as sdk from '@mgk/sdk';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { AccountActions } from '@/components/orderform/AccountActions';
import { MarginModeTabs, type MarginMode } from './MarginModeTabs';
import { OrderTypeTabs, type OrderMode } from './OrderTypeTabs';
import { RiskPanel } from './RiskPanel';

type PortfolioState = sdk.state.PortfolioState;

const USD_SCALE = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const INITIAL_MARGIN_DIVISOR = 10n;

export type OrderSide = 'buy' | 'sell';

export interface OrderFormParams {
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  /** false = taker (default), true = maker — DFBA dual-auction role */
  isMaker?: boolean;
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
  /** Whether a tx is in-flight (PostOrder). */
  submitting?: boolean;
  /** Portfolio state for AccountActions (null when no PDA exists). */
  portfolio?: PortfolioState | null;
  /** Whether portfolio data is loading. */
  portfolioLoading?: boolean;
  /** Called with a success signature from AccountActions. */
  onTxSuccess?: (sig: string) => void;
  /** Called with an error message from AccountActions. */
  onTxError?: (error: string) => void;
  /** Signed position qty for the selected instrument (scaled 1e6). Defaults to 0n. */
  positionQty?: bigint;
}

/** Parse a decimal string to a bigint scaled by 1e6 (max 6 decimal places).
 *  Returns 0n for empty or invalid input. Truncates extra precision. */
function parseFixed6(input: string): bigint {
  if (input === '' || input === '-') return 0n;
  const neg = input.startsWith('-');
  const s = neg ? input.slice(1) : input;
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracRaw = dot === -1 ? '' : s.slice(dot + 1);
  const frac = fracRaw.slice(0, 6).padEnd(6, '0');
  const combined = (intPart || '0') + frac;
  const abs = BigInt(combined);
  return neg ? -abs : abs;
}

/** Format a bigint scaled by 1e6 to a human-readable decimal string. */
function formatFixed6(value: bigint): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const intPart = abs / 1_000_000n;
  const fracPart = abs % 1_000_000n;
  const fracStr = fracPart.toString().padStart(6, '0').replace(/0+$/, '');
  const prefix = neg ? '-' : '';
  return fracStr ? `${prefix}${intPart}.${fracStr}` : `${prefix}${intPart}`;
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
  positionQty = 0n,
}: OrderFormProps) {
  const [marginMode] = useState<MarginMode>('cross');
  const [orderMode] = useState<OrderMode>('limit');
  const [side, setSide] = useState<OrderSide>('buy');
  const [priceInput, setPriceInput] = useState('');
  const [qtyInput, setQtyInput] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  /** DFBA: default taker; user may designate maker for the dual auction. */
  const [isMaker, setIsMaker] = useState(false);

  const lotSize = 1000000n;

  const bookCrossed = bestBid !== null && bestAsk !== null && bestBid > bestAsk;
  const defaultPrice = bookCrossed ? null : side === 'buy' ? bestBid : bestAsk;

  // T9.10.7: Prepare-close state.
  const hasPosition = positionQty !== 0n;
  const positionSide = positionQty > 0n ? 'long' : positionQty < 0n ? 'short' : 'flat';
  const absPositionQty = positionQty < 0n ? -positionQty : positionQty;
  // The opposing quote for close: long→sell→bestBid; short→buy→bestAsk.
  const closeQuote = positionSide === 'long' ? bestBid : positionSide === 'short' ? bestAsk : null;
  const canPrepareClose = hasPosition && closeQuote !== null && !bookCrossed;

  const price = (() => {
    if (priceInput === '') {
      if (defaultPrice === null) return 0n;
      return defaultPrice;
    }
    return parseFixed6(priceInput);
  })();

  const qty = (() => {
    if (qtyInput === '') return 0n;
    return parseFixed6(qtyInput);
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
    onSubmit({ side, price, qty, reduceOnly, isMaker });
  }, [onSubmit, side, price, qty, reduceOnly, isMaker]);

  const orderValue = price * qty / BigInt(USD_SCALE);
  const marginEst = orderValue / INITIAL_MARGIN_DIVISOR;
  // SOL-PERP v1 uses 1 base unit = 1 SOL and the same 10x initial-margin
  // estimate shown in the summary. Keep the display in base units; the
  // on-chain qty is not a USD amount.
  const availableQty =
    (freeCollateral * INITIAL_MARGIN_DIVISOR * BigInt(USD_SCALE)) /
    LAMPORTS_PER_SOL;
  const availableMarginUsd =
    price > 0n
      ? (freeCollateral * price) / LAMPORTS_PER_SOL
      : 0n;

  return (
    <div
      data-testid="order-form"
      className={`flex flex-col gap-2 font-mono text-xs ${className ?? ''}`}
    >
      <MarginModeTabs mode={marginMode} />
      <OrderTypeTabs mode={orderMode} />
      <SideTabs side={side} onSelect={selectSide} />

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
          <span
            data-testid="order-form-size-available"
            className="text-text-faint"
          >
            Avail <NumberDisplay value={availableQty} kind="scaled-base" decimals={2} /> SOL
          </span>
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
          <span
            data-testid="order-form-size-unit"
            className="text-text-muted text-[10px] uppercase"
          >
            SOL
          </span>
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
          id="post-as-maker"
          checked={isMaker}
          onChange={setIsMaker}
          label="Post as maker"
        />
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

      {hasPosition && (
        <button
          type="button"
          data-testid="order-form-prepare-close"
          disabled={!canPrepareClose || submitting}
          onClick={() => {
            if (!canPrepareClose) return;
            const closeSide: OrderSide = positionSide === 'long' ? 'sell' : 'buy';
            setSide(closeSide);
            setReduceOnly(true);
            setIsMaker(false);
            // Set qty to absolute position quantity (truncated to 6 decimals).
            const qtyDecimal = formatFixed6(absPositionQty);
            setQtyInput(qtyDecimal);
            // Set price to opposing quote.
            if (closeQuote !== null) {
              setPriceInput(formatFixed6(closeQuote));
            }
          }}
          className={[
            'w-full py-1.5 text-[11px] font-medium uppercase rounded border transition-colors',
            !canPrepareClose
              ? 'bg-surface-2 text-text-faint border-border cursor-not-allowed opacity-60'
              : 'bg-accent/20 text-accent border-accent/40 hover:bg-accent/30',
          ].join(' ')}
        >
          {!canPrepareClose
            ? (bookCrossed ? 'Book crossed — close unavailable' : 'No opposing quote for close')
            : positionSide === 'long'
              ? `Close Long (${formatFixed6(absPositionQty)} SOL)`
              : `Close Short (${formatFixed6(absPositionQty)} SOL)`
          }
        </button>
      )}

      <BuySellButtons side={side} onSubmit={handleSubmit} submitting={submitting} />

      <SummaryPanel
        orderValue={orderValue}
        marginEst={marginEst}
        availableMarginUsd={availableMarginUsd}
        positionQty={positionQty}
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
  availableMarginUsd,
  positionQty,
}: {
  orderValue: bigint;
  marginEst: bigint;
  availableMarginUsd: bigint;
  positionQty?: bigint;
}) {
  const posDisplay = positionQty != null && positionQty !== 0n
    ? `${formatFixed6(positionQty)} SOL`
    : '0 SOL';
  return (
    <div
      data-testid="order-form-summary"
      className="flex flex-col gap-0.5 text-text-muted text-[10px] border-t border-border pt-2"
    >
      <SummaryRow label="Current Pos" value={<span data-testid="order-form-position-display">{posDisplay}</span>} />
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
            <span className="text-text-faint"> / </span>
            <span data-testid="order-form-margin-available">
              $
              <NumberDisplay value={availableMarginUsd} kind="scaled-usd" />
            </span>
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

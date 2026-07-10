'use client';

import { useCallback, useState } from 'react';

import * as sdk from '@mgk/sdk';
import { useAccountActions } from '@/lib/hooks/useAccountActions';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';

type PortfolioState = sdk.state.PortfolioState;

export interface AccountActionsProps {
  portfolio: PortfolioState | null;
  portfolioLoading: boolean;
  className?: string;
  /** Called with a success signature. */
  onTxSuccess?: (sig: string) => void;
  /** Called with an error message. */
  onTxError?: (error: string) => void;
}

export function AccountActions({
  portfolio,
  portfolioLoading,
  className,
  onTxSuccess,
  onTxError,
}: AccountActionsProps) {
  const { connected } = useAutoConnect();
  const { initPortfolio, deposit, withdraw, SOL } = useAccountActions();
  const [amountInput, setAmountInput] = useState('');
  const [busy, setBusy] = useState(false);

  const amountLamports = (() => {
    const parsed = parseFloat(amountInput);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    const lamports = BigInt(Math.round(parsed * Number(SOL)));
    return lamports < 0n ? 0n : lamports;
  })();

  const hasPortfolio = portfolio != null;

  const wrap = useCallback(
    async (fn: () => Promise<{ sig: string }>) => {
      setBusy(true);
      try {
        const { sig } = await fn();
        onTxSuccess?.(sig);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onTxError?.(msg);
      } finally {
        setBusy(false);
      }
    },
    [onTxSuccess, onTxError],
  );

  if (!connected) return null;

  return (
    <div
      data-testid="order-form-account-actions"
      className={`flex flex-col border-t border-border pt-2 text-text-muted text-[10px] uppercase tracking-wider ${className ?? ''}`}
    >
      <span className="mb-1 text-text-faint">Account</span>

      {/* Amount input for deposit / withdraw */}
      {hasPortfolio && (
        <div className="flex items-center gap-1 mb-1">
          <input
            type="text"
            inputMode="decimal"
            data-testid="account-actions-amount"
            value={amountInput}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setAmountInput(v);
            }}
            placeholder="0.1"
            disabled={busy}
            className="flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-right text-text placeholder:text-text-faint outline-none disabled:opacity-40"
          />
          <span className="text-text-faint">SOL</span>
        </div>
      )}

      <div className="flex gap-1">
        {!hasPortfolio && !portfolioLoading ? (
          <button
            type="button"
            data-testid="account-actions-init-portfolio"
            onClick={() => wrap(initPortfolio)}
            disabled={busy}
            className="flex-1 py-1 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
                        {busy ? 'Creating…' : 'Set Up Account'}
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="account-actions-deposit"
              onClick={() => amountLamports > 0n && wrap(() => deposit(amountLamports))}
              disabled={busy || amountLamports === 0n}
              className="flex-1 py-1 rounded border border-border bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? '…' : 'Deposit'}
            </button>
            <button
              type="button"
              data-testid="account-actions-withdraw"
              onClick={() => amountLamports > 0n && wrap(() => withdraw(amountLamports))}
              disabled={
                busy ||
                amountLamports === 0n ||
                (portfolio?.freeCollateral ?? 0n) <= 0n
              }
              className="flex-1 py-1 rounded border border-border bg-surface-2 text-text-muted hover:bg-surface-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? '…' : 'Withdraw'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

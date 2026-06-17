'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as sdk from '@mgk/sdk';

export interface TxToastProps {
  signature: string;
  error?: string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

const EXPLORER_BASE = 'https://explorer.solana.com/tx';
const EXPLORER_CLUSTER = 'devnet';
const AUTO_DISMISS_MS = 15_000;

function extractErrorCode(message: string): number | null {
  const m = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (m?.[1]) return parseInt(m[1], 16);
  return null;
}

export function TxToast({
  signature,
  error,
  onRetry,
  onDismiss,
  className,
}: TxToastProps) {
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    if (!error || dismissed) return;
    timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [error, dismissed, dismiss]);

  if (dismissed) return null;

  const code = error ? extractErrorCode(error) : null;
  const humanized = code !== null ? sdk.humanizeError(code) : error;
  const explorerUrl = `${EXPLORER_BASE}/${signature}?cluster=${EXPLORER_CLUSTER}`;
  const shortSig = `${signature.slice(0, 8)}…${signature.slice(-8)}`;

  return (
    <div
      data-testid="tx-toast"
      data-error={error ? 'true' : 'false'}
      className={[
        'fixed bottom-12 right-4 z-[100] flex max-w-sm flex-col gap-2 rounded border bg-surface-2 p-3 shadow-lg text-xs font-mono',
        error ? 'border-bear/60' : 'border-bull/60',
        className ?? '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div
            data-testid="tx-toast-status"
            className={`font-medium uppercase tracking-wider ${error ? 'text-bear' : 'text-bull'}`}
          >
            {error ? 'Transaction Failed' : 'Transaction Confirmed'}
          </div>
          {humanized && (
            <div
              data-testid="tx-toast-error"
              className="text-text-muted break-all"
            >
              {humanized}
            </div>
          )}
          <div className="flex items-center gap-2">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="tx-toast-explorer"
              className="text-accent hover:text-accent/80 underline"
            >
              {shortSig}
            </a>
          </div>
        </div>
        <button
          data-testid="tx-toast-dismiss"
          onClick={dismiss}
          className="text-text-faint hover:text-text shrink-0 leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {error && onRetry && (
        <button
          data-testid="tx-toast-retry"
          onClick={onRetry}
          className="self-start rounded bg-accent/20 text-accent px-3 py-1 text-[10px] uppercase tracking-wider hover:bg-accent/30 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

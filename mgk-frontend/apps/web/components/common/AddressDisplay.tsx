'use client';

import { useState, useCallback } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { truncatePubkey } from '@/lib/pubkey';

export interface AddressDisplayProps {
  /** The public key to display. */
  pubkey: PublicKey | string;
  /** Characters shown at head / tail. Default 4. */
  head?: number;
  tail?: number;
  /** Copy-to-clipboard: when true, clicking copies the full address. */
  copyable?: boolean;
  className?: string;
}

/**
 * Address display with truncated pubkey and optional click-to-copy.
 * Monospace, tabular numbers, muted tone. Uses the shared `truncatePubkey`
 * helper so the format stays consistent with Header/WalletButton.
 */
export function AddressDisplay({
  pubkey,
  head = 4,
  tail = 4,
  copyable = false,
  className,
}: AddressDisplayProps) {
  const [copied, setCopied] = useState(false);
  const full = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  const truncated = truncatePubkey(
    typeof pubkey === 'string' ? { toBase58: () => pubkey as string } : pubkey,
    head,
    tail,
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (non-HTTPS, older browser) — no-op
    }
  }, [full]);

  const inner = (
    <span
      data-testid="address-display-text"
      data-full={full}
      className="font-mono tabular-nums text-text-muted text-xs select-all"
    >
      {truncated}
    </span>
  );

  if (!copyable) {
    return <span className={className}>{inner}</span>;
  }

  return (
    <button
      type="button"
      data-testid="address-display"
      data-copied={copied ? 'true' : 'false'}
      onClick={handleCopy}
      title={copied ? 'Copied!' : `Copy ${full}`}
      className={`inline-flex items-center gap-1 hover:text-text transition-colors ${className ?? ''}`}
    >
      {inner}
      <span
        data-testid="address-display-copy-icon"
        className="text-text-faint text-[10px]"
      >
        {copied ? '✓' : '⎘'}
      </span>
    </button>
  );
}

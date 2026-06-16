'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Logo } from '@/components/common/Logo';
import { WalletButton } from '@/components/wallet/WalletButton';

const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/trade', label: 'Trade' },
  { href: '/portfolio', label: 'Portfolio' },
];

const FAUCET_URL = 'https://faucet.solana.com';

export function Header() {
  const pathname = usePathname();

  return (
    <header
      data-testid="app-header"
      className="flex h-11 shrink-0 items-center gap-6 border-b border-border bg-surface-1 px-4"
    >
      <Link href="/trade" aria-label="mgk home" className="flex items-center text-accent">
        <Logo iconSize={28} />
      </Link>

      <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
        {NAV_LINKS.map((link) => {
          const isActive = pathname === link.href || pathname?.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive ? 'page' : undefined}
              className={
                isActive
                  ? 'rounded-md bg-surface-3 px-3 py-1 text-text'
                  : 'rounded-md px-3 py-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text'
              }
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 items-center rounded-full border border-warn/40 bg-surface-2 px-3 text-[11px] font-medium uppercase tracking-wider text-warn transition-colors hover:bg-warn/10"
      >
        Get devnet SOL
      </a>

      <span data-testid="wallet-button">
        <WalletButton />
      </span>
    </header>
  );
}

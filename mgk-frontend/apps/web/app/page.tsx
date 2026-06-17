import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/common/Logo';

export const metadata: Metadata = {
  title: 'mgk — On-chain perpetual futures',
  description: 'On-chain perps with commit-reveal CLOB. Fair ordering, SOL-PERP on devnet.',
};

const STEPS = [
  { step: '1', title: 'Connect Wallet', desc: 'Phantom, Solflare, or Backpack. One click.' },
  { step: '2', title: 'Deposit SOL', desc: 'Fund your portfolio with devnet SOL from the faucet.' },
  { step: '3', title: 'Place Limit Orders', desc: 'Commit-reveal batch auctions. Fair ordering, no MEV.' },
] as const;

export default function LandingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="flex flex-col items-center gap-6 max-w-md">
        <Logo iconSize={56} />

        <h1 className="text-3xl font-bold text-text tracking-tight">
          On-chain perps, fair ordering.
        </h1>

        <p className="text-text-muted text-sm leading-relaxed">
          SOL-PERP on devnet. Commit-reveal CLOB with deterministic shuffle
          and structural priority queues. No mempool front-running.
        </p>

        <Link
          href="/trade"
          data-testid="launch-app-cta"
          className="inline-flex items-center gap-2 rounded bg-accent px-6 py-3 text-sm font-semibold text-text uppercase tracking-wider transition-colors hover:bg-accent/80"
        >
          Launch App
        </Link>

        <div className="mt-8 flex gap-6 text-left">
          {STEPS.map((s) => (
            <div
              key={s.step}
              className="flex flex-col gap-1 rounded border border-border bg-surface-1 p-4 w-40"
            >
              <span className="text-accent text-xs font-mono font-bold">{s.step}</span>
              <span className="text-text text-xs font-semibold">{s.title}</span>
              <span className="text-text-muted text-[11px] leading-snug">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

'use client';

import * as sdk from '@mgk/sdk';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { PnlDisplay } from '@/components/common/PnlDisplay';

type PortfolioState = sdk.state.PortfolioState;

export interface BalancesProps {
  data: PortfolioState | null;
  loading?: boolean;
  className?: string;
}

/** Initial margin locked against open positions (im = equity - freeCollateral). */
function lockedCollateral(data: PortfolioState): bigint {
  return data.equity - data.freeCollateral;
}

/** Convert lamports (bigint) to a SOL number for `PnlDisplay` (which takes number). */
function lamportsToSolNumber(lamports: bigint): number {
  return Number(lamports) / 1_000_000_000;
}

export function Balances({ data, loading, className }: BalancesProps) {
  if (loading && !data) {
    return (
      <section
        data-testid="balances"
        data-state="loading"
        className={['rounded-md border border-border bg-surface-1 p-4', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Balances
        </h3>
        <p className="mt-2 text-text-faint">Loading…</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section
        data-testid="balances"
        data-state="empty"
        className={['rounded-md border border-border bg-surface-1 p-4', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Balances
        </h3>
        <p className="mt-2 text-text-faint">
          No portfolio yet — deposit SOL to start trading.
        </p>
      </section>
    );
  }

  const locked = lockedCollateral(data);

  return (
    <section
      data-testid="balances"
      data-state="ready"
      data-refreshing={loading ? 'true' : 'false'}
      className={['rounded-md border border-border bg-surface-1 p-4', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
        Balances
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <Row label="Equity" testid="balances-equity">
          <NumberDisplay value={data.equity} kind="lamports" />
          <span className="ml-1 text-text-faint text-[11px]">SOL</span>
        </Row>
        <Row label="Free Collateral" testid="balances-free">
          <NumberDisplay value={data.freeCollateral} kind="lamports" />
          <span className="ml-1 text-text-faint text-[11px]">SOL</span>
        </Row>
        <Row label="Locked Collateral" testid="balances-locked">
          <NumberDisplay value={locked} kind="lamports" />
          <span className="ml-1 text-text-faint text-[11px]">SOL</span>
        </Row>
        <Row label="Unrealized PnL" testid="balances-pnl">
          <PnlDisplay value={lamportsToSolNumber(data.pnl)} />
        </Row>
        <Row label="Maintenance Margin" testid="balances-mm">
          <NumberDisplay value={data.mm} kind="lamports" />
          <span className="ml-1 text-text-faint text-[11px]">SOL</span>
        </Row>
      </dl>
    </section>
  );
}

function Row({
  label,
  children,
  testid,
}: {
  label: string;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <>
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd
        data-testid={testid}
        className="text-right text-text font-mono tabular-nums"
      >
        {children}
      </dd>
    </>
  );
}

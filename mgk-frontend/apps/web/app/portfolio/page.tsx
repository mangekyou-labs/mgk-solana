'use client';

import { Balances } from '@/components/portfolio/Balances';
import { Positions } from '@/components/portfolio/Positions';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { OpenOrders } from '@/components/trade/OpenOrders';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';

const INSTRUMENT_ID = 0; // SOL-PERP only in v1

export default function PortfolioPage() {
  const { connected } = useAutoConnect();
  const portfolio = usePortfolioPolling();

  if (!connected) {
    return (
      <PageFrame>
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-text-muted font-mono text-sm">
            Connect a wallet to view your portfolio.
          </p>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <div
        data-testid="portfolio-page"
        className="flex flex-col gap-4 p-4 max-w-2xl mx-auto w-full"
      >
        <h1 className="text-lg font-semibold text-text font-mono tracking-tight">
          Portfolio
        </h1>
        <Balances data={portfolio.data} loading={portfolio.loading} />
        <Positions data={portfolio.data} loading={portfolio.loading} />
        <OpenOrders instrumentId={INSTRUMENT_ID} className="min-h-[100px]" />
      </div>
    </PageFrame>
  );
}

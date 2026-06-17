'use client';

import { useCallback, useState } from 'react';

import { PriceChart } from '@/components/chart/PriceChart';
import { TxToast } from '@/components/common/TxToast';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { BottomTabs } from '@/components/trade/BottomTabs';
import { MarketHeader } from '@/components/trade/MarketHeader';
import { OrderBook } from '@/components/trade/OrderBook';
import { OrderForm, type OrderFormParams } from '@/components/trade/OrderForm';
import { useCommitOrder, useRevealOrder } from '@/lib/hooks/useOrderSubmission';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useBookTopN } from '@/lib/stores/useBookStore';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';

const INSTRUMENT_ID = 0; // SOL-PERP only in v1

export default function TradePage() {
  const { connected } = useAutoConnect();
  const { bids, asks, data: bookData } = useBookTopN(INSTRUMENT_ID, 20);
  const { currentBatchId } = useBatchPolling(3000);
  const { data: portfolio, loading: portfolioLoading } = usePortfolioPolling(3000);
  const { commit } = useCommitOrder();
  const { reveal } = useRevealOrder();
  const orderFormStatus = useOrderFormStore((s) => s.status);
  const submitting = orderFormStatus === 'committing' || orderFormStatus === 'revealing';

  const [toast, setToast] = useState<{
    sig: string;
    error: string | null;
    retry?: () => void;
  } | null>(null);

  const bestBid = bookData?.bestBid ?? null;
  const bestAsk = bookData?.bestAsk ?? null;

  const position = portfolio?.positions.find(
    (p) => p.instrumentId === INSTRUMENT_ID,
  );
  const freeCollateral = portfolio?.freeCollateral ?? 0n;

  const handleSubmit = useCallback(
    async (params: OrderFormParams) => {
      if (currentBatchId == null) return;

      const commitParams = {
        instrumentId: INSTRUMENT_ID,
        side: params.side,
        price: params.price,
        qty: params.qty,
        reduceOnly: params.reduceOnly,
        batchId: currentBatchId,
      };

      try {
        const result = await commit(commitParams);
        setToast(null);

        try {
          const revealResult = await reveal({
            ...commitParams,
            salt: result.salt,
          });
          setToast({
            sig: revealResult.sig,
            error: null,
          });
        } catch (revealErr) {
          const msg =
            revealErr instanceof Error
              ? revealErr.message
              : String(revealErr);
          setToast({
            sig: result.sig,
            error: `Reveal failed: ${msg}`,
            retry: () => {
              void reveal();
            },
          });
        }
      } catch (commitErr) {
        const msg =
          commitErr instanceof Error
            ? commitErr.message
            : String(commitErr);
        setToast({ sig: '', error: msg });
      }
    },
    [commit, reveal, currentBatchId],
  );

  const handleAccountSuccess = useCallback((sig: string) => {
    setToast({ sig, error: null });
  }, []);

  const handleAccountError = useCallback((error: string) => {
    setToast({ sig: '', error });
  }, []);

  return (
    <PageFrame>
      <MarketHeader />
      <div
        data-testid="trade-body"
        className="flex flex-1 min-h-0"
      >
        {/* Chart column — 5fr */}
        <div
          data-testid="chart-section"
          className="flex-[5] min-w-0 flex flex-col border-r border-border"
        >
          <PriceChart
            instrumentId={INSTRUMENT_ID}
            className="flex-1 min-h-0"
          />
        </div>

        {/* Order book column — 2fr */}
        <div
          data-testid="orderbook-section"
          className="flex-[2] min-w-0 flex flex-col border-r border-border"
        >
          <OrderBook bids={bids} asks={asks} className="flex-1 min-h-0" />
        </div>

        {/* Order form column — 2fr */}
        <div
          data-testid="orderform-section"
          className="flex-[2] min-w-0 flex flex-col p-2"
        >
          <OrderForm
            bestBid={bestBid}
            bestAsk={bestAsk}
            onSubmit={connected ? handleSubmit : undefined}
            freeCollateral={freeCollateral}
            loading={portfolioLoading}
            submitting={submitting}
            portfolio={portfolio}
            portfolioLoading={portfolioLoading}
            onTxSuccess={handleAccountSuccess}
            onTxError={handleAccountError}
            className="flex-1"
          />
        </div>
      </div>
      <BottomTabs />
      {toast && (
        <TxToast
          signature={toast.sig}
          error={toast.error}
          onRetry={toast.retry}
          onDismiss={() => setToast(null)}
        />
      )}
    </PageFrame>
  );
}

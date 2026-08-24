'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as sdk from '@mgk/sdk';

import { PriceChart } from '@/components/chart/PriceChart';
import { TxToast } from '@/components/common/TxToast';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { BottomTabs } from '@/components/trade/BottomTabs';
import { MarketHeader } from '@/components/trade/MarketHeader';
import { OrderBook } from '@/components/trade/OrderBook';
import { OrderForm, type OrderFormParams } from '@/components/trade/OrderForm';
import { usePostOrder } from '@/lib/hooks/useOrderSubmission';
import { useOrderFormWalletGuard } from '@/lib/hooks/useOrderFormWalletGuard';
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
  const { post } = usePostOrder();
  const orderFormStatus = useOrderFormStore((s) => s.status);
  const submitting = orderFormStatus === 'submitting';

  // Clear stale in-flight state when the wallet disconnects or switches.
  useOrderFormWalletGuard();

  // Dev/E2E affordance: `?set=failed` etc. jumps order form status on mount.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('set');
    if (target === 'failed' || target === 'submitting' || target === 'idle') {
      useOrderFormStore.setState({ status: target });
    }
  }, []);

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
  const positionQty = position?.qty ?? 0n;
  void sdk;

  const handleSubmitRef = useRef<(params: OrderFormParams) => Promise<void>>(
    async () => {},
  );

  const handleSubmit = useCallback(
    async (params: OrderFormParams) => {
      if (currentBatchId == null) return;

      try {
        const result = await post({
          instrumentId: INSTRUMENT_ID,
          side: params.side,
          price: params.price,
          qty: params.qty,
          reduceOnly: params.reduceOnly,
          isMaker: params.isMaker ?? false,
        });
        setToast({ sig: result.sig, error: null });
      } catch (postErr) {
        const decoded = (postErr as { decoded?: { message: string; severity: string } })
          .decoded;
        const msg = decoded?.message ?? (
          postErr instanceof Error
            ? postErr.message
            : String(postErr)
        );
        setToast({
          sig: '',
          error: `Post failed: ${msg}`,
          retry: () => {
            void handleSubmitRef.current(params);
          },
        });
      }
    },
    [post, currentBatchId],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

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
        <div
          data-testid="chart-section"
          className="flex-[5] min-w-0 flex flex-col border-r border-border"
        >
          <PriceChart
            instrumentId={INSTRUMENT_ID}
            className="flex-1 min-h-0"
          />
        </div>

        <div
          data-testid="orderbook-section"
          className="flex-[2] min-w-0 flex flex-col border-r border-border"
        >
          <OrderBook bids={bids} asks={asks} className="flex-1 min-h-0" />
        </div>

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
            positionQty={positionQty}
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

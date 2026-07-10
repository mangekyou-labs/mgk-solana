'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { PriceChart } from '@/components/chart/PriceChart';
import { TxToast } from '@/components/common/TxToast';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { BottomTabs } from '@/components/trade/BottomTabs';
import { MarketHeader } from '@/components/trade/MarketHeader';
import { OrderBook } from '@/components/trade/OrderBook';
import { OrderForm, type OrderFormParams } from '@/components/trade/OrderForm';
import { useCommitOrder, useRevealOrder } from '@/lib/hooks/useOrderSubmission';
import { useOrderFormWalletGuard } from '@/lib/hooks/useOrderFormWalletGuard';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useBookTopN } from '@/lib/stores/useBookStore';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';
import { config } from '@/lib/config';
import { resolveBatchAddress } from '@/lib/onchainAccounts';

const INSTRUMENT_ID = 0; // SOL-PERP only in v1
const REVEAL_PHASE_WAIT_MS = 180_000;
const REVEAL_PHASE_POLL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRevealPhase(
  connection: Connection,
  batchId: bigint,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < REVEAL_PHASE_WAIT_MS) {
    const batchPda = await resolveBatchAddress({
      batchId,
      programId: config.coreProgramId,
      batchAddress: config.batchAddress,
      indexerUrl: config.indexerUrl,
    });
    const batchAcc = await connection.getAccountInfo(batchPda, 'confirmed');
    if (batchAcc) {
      const batch = sdk.state.decodeBatch(new Uint8Array(batchAcc.data));
      if (batch.status === sdk.state.BatchStatus.Revealing) return;
    }
    await sleep(REVEAL_PHASE_POLL_MS);
  }
}

export default function TradePage() {
  const { connected } = useAutoConnect();
  const { connection } = useConnection();
  const { bids, asks, data: bookData } = useBookTopN(INSTRUMENT_ID, 20);
  const { currentBatchId } = useBatchPolling(3000);
  const { data: portfolio, loading: portfolioLoading } = usePortfolioPolling(3000);
  const { commit } = useCommitOrder();
  const { reveal } = useRevealOrder();
  const orderFormStatus = useOrderFormStore((s) => s.status);
  const pendingInstrumentId = useOrderFormStore((s) => s.instrumentId);
  const pendingSide = useOrderFormStore((s) => s.side);
  const pendingPrice = useOrderFormStore((s) => s.price);
  const pendingQty = useOrderFormStore((s) => s.qty);
  const pendingReduceOnly = useOrderFormStore((s) => s.reduceOnly);
  const pendingBatchId = useOrderFormStore((s) => s.batchId);
  const pendingSalt = useOrderFormStore((s) => s.salt);
  const pendingHash = useOrderFormStore((s) => s.hash);
  const submitting = orderFormStatus === 'committing' || orderFormStatus === 'revealing';

  // G12 + G8: clear stale in-flight commit-reveal state when the wallet
  // disconnects or switches to a different account.
  useOrderFormWalletGuard();

  // Dev/E2E affordance: `?set=slashed` (or `failed`, `committing`, etc.)
  // jumps the order form to that status on mount so QA + Playwright can
  // verify edge-case UX without a real tx. Production builds are not
  // affected because the check is gated by NODE_ENV.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('set');
    if (
      target === 'slashed' ||
      target === 'failed' ||
      target === 'committing' ||
      target === 'revealing' ||
      target === 'awaiting_reveal' ||
      target === 'idle'
    ) {
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

  // Ref so the commit-failure retry closure can call the latest handleSubmit
  // without an "accessed before declaration" lint error.
  const handleSubmitRef = useRef<(params: OrderFormParams) => Promise<void>>(
    async () => {},
  );
  const autoRevealKeyRef = useRef<string | null>(null);

  const handleSubmit = useCallback(
    async (params: OrderFormParams) => {
      if (currentBatchId == null) return;

      const commitParams = {
        instrumentId: INSTRUMENT_ID,
        side: params.side,
        price: params.price,
        qty: params.qty,
        reduceOnly: params.reduceOnly,
      };

      try {
        await commit(commitParams);
        setToast(null);
      } catch (commitErr) {
        const decoded = (commitErr as { decoded?: { message: string; severity: string } })
          .decoded;
        const msg = decoded?.message ?? (
          commitErr instanceof Error
            ? commitErr.message
            : String(commitErr)
        );
        const isSlashed = decoded?.severity === 'slashed';
        setToast({
          sig: '',
          error: isSlashed ? msg : `Commit failed: ${msg}`,
          retry: isSlashed ? undefined : () => {
            void handleSubmitRef.current(params);
          },
        });
      }
    },
    [commit, currentBatchId],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    if (orderFormStatus !== 'awaiting_reveal') return;
    if (pendingHash.length === 0 || pendingSalt === 0n) return;

    const key = `${pendingBatchId.toString()}:${pendingHash}`;
    if (autoRevealKeyRef.current === key) return;
    autoRevealKeyRef.current = key;

    let cancelled = false;
    void (async () => {
      try {
        await waitForRevealPhase(connection, pendingBatchId);
        if (cancelled) return;

        const revealResult = await reveal({
          instrumentId: pendingInstrumentId,
          side: pendingSide,
          price: pendingPrice,
          qty: pendingQty,
          reduceOnly: pendingReduceOnly,
          salt: pendingSalt,
          batchId: pendingBatchId,
        });
        if (!cancelled) {
          setToast({ sig: revealResult.sig, error: null });
        }
      } catch (revealErr) {
        if (cancelled) return;
        const decoded = (revealErr as { decoded?: { message: string; severity: string } })
          .decoded;
        const msg = decoded?.message ?? (
          revealErr instanceof Error
            ? revealErr.message
            : String(revealErr)
        );
        const isSlashed = decoded?.severity === 'slashed';
        setToast({
          sig: '',
          error: isSlashed ? msg : `Reveal failed: ${msg}`,
          retry: isSlashed ? undefined : () => {
            autoRevealKeyRef.current = null;
            useOrderFormStore.getState().setStatus('awaiting_reveal');
          },
        });
      }
    })();

    return () => {
      cancelled = true;
      if (autoRevealKeyRef.current === key) {
        autoRevealKeyRef.current = null;
      }
    };
  }, [
    connection,
    orderFormStatus,
    pendingInstrumentId,
    pendingSide,
    pendingPrice,
    pendingQty,
    pendingReduceOnly,
    pendingBatchId,
    pendingSalt,
    pendingHash,
    reveal,
  ]);

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

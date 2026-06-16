'use client';

import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { truncatePubkey } from '@/lib/pubkey';

export default function TradePage() {
  const { connected, publicKey } = useAutoConnect();

  return (
    <PageFrame>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold text-text" data-testid="trade-greeting">
            {connected && publicKey
              ? `Hello ${truncatePubkey(publicKey)}`
              : 'Connect a wallet to start trading.'}
          </h1>
          <p
            className="max-w-md text-sm text-text-muted"
            data-testid="trade-subtitle"
          >
            mgk on-chain perps. Commit-reveal CLOB. M1 placeholder — M2 will read
            portfolio / batch / book state, M3 will wire the order form.
          </p>
        </div>
      </div>
    </PageFrame>
  );
}

'use client';

import { HistoryComingSoon } from './HistoryComingSoon';

export interface FundingHistoryProps {
  className?: string;
}

export function FundingHistory({ className }: FundingHistoryProps) {
  return (
    <HistoryComingSoon
      testId="funding-history"
      title="Funding History"
      description="Per-position funding payments you've paid or received when a batch closes. (mgk's batch model doesn't run continuous funding — this will only show intra-batch adjustments once the protocol emits them.)"
      requiredSources={[
        'Indexer subscriber: capture batch settlement events that mutate user collateral beyond a fill.',
        'New SQLite table: funding_events(batch_id, user_pubkey, instrument_id, amount_signed, ts).',
        'REST route: GET /api/users/:pubkey/funding?limit=200&instrumentId=…',
      ]}
      className={className}
    />
  );
}

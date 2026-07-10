'use client';

import { HistoryComingSoon } from './HistoryComingSoon';

export interface PositionHistoryProps {
  className?: string;
}

export function PositionHistory({ className }: PositionHistoryProps) {
  return (
    <HistoryComingSoon
      testId="position-history"
      title="Position History"
      description="Every open, increase, decrease, and close event for your positions — with realized PnL per close. Sourced by diffing consecutive Portfolio PDAs across the same wallet."
      requiredSources={[
        'Indexer subscriber: watch every Portfolio PDA write for the wallet, snapshot positions, emit a position_event on size or side change.',
        'New SQLite table: position_events(user_pubkey, instrument_id, batch_id, event_type, size_delta, realized_pnl, ts).',
        'REST route: GET /api/users/:pubkey/positions?limit=200&instrumentId=…',
      ]}
      className={className}
    />
  );
}

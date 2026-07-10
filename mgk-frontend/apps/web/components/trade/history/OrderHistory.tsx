'use client';

import { HistoryComingSoon } from './HistoryComingSoon';

export interface OrderHistoryProps {
  instrumentId?: number;
  className?: string;
}

export function OrderHistory({ className }: OrderHistoryProps) {
  return (
    <HistoryComingSoon
      testId="order-history"
      title="Order History"
      description="Shows every commit-reveal order you've placed: status (Filled, Resting, Cancelled, Expired, Slashed), the time you committed, the time the batch cleared, fill price, and the batch it landed in."
      requiredSources={[
        'Indexer subscriber: capture every CommitOrder + CancelRestingOrder + ModifyRestingOrder instruction that targets the matcher program.',
        'New SQLite table: orders(order_id, user_pubkey, batch_id, instrument_id, side, price, qty, status, committed_slot, cleared_slot).',
        'REST route: GET /api/users/:pubkey/orders?limit=200&instrumentId=…',
      ]}
      className={className}
    />
  );
}

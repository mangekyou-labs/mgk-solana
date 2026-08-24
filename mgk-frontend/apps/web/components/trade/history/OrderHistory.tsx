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
      description="Shows every DFBA order you've posted: status (Filled, Partially Filled, Resting, Cancelled, Expired), the time you posted it, the time the batch cleared, fill price, and the batch it landed in."
      requiredSources={[
        'Indexer subscriber: capture every OrderPosted + OrderCancelled + OrderModified event that targets the matcher book.',
        'New SQLite table: orders(order_id, user_pubkey, batch_id, instrument_id, side, price, qty, status, posted_slot, cleared_slot).',
        'REST route: GET /api/users/:pubkey/orders?limit=200&instrumentId=…',
      ]}
      className={className}
    />
  );
}

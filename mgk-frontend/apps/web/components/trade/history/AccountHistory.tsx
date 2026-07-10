'use client';

import { HistoryComingSoon } from './HistoryComingSoon';

export interface AccountHistoryProps {
  className?: string;
}

export function AccountHistory({ className }: AccountHistoryProps) {
  return (
    <HistoryComingSoon
      testId="account-history"
      title="Account History"
      description="Deposits, withdrawals, liquidations, and any other portfolio-level events for the connected wallet."
      requiredSources={[
        'Indexer subscriber: capture Deposit, Withdraw, LiquidateUser, and any future portfolio-level instructions.',
        'New SQLite table: account_events(user_pubkey, tx_signature, event_type, amount_signed, slot, ts).',
        'REST route: GET /api/users/:pubkey/account-events?limit=200',
      ]}
      className={className}
    />
  );
}

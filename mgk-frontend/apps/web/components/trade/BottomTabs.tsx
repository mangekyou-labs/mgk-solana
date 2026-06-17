'use client';

import { useState } from 'react';

import { Balances } from '@/components/portfolio/Balances';
import { Positions } from '@/components/portfolio/Positions';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';
import { OpenOrders } from './OpenOrders';

export type TabId =
  | 'positions'
  | 'open-orders'
  | 'balances'
  | 'order-history'
  | 'trade-history'
  | 'funding-history'
  | 'position-history'
  | 'account-history';

interface Tab {
  id: TabId;
  label: string;
  count?: number;
}

const TABS: Tab[] = [
  { id: 'positions', label: 'Positions', count: 0 },
  { id: 'open-orders', label: 'Open Orders', count: 0 },
  { id: 'balances', label: 'Balances' },
  { id: 'order-history', label: 'Order History' },
  { id: 'trade-history', label: 'Trade History' },
  { id: 'funding-history', label: 'Funding History' },
  { id: 'position-history', label: 'Position History' },
  { id: 'account-history', label: 'Account History' },
];

const EMPTY_MESSAGES: Record<TabId, string> = {
  positions: 'You have no positions yet.',
  'open-orders': 'You have no open orders.',
  balances: 'No balances to display.',
  'order-history': 'No order history.',
  'trade-history': 'No trade history.',
  'funding-history': 'No funding history.',
  'position-history': 'No position history.',
  'account-history': 'No account history.',
};

export interface BottomTabsProps {
  /** instrument id used for OpenOrders (matcher Book PDA). */
  instrumentId?: number;
  className?: string;
}

export function BottomTabs({ instrumentId = 0, className }: BottomTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('positions');
  const portfolio = usePortfolioPolling(3000);

  const firstRow = TABS.slice(0, 5);
  const secondRow = TABS.slice(5);

  return (
    <div
      data-testid="bottom-tabs"
      className={`flex flex-col ${className ?? ''}`}
    >
      <div
        data-testid="bottom-tabs-strip"
        className="border-b border-border bg-surface-1"
      >
        <div className="flex justify-between items-end">
          <div className="flex flex-col">
            <TabRow
              tabs={firstRow}
              activeTab={activeTab}
              onSelect={setActiveTab}
              data-testid="bottom-tabs-row1"
            />
            <div className="flex">
              <TabRow
                tabs={secondRow}
                activeTab={activeTab}
                onSelect={setActiveTab}
                data-testid="bottom-tabs-row2"
              />
              <CurrentMarketFilter />
            </div>
          </div>
        </div>
      </div>
      <div
        data-testid="bottom-tabs-content"
        data-active-tab={activeTab}
        className="text-text-faint font-mono text-xs"
      >
        <TabContent
          activeTab={activeTab}
          instrumentId={instrumentId}
          portfolioData={portfolio.data}
          portfolioLoading={portfolio.loading}
        />
      </div>
    </div>
  );
}

function TabContent({
  activeTab,
  instrumentId,
  portfolioData,
  portfolioLoading,
}: {
  activeTab: TabId;
  instrumentId: number;
  portfolioData: Parameters<typeof Positions>[0]['data'];
  portfolioLoading: boolean;
}) {
  switch (activeTab) {
    case 'positions':
      return (
        <div className="p-2" data-testid="bottom-tabs-positions">
          <Positions data={portfolioData} loading={portfolioLoading} />
        </div>
      );
    case 'balances':
      return (
        <div className="p-2" data-testid="bottom-tabs-balances">
          <Balances data={portfolioData} loading={portfolioLoading} />
        </div>
      );
    case 'open-orders':
      return (
        <div className="p-2" data-testid="bottom-tabs-open-orders">
          <OpenOrders instrumentId={instrumentId} />
        </div>
      );
    default:
      return (
        <div className="px-4 py-6 text-center" data-testid="bottom-tabs-empty">
          {EMPTY_MESSAGES[activeTab]}
        </div>
      );
  }
}

function TabRow({
  tabs,
  activeTab,
  onSelect,
  'data-testid': dataTestId,
}: {
  tabs: Tab[];
  activeTab: TabId;
  onSelect: (id: TabId) => void;
  'data-testid'?: string;
}) {
  return (
    <div data-testid={dataTestId} className="flex">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            data-testid="bottom-tab"
            data-tab-id={tab.id}
            data-active={isActive ? 'true' : 'false'}
            onClick={() => onSelect(tab.id)}
            className={[
              'px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider whitespace-nowrap',
              'border-b-2 transition-colors',
              isActive
                ? 'text-text border-accent'
                : 'text-text-muted border-transparent hover:text-text hover:border-border',
            ].join(' ')}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                data-testid="bottom-tab-count"
                className="ml-1 text-text-faint"
              >
                ({tab.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function CurrentMarketFilter() {
  return (
    <label
      data-testid="current-market-filter"
      className="flex items-center gap-1.5 ml-auto px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted cursor-pointer select-none"
    >
      <input
        type="checkbox"
        data-testid="current-market-checkbox"
        className="h-3 w-3 rounded border-border bg-surface-2 accent-accent"
        defaultChecked
      />
      Current Market
    </label>
  );
}

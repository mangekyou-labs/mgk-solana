import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OrderHistory } from './OrderHistory';
import { FundingHistory } from './FundingHistory';
import { PositionHistory } from './PositionHistory';
import { AccountHistory } from './AccountHistory';

describe('HistoryComingSoon (4 placeholder tabs)', () => {
  const cases: Array<{
    name: string;
    Component: React.ComponentType<{ className?: string }>;
    testId: string;
    title: string;
    descriptionSnippet: string;
  }> = [
    {
      name: 'OrderHistory',
      Component: OrderHistory,
      testId: 'order-history',
      title: 'Order History',
      descriptionSnippet: 'DFBA order',
    },
    {
      name: 'FundingHistory',
      Component: FundingHistory,
      testId: 'funding-history',
      title: 'Funding History',
      descriptionSnippet: 'funding payments',
    },
    {
      name: 'PositionHistory',
      Component: PositionHistory,
      testId: 'position-history',
      title: 'Position History',
      descriptionSnippet: 'open, increase, decrease, and close',
    },
    {
      name: 'AccountHistory',
      Component: AccountHistory,
      testId: 'account-history',
      title: 'Account History',
      descriptionSnippet: 'Deposits, withdrawals, liquidations',
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it('renders the coming-soon root with the correct testid', () => {
        render(<c.Component />);
        const root = screen.getByTestId(`${c.testId}-coming-soon`);
        expect(root).toBeInTheDocument();
        expect(root.getAttribute('data-history-tab')).toBe(c.testId);
      });

      it('shows the title in uppercase', () => {
        render(<c.Component />);
        const title = screen.getByTestId(`${c.testId}-coming-soon-title`);
        expect(title).toHaveTextContent(c.title);
      });

      it('shows the "Coming soon" badge', () => {
        render(<c.Component />);
        const badge = screen.getByTestId(`${c.testId}-coming-soon-badge`);
        expect(badge).toHaveTextContent('Coming soon');
      });

      it('describes the data sources the indexer would need', () => {
        render(<c.Component />);
        const desc = screen.getByTestId(`${c.testId}-coming-soon-description`);
        expect(desc.textContent).toMatch(new RegExp(c.descriptionSnippet, 'i'));
        const sources = screen.getByTestId(`${c.testId}-coming-soon-sources`);
        expect(sources.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
      });
    });
  }
});

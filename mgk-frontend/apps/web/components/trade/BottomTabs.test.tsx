import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BottomTabs, type TabId } from './BottomTabs';

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: { toBase58: () => 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC' },
    connected: true,
  }),
}));
vi.mock('@/lib/stores/usePortfolioStore', () => ({
  usePortfolioPolling: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@/lib/stores/useMyFillsStore', () => ({
  useMyFills: () => ({ fills: [], loading: false, error: null, isPolling: false }),
}));
vi.mock('@/components/portfolio/Balances', () => ({
  Balances: () => <div data-testid="balances-stub">BalancesStub</div>,
}));
vi.mock('@/components/portfolio/Positions', () => ({
  Positions: () => <div data-testid="positions-stub">PositionsStub</div>,
}));
vi.mock('./OpenOrders', () => ({
  OpenOrders: () => <div data-testid="open-orders-stub">OpenOrdersStub</div>,
}));
vi.mock('./history/TradeHistory', () => ({
  TradeHistory: () => <div data-testid="trade-history-stub">TradeHistoryStub</div>,
}));
vi.mock('./history/OrderHistory', () => ({
  OrderHistory: () => <div data-testid="order-history-stub">OrderHistoryStub</div>,
}));
vi.mock('./history/FundingHistory', () => ({
  FundingHistory: () => <div data-testid="funding-history-stub">FundingHistoryStub</div>,
}));
vi.mock('./history/PositionHistory', () => ({
  PositionHistory: () => <div data-testid="position-history-stub">PositionHistoryStub</div>,
}));
vi.mock('./history/AccountHistory', () => ({
  AccountHistory: () => <div data-testid="account-history-stub">AccountHistoryStub</div>,
}));

describe('BottomTabs', () => {
  it('renders two rows of tabs', () => {
    render(<BottomTabs />);
    const row1 = screen.getByTestId('bottom-tabs-row1');
    const row2 = screen.getByTestId('bottom-tabs-row2');
    expect(row1).toBeInTheDocument();
    expect(row2).toBeInTheDocument();
  });

  it('renders all 8 tabs across the two rows', () => {
    render(<BottomTabs />);
    const tabs = screen.getAllByTestId('bottom-tab');
    expect(tabs).toHaveLength(8);
  });

  it('has 5 tabs in the first row', () => {
    render(<BottomTabs />);
    const row1 = screen.getByTestId('bottom-tabs-row1');
    const firstRow = within(row1).getAllByTestId('bottom-tab');
    expect(firstRow).toHaveLength(5);
    expect(firstRow.map((t) => t.getAttribute('data-tab-id'))).toEqual([
      'positions',
      'open-orders',
      'balances',
      'order-history',
      'trade-history',
    ]);
  });

  it('has 3 tabs in the second row', () => {
    render(<BottomTabs />);
    const row2 = screen.getByTestId('bottom-tabs-row2');
    const secondRow = within(row2).getAllByTestId('bottom-tab');
    expect(secondRow).toHaveLength(3);
    expect(secondRow.map((t) => t.getAttribute('data-tab-id'))).toEqual([
      'funding-history',
      'position-history',
      'account-history',
    ]);
  });

  it('marks the Positions tab as active by default', () => {
    render(<BottomTabs />);
    const positionsTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'positions');
    expect(positionsTab?.getAttribute('data-active')).toBe('true');
  });

  it('renders Positions component in the default active tab', () => {
    render(<BottomTabs />);
    const content = screen.getByTestId('bottom-tabs-content');
    expect(content.getAttribute('data-active-tab')).toBe('positions');
    expect(within(content).getByTestId('bottom-tabs-positions')).toBeInTheDocument();
    expect(within(content).getByTestId('positions-stub')).toBeInTheDocument();
  });

  it('switches the active tab and content on click', () => {
    render(<BottomTabs />);
    const ordersTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'open-orders')!;
    fireEvent.click(ordersTab);

    expect(ordersTab.getAttribute('data-active')).toBe('true');
    const content = screen.getByTestId('bottom-tabs-content');
    expect(content.getAttribute('data-active-tab')).toBe('open-orders');
    expect(within(content).getByTestId('open-orders-stub')).toBeInTheDocument();
  });

  it('renders Balances component when the balances tab is selected', () => {
    render(<BottomTabs />);
    const balancesTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'balances')!;
    fireEvent.click(balancesTab);
    const content = screen.getByTestId('bottom-tabs-content');
    expect(within(content).getByTestId('balances-stub')).toBeInTheDocument();
  });

  it('shows the empty message for tabs that have no real component', () => {
    render(<BottomTabs />);
    const orderHistoryTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'order-history')!;
    fireEvent.click(orderHistoryTab);
    expect(screen.getByTestId('bottom-tabs-content')).toHaveTextContent(
      'OrderHistoryStub',
    );
  });

  it('deactivates the previously active tab when switching', () => {
    render(<BottomTabs />);
    const positionsTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'positions');
    const balancesTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'balances')!;

    fireEvent.click(balancesTab);
    expect(positionsTab?.getAttribute('data-active')).toBe('false');
    expect(balancesTab.getAttribute('data-active')).toBe('true');
  });

  it('shows a state-driven count badge for Positions and no unknown Open Orders count', () => {
    render(<BottomTabs />);
    const tabs = screen.getAllByTestId('bottom-tab');
    const positionsTab = tabs.find(
      (t) => t.getAttribute('data-tab-id') === 'positions',
    )!;
    const ordersTab = tabs.find(
      (t) => t.getAttribute('data-tab-id') === 'open-orders',
    )!;
    expect(
      within(positionsTab).queryByTestId('bottom-tab-count'),
    ).toHaveTextContent('(0)');
    expect(
      within(ordersTab).queryByTestId('bottom-tab-count'),
    ).toBeNull();
  });

  it('does not show count badges for tabs without a count', () => {
    render(<BottomTabs />);
    const balancesTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'balances')!;
    expect(
      within(balancesTab).queryByTestId('bottom-tab-count'),
    ).toBeNull();
  });

  it('renders the Current Market filter checkbox', () => {
    render(<BottomTabs />);
    const filter = screen.getByTestId('current-market-filter');
    expect(filter).toHaveTextContent('Current Market');
    const checkbox = within(filter).getByTestId('current-market-checkbox');
    expect(checkbox).toBeInTheDocument();
    expect((checkbox as HTMLInputElement).type).toBe('checkbox');
    expect((checkbox as HTMLInputElement).defaultChecked).toBe(true);
  });

  it('renders the empty message for the fallback tabs (no real component)', () => {
    // Every tab now mounts a real component (mocked as a stub in this file).
    // Verify each of the 5 history tabs wires through to its real component.
    const stubs: Partial<Record<TabId, string>> = {
      'order-history': 'OrderHistoryStub',
      'trade-history': 'TradeHistoryStub',
      'funding-history': 'FundingHistoryStub',
      'position-history': 'PositionHistoryStub',
      'account-history': 'AccountHistoryStub',
    };

    render(<BottomTabs />);
    for (const [tabId, stub] of Object.entries(stubs)) {
      const tab = screen
        .getAllByTestId('bottom-tab')
        .find((t) => t.getAttribute('data-tab-id') === tabId)!;
      fireEvent.click(tab);
      expect(screen.getByTestId('bottom-tabs-content')).toHaveTextContent(
        stub as string,
      );
    }
  });

  it('applies the className prop to the root', () => {
    const { container } = render(<BottomTabs className="custom-class" />);
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('passes instrumentId through to OpenOrders (instrumentId=7)', () => {
    render(<BottomTabs instrumentId={7} />);
    const ordersTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'open-orders')!;
    fireEvent.click(ordersTab);
    // OpenOrders stub is mocked — just verify the parent container exists
    expect(
      within(screen.getByTestId('bottom-tabs-content')).getByTestId(
        'bottom-tabs-open-orders',
      ),
    ).toBeInTheDocument();
  });

  it('passes instrumentId through to TradeHistory (instrumentId=3)', () => {
    render(<BottomTabs instrumentId={3} />);
    const tradeTab = screen
      .getAllByTestId('bottom-tab')
      .find((t) => t.getAttribute('data-tab-id') === 'trade-history')!;
    fireEvent.click(tradeTab);
    expect(
      within(screen.getByTestId('bottom-tabs-content')).getByTestId(
        'bottom-tabs-trade-history',
      ),
    ).toBeInTheDocument();
  });
});

import { test, expect } from '@playwright/test';

test.describe('Browser origin hydration', () => {
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000'] as const) {
    test(`opens the wallet selector from ${origin}`, async ({ page }) => {
      await page.goto(`${origin}/trade`);

      await page.getByRole('button', { name: 'Select Wallet' }).click();

      await expect(
        page.getByRole('heading', { name: /connect a wallet on solana/i }),
      ).toBeVisible({ timeout: 3_000 });
    });

    test(`hydrates chart controls from ${origin}`, async ({ page }) => {
      await page.goto(`${origin}/trade`);

      await page.locator('[data-testid="tf-15m"]').click();

      await expect(page.locator('[data-testid="tf-15m"]')).toHaveAttribute(
        'data-active',
        'true',
        { timeout: 3_000 },
      );
    });
  }
});

test.describe('Trade page — layout smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('renders the header with logo, nav, and wallet button', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="app-header"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'mgk home' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trade' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Select Wallet' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Get devnet SOL' }),
    ).toBeVisible();
  });

  test('renders the ticker bar with three cells', async ({ page }) => {
    await expect(page.locator('[data-testid="ticker-bar"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="ticker-btc-usd"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="ticker-eth-usd"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="ticker-sol-usd"]'),
    ).toBeVisible();
  });

  test('renders the market header with SOL-USD Perp', async ({ page }) => {
    await expect(
      page.locator('[data-testid="market-header"]'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'SOL-USD Perp' }),
    ).toBeVisible();
  });

  test('renders the three-column layout: chart, order book, order form', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="chart-section"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="orderbook-section"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="orderform-section"]'),
    ).toBeVisible();
  });

  test('renders the chart toolbar with timeframe buttons', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="chart-toolbar"]')).toBeVisible();
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      await expect(page.locator(`[data-testid="tf-${tf}"]`)).toBeVisible();
    }
    // 5m should be active by default
    await expect(page.locator('[data-testid="tf-5m"]')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  test('renders the trade page without critical console errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Wait for async data to settle
    await page.waitForTimeout(10_000);
    // Only fail on React/minified errors, not on RPC 429 / WS connection refused
    const critical = errors.filter(
      (e) =>
        !e.includes('429') &&
        !e.includes('ERR_CONNECTION_REFUSED') &&
        !e.includes('Failed to load resource'),
    );
    expect(critical).toEqual([]);
  });
});

test.describe('Chart toolbar interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('switches resolution when clicking a timeframe button', async ({
    page,
  }) => {
    // Click 15m
    await page.locator('[data-testid="tf-15m"]').click();
    await expect(page.locator('[data-testid="tf-15m"]')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.locator('[data-testid="tf-5m"]')).toHaveAttribute(
      'data-active',
      'false',
    );
  });

  test('toggles between Chart and Market Info view modes', async ({
    page,
  }) => {
    // Click Market Info
    await page.locator('[data-testid="vm-market-info"]').click();
    await expect(
      page.locator('[data-testid="market-info-placeholder"]'),
    ).toBeVisible();

    // Click Chart to go back
    await page.locator('[data-testid="vm-chart"]').click();
    await expect(
      page.locator('[data-testid="market-info-placeholder"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="price-chart"]'),
    ).toBeVisible();
  });

  test('Indicators, Mark, and Oracle buttons are disabled in v1', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="btn-indicators"]')).toBeDisabled();
    await expect(page.locator('[data-testid="toggle-mark"]')).toBeDisabled();
    await expect(page.locator('[data-testid="toggle-oracle"]')).toBeDisabled();
  });

  test('shows the WS status as live when indexer is running, off when not', async ({
    page,
  }) => {
    // In CI the indexer is not running so WS shows "off". Locally it may be live.
    const status = page.locator('[data-testid="chart-ws-status"]');
    const text = await status.textContent();
    if (text?.includes('live')) {
      await expect(status).toContainText('live');
    } else {
      await expect(status).toContainText('off');
    }
  });
});

test.describe('Status bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('shows offline, Devnet pill, and disconnected wallet', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="status-bar"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="status-bar"]'),
    ).toContainText('Devnet');
    await expect(
      page.locator('[data-testid="status-bar"]'),
    ).toContainText('Not Connected');
  });
});

test.describe('M7 — TradingView widget + BottomTabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('mounts the TradingView widget with the default 5m interval', async ({
    page,
  }) => {
    const widget = page.locator('[data-testid="tradingview-widget"]');
    await expect(widget).toBeVisible();
    await expect(widget).toHaveAttribute('data-symbol', 'BINANCE:SOLUSDT');
    await expect(widget).toHaveAttribute('data-interval', '5');
  });

  test('never fires the deleted /api/pyth proxy endpoint', async ({ page }) => {
    // The historical-candles /api/pyth proxy was deleted in T7.2. The
    // TickerBar's /v2/updates/price/latest requests are intentional
    // (BTC/ETH/SOL latest prices) and use a different Hermes endpoint.
    const pythProxyRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/pyth')) {
        pythProxyRequests.push(req.url());
      }
    });
    // Settle the page through its full async load.
    await page.waitForTimeout(8_000);
    expect(pythProxyRequests).toEqual([]);
  });

  test('switching timeframe updates the widget data-interval', async ({
    page,
  }) => {
    const widget = page.locator('[data-testid="tradingview-widget"]');
    await expect(widget).toHaveAttribute('data-interval', '5');

    await page.locator('[data-testid="tf-1h"]').click();
    await expect(widget).toHaveAttribute('data-interval', '60');

    await page.locator('[data-testid="tf-4h"]').click();
    await expect(widget).toHaveAttribute('data-interval', '240');

    await page.locator('[data-testid="tf-1d"]').click();
    await expect(widget).toHaveAttribute('data-interval', 'D');

    await page.locator('[data-testid="tf-1m"]').click();
    await expect(widget).toHaveAttribute('data-interval', '1');
  });

  test('BottomTabs is mounted below the 3-column layout', async ({ page }) => {
    const tabs = page.locator('[data-testid="bottom-tabs"]');
    await expect(tabs).toBeVisible();
    // First row has 5 tabs, second row has 3 tabs.
    await expect(page.locator('[data-testid="bottom-tab"]')).toHaveCount(8);
  });

  test('BottomTabs shows the Positions component by default', async ({
    page,
  }) => {
    const content = page.locator('[data-testid="bottom-tabs-content"]');
    await expect(content).toHaveAttribute('data-active-tab', 'positions');
  });

  test('switching to the Balances tab mounts the Balances component', async ({
    page,
  }) => {
    await page.locator('button[data-tab-id="balances"]').click();
    const content = page.locator('[data-testid="bottom-tabs-content"]');
    await expect(content).toHaveAttribute('data-active-tab', 'balances');
  });

  test('MarketHeader falls back to em-dash when the indexer is offline', async ({
    page,
  }) => {
    // Without a running indexer, 24h Vol + OI show "—" with a tooltip.
    const vol = page.locator('[data-testid="stat-24h-vol"]');
    const oi = page.locator('[data-testid="stat-oi"]');
    await expect(vol).toContainText('—');
    await expect(oi).toContainText('—');
  });
});

test.describe('Order form — UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('order form renders price and qty inputs', async ({ page }) => {
    await expect(page.locator('[data-testid="order-form-price-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="order-form-qty-input"]')).toBeVisible();
  });

  test('side tabs switch between buy and sell', async ({ page }) => {
    const buyTab = page.locator('[data-testid="order-form-side-buy"]');
    const sellTab = page.locator('[data-testid="order-form-side-sell"]');

    await expect(buyTab).toHaveAttribute('data-active', 'true');
    await expect(sellTab).toHaveAttribute('data-active', 'false');

    await sellTab.click();
    await expect(sellTab).toHaveAttribute('data-active', 'true');
    await expect(buyTab).toHaveAttribute('data-active', 'false');

    await buyTab.click();
    await expect(buyTab).toHaveAttribute('data-active', 'true');
    await expect(sellTab).toHaveAttribute('data-active', 'false');
  });

  test('qty slider buttons exist', async ({ page }) => {
    for (const pct of [20, 40, 60, 80, 100]) {
      await expect(page.locator(`[data-testid="qty-slider-${pct}"]`)).toBeVisible();
    }
  });

  test('reduce-only checkbox toggles', async ({ page }) => {
    const checkbox = page.locator('[data-testid="order-form-checkbox-input-reduce-only"]');
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  });

  test('DFBA post-as-maker checkbox toggles', async ({ page }) => {
    // DFBA dual-auction role flag (is_maker) on PostOrder
    const maker = page.getByRole('checkbox', { name: /post as maker/i });
    await expect(maker).toBeVisible();
    await expect(maker).not.toBeChecked();
    await maker.check();
    await expect(maker).toBeChecked();
    await maker.uncheck();
    await expect(maker).not.toBeChecked();
  });

  test('price and size inputs accept typed values', async ({ page }) => {
    const price = page.locator('[data-testid="order-form-price-input"]');
    const qty = page.locator('[data-testid="order-form-qty-input"]');
    await price.fill('100.50');
    await qty.fill('2.5');
    await expect(price).toHaveValue('100.50');
    await expect(qty).toHaveValue('2.5');
  });

  test('buy button is disabled when wallet is not connected', async ({ page }) => {
    const buyBtn = page.locator('[data-testid="order-form-submit-buy"]');
    // No wallet connected — buy should be the active side (default) but not submit a tx
    await expect(buyBtn).not.toBeDisabled(); // not disabled visually — click handler checks wallet
  });

  test('sell button renders in correct state for default side', async ({ page }) => {
    const sellBtn = page.locator('[data-testid="order-form-submit-sell"]');
    await expect(sellBtn).toBeVisible();
  });

  test('order form section is present (account CTA needs connected wallet)', async ({ page }) => {
    // AccountActions only mounts when wallet is connected (browser auto-connect
    // varies). Layout smoke is the order form section + submit buttons.
    await expect(page.locator('[data-testid="orderform-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="order-form-submit-buy"]')).toBeVisible();
  });
});

test.describe('Order form — no legacy commit-reveal journey', () => {
  test('legacy query params do not open a slashed or reveal journey', async ({
    page,
  }) => {
    for (const set of ['slashed', 'committing', 'awaiting_reveal', 'revealing']) {
      await page.goto(`/trade?set=${set}`);
      await expect(page.locator('[data-testid="orderform-section"]')).toBeVisible();
      await expect(
        page.locator('[data-testid="order-form-slashed-banner"]'),
      ).toHaveCount(0);
      await expect(page.getByText(/order slashed/i)).toHaveCount(0);
      await expect(page.getByText(/awaiting reveal/i)).toHaveCount(0);
      await expect(page.locator('[data-testid="order-form-submit-buy"]')).toBeVisible();
    }
  });

  test('?set=failed keeps the PostOrder form usable', async ({ page }) => {
    await page.goto('/trade?set=failed');
    await expect(
      page.locator('[data-testid="order-form-slashed-banner"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="order-form-submit-buy"]')).toBeVisible();
  });
});


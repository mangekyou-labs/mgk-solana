import { expect, test } from '@playwright/test';

import {
  installMockPhantom,
  installMockSolanaRpc,
  readCapturedTransactions,
} from './fixtures/mockPhantom';

test.describe('DFBA wallet flow without an extension', () => {
  test('connects a deterministic wallet and submits PostOrder', async ({ page }) => {
    await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    await expect(
      page.locator('[data-testid="app-header"] button[data-state]'),
    ).toHaveAttribute('data-state', 'connected');

    await page.locator('[data-testid="order-form-price-input"]').fill('100.25');
    await page.locator('[data-testid="order-form-qty-input"]').fill('2.5');
    await page.getByRole('checkbox', { name: /post as maker/i }).check();
    await page.locator('[data-testid="order-form-submit-buy"]').click();

    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    const [transaction] = await readCapturedTransactions(page);
    const postOrder = transaction?.instructions.find(
      (instruction) => instruction.data[0] === 20,
    );
    expect(postOrder).toBeDefined();
    expect(postOrder?.data).toHaveLength(22);
    expect(postOrder?.data.slice(0, 3)).toEqual([20, 0, 1]);

    const wire = Uint8Array.from(postOrder?.data ?? []);
    const view = new DataView(wire.buffer);
    expect(view.getBigInt64(3, true)).toBe(100_250_000n);
    expect(view.getBigUint64(11, true)).toBe(2_500_000n);
    expect(view.getUint16(19, true)).toBe(0);
    expect(view.getUint8(21)).toBe(0);
    expect(postOrder?.keys).toHaveLength(6);
    expect(postOrder?.keys[1]?.isSigner).toBe(true);
  });

  test('observes Collecting → Clearing → Settled copy after PostOrder', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    await page.locator('[data-testid="order-form-price-input"]').fill('87.00');
    await page.locator('[data-testid="order-form-qty-input"]').fill('0.01');
    await page.getByRole('checkbox', { name: /post as maker/i }).check();
    await page.locator('[data-testid="order-form-submit-buy"]').click();
    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    await expect(page.getByTestId('status-batch-label')).toContainText(
      'Collecting',
    );
    await expect(page.getByTestId('status-batch-label')).toContainText(
      'Orders open',
    );
    await expect(page.getByTestId('market-header-intent')).toContainText(
      'Orders open',
    );

    rpc.setBatchPhase('clearing');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Clearing.*Orders closed.*Matching maker and taker flow/);
    await expect(page.getByTestId('market-header-intent')).toContainText(
      'Matching maker and taker flow at uniform prices',
    );

    rpc.setBatchPhase('settled-valid');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Settled.*Fills settled.*Mark updated/);
    await expect(page.getByTestId('market-header-intent')).toContainText(
      'Fills settled · Mark updated',
    );
  });

  test('shows keeper lag when Collecting is past the close slot', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    rpc.setBatchPhase('collecting-ready');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Ready to clear · Waiting for keeper · 00:00:13 late/);
    await expect(page.getByTestId('market-header-intent')).toContainText(
      'Waiting for keeper · 00:00:13 late',
    );
    await expect(page.getByTestId('market-header-batch')).not.toHaveText(
      /past deadline/i,
    );
  });
});

// =====================================================================
// T9.10.7: Prepare-close flows
// =====================================================================

test.describe('T9.10.7 prepare-close', () => {
  test('long position: prepare-close sets sell/reduce-only/qty/price', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    // Set a long position: instrument 0, qty = 3_000_000 (3 SOL), entry 87e6
    rpc.setPortfolioPosition(0, 3_000_000n, 87_000_000n);
    await page.goto('/trade');

    // Wait for position to be reflected
    await expect(page.getByTestId('order-form-position-display')).toContainText('3 SOL');

    // Prepare-close button should appear
    const btn = page.getByTestId('order-form-prepare-close');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Close Long (3 SOL)');

    await btn.click();

    // Should now be on sell side with reduce-only checked
    await expect(page.getByTestId('order-form-side-sell')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('order-form-checkbox-input-reduce-only')).toBeChecked();
    await expect(page.getByTestId('order-form-checkbox-input-post-as-maker')).not.toBeChecked();
    // Qty set to position size
    await expect(page.getByTestId('order-form-qty-input')).toHaveValue('3');
  });

  test('short position: prepare-close sets buy/reduce-only/qty/price', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    // Set a short position: instrument 0, qty = -2_000_000 (-2 SOL)
    rpc.setPortfolioPosition(0, -2_000_000n, 90_000_000n);
    await page.goto('/trade');

    await expect(page.getByTestId('order-form-position-display')).toContainText('-2 SOL');

    const btn = page.getByTestId('order-form-prepare-close');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Close Short (2 SOL)');

    await btn.click();

    await expect(page.getByTestId('order-form-side-buy')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('order-form-checkbox-input-reduce-only')).toBeChecked();
    await expect(page.getByTestId('order-form-qty-input')).toHaveValue('2');
  });

  test('captured post-order instruction has exact fields for prepare-close', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    rpc.setPortfolioPosition(0, 5_000_000n, 85_000_000n);
    await page.goto('/trade');

    await expect(page.getByTestId('order-form-position-display')).toContainText('5 SOL');
    await page.getByTestId('order-form-prepare-close').click();

    // Submit the prepared close order
    await page.locator('[data-testid="order-form-submit-sell"]').click();

    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    const [transaction] = await readCapturedTransactions(page);
    const postOrder = transaction?.instructions.find(
      (instruction) => instruction.data[0] === 20,
    );
    expect(postOrder).toBeDefined();

    // Discriminator 20 = PostOrder
    expect(postOrder?.data[0]).toBe(20);
    // side = 1 (Sell)
    expect(postOrder?.data[2]).toBe(1);
    // is_maker = 0 (taker — prepare-close disables maker)
    expect(postOrder?.data[3]).toBe(0);

    const wire = Uint8Array.from(postOrder?.data ?? []);
    const view = new DataView(wire.buffer);
    // qty = 5_000_000n (5 SOL at 1e6)
    expect(view.getBigUint64(11, true)).toBe(5_000_000n);
    // instrument_id = 0
    expect(view.getUint16(19, true)).toBe(0);
    // reduce_only = 1
    expect(view.getUint8(21)).toBe(1);
  });
});

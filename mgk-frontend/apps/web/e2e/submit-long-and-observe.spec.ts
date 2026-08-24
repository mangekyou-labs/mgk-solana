import { expect, test } from '@playwright/test';
import {
  installMockPhantom,
  installMockSolanaRpc,
  readCapturedTransactions,
} from './fixtures/mockPhantom';

test.describe('Submit Long Order & Observe DFBA Progress', () => {
  test('submits a long order and records progress across DFBA batch states', async ({ page }) => {
    console.log('1. Setting up mock wallet and Solana RPC ...');
    await installMockSolanaRpc(page);
    await installMockPhantom(page);

    console.log('2. Navigating to /trade ...');
    await page.goto('/trade');

    // Wait for wallet connection to hydrate
    await expect(
      page.locator('[data-testid="app-header"] button[data-state]'),
    ).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });

    console.log('3. Filling Long Order (Price: 150.00, Size: 1.5) ...');
    await page.locator('[data-testid="order-form-price-input"]').fill('150.00');
    await page.locator('[data-testid="order-form-qty-input"]').fill('1.5');
    await page.getByRole('checkbox', { name: /post as maker/i }).check();

    // Take screenshot before submit
    await page.screenshot({ path: '/Users/kyler/.gemini/antigravity/brain/12c9a6bc-e006-49c7-8fe0-3faed72e2757/order_form_filled.png', fullPage: true });

    console.log('4. Submitting Long Order ...');
    const submitBtn = page.locator('[data-testid="order-form-submit-buy"]');
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    console.log('5. Verifying transaction submission ...');
    await expect
      .poll(() =>
        readCapturedTransactions(page).then((txs) => txs.length),
      )
      .toBe(1);

    const [tx] = await readCapturedTransactions(page);
    console.log('Captured transaction instructions:', tx?.instructions.map(i => `disc:${i.data[0]}`));

    // Take screenshot immediately after submit
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/Users/kyler/.gemini/antigravity/brain/12c9a6bc-e006-49c7-8fe0-3faed72e2757/order_submitted_progress.png', fullPage: true });

    console.log('6. Observing batch state and UI progress over 10 seconds ...');
    for (let i = 1; i <= 3; i++) {
      await page.waitForTimeout(3000);
      const batchStatusText = await page.locator('[data-testid="market-header"]').innerText().catch(() => 'N/A');
      console.log(`Observation step ${i} (after ${i * 3}s): Market Header text = "${batchStatusText.replace(/\n/g, ' ')}"`);
      await page.screenshot({ path: `/Users/kyler/.gemini/antigravity/brain/12c9a6bc-e006-49c7-8fe0-3faed72e2757/progress_step_${i}.png`, fullPage: true });
    }

    console.log('Order submission and observation complete!');
  });
});

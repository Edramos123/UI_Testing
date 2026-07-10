const { test, expect } = require('@playwright/test');

test('page loads and has a title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
});
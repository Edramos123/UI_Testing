const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: process.env.TARGET_URL || 'https://playwright.dev',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
});
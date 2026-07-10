const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  reporter: 'list',
  use: {
    baseURL: process.env.TARGET_URL || 'https://playwright.dev',
    ignoreHTTPSErrors: true,
  },
});
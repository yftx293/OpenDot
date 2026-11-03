import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['conversation-navigation.spec.ts', 'group-creation.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240000,
  reporter: 'line',
  outputDir: '../.claude/skills/verify-miniclaw/artifacts/group-create/browser',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

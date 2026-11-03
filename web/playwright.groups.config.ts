import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'group-discussion.spec.ts',
    'bot-groups.spec.ts',
    'conversation-shell.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  reporter: 'line',
  outputDir: process.env.MINICLAW_GROUP_DISCUSSION_EVIDENCE_DIR
    ? `${process.env.MINICLAW_GROUP_DISCUSSION_EVIDENCE_DIR}/browser`
    : '../.claude/skills/verify-miniclaw/artifacts/issue-69/browser',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
});

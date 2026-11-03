import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Real provider configuration crosses the fixture API. Never record network
// traces, screenshots or video containing credentials or authenticated cookies.
const evidence = process.env.MINICLAW_LIVE_EVIDENCE_PATH;
if (!evidence) throw new Error('Run npm run test:personal-agent-live');
const scenario = process.env.MINICLAW_LIVE_SCENARIO || 'personal-agent';
if (!['personal-agent', 'bot-team'].includes(scenario))
  throw new Error('Unsupported live acceptance scenario');
export default defineConfig({
  outputDir: path.join(path.dirname(evidence), 'playwright-private'),
  testDir: './tests/live',
  testMatch: `**/${scenario}.live.ts`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 480000,
  expect: { timeout: 15000 },
  reporter: 'line',
  use: {
    browserName: 'chromium',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 30000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
});

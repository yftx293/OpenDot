import { defineConfig } from '@playwright/test';
import base from './playwright.group-create.config';
export default defineConfig({
  ...base,
  testMatch: 'member-concurrency.spec.ts',
  outputDir:
    '../.claude/skills/verify-miniclaw/artifacts/member-concurrency/browser',
});

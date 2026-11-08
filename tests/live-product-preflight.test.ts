import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';
const run = (extra: NodeJS.ProcessEnv, args: string[] = []) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve('scripts/test-personal-agent-live.ts'),
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ...extra },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
test('missing secure live binding is Pending with exit 2, never a successful or skipped model test', () => {
  const result = run({
    MINICLAW_ZEN_API_KEY: ' ',
    MINICLAW_ZEN_BASE_URL: 'https://opencode.ai/zen/go/v1',
    MINICLAW_ZEN_MODEL: 'cat-jam-free',
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'pending',
    reason: 'secure_environment_binding_missing',
    missing: ['MINICLAW_ZEN_API_KEY'],
  });
  expect(result.stderr).toBe('');
});
test('Bot Team live acceptance also fails before build or inference when secure binding is absent', () => {
  const result = run({}, ['--bot-team']);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'pending',
    reason: 'secure_environment_binding_missing',
    missing: [
      'MINICLAW_ZEN_API_KEY',
      'MINICLAW_ZEN_BASE_URL',
      'MINICLAW_ZEN_MODEL',
    ],
  });
  expect(result.stderr).toBe('');
});
test('invalid configured endpoint fails closed without printing credentials or starting a browser', () => {
  const key = 'fixture-key-not-a-secret';
  const result = run({
    MINICLAW_ZEN_API_KEY: key,
    MINICLAW_ZEN_BASE_URL: 'https://wrong.invalid',
    MINICLAW_ZEN_MODEL: 'fixture',
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'failed',
    reason: 'live_acceptance_failed_details_suppressed',
  });
  expect(result.stdout + result.stderr).not.toContain(key);
});

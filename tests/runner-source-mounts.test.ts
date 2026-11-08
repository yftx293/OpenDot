import { afterEach, expect, test, vi } from 'vitest';
import { runnerSourceMounts } from '../src/runner-source-mounts.js';
afterEach(() => vi.unstubAllEnvs());
test('production does not override a tested image with host source or prompts', () => {
  vi.stubEnv('MINICLAW_CONTAINER_LIVE_SOURCE', '');
  expect(runnerSourceMounts('/checkout')).toEqual([]);
});
test('development overlays require explicit opt-in and preserve the paired read-only trees', () => {
  vi.stubEnv('MINICLAW_CONTAINER_LIVE_SOURCE', 'true');
  expect(runnerSourceMounts('/checkout')).toEqual([
    {
      hostPath: '/checkout/container/agent-runner/src',
      containerPath: '/app/src',
      readonly: true,
    },
    {
      hostPath: '/checkout/container/agent-runner/prompts',
      containerPath: '/app/prompts',
      readonly: true,
    },
  ]);
});
test('ambiguous flag values cannot turn on live source overlays', () => {
  vi.stubEnv('MINICLAW_CONTAINER_LIVE_SOURCE', '1');
  expect(runnerSourceMounts('/checkout')).toEqual([]);
});

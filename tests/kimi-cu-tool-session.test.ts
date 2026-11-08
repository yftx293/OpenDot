import { expect, test, vi } from 'vitest';
import { KimiCuToolSession } from '../src/personal-agent/kimi-cu-tool-session.js';
import { KimiDesktopTargetPolicy } from '../src/personal-agent/kimi-desktop-target-policy.js';

const token = '8ebad607-52e6-4cbc-8e14-9a278076299c';
test('tool session binds only approved action arguments to the observed target', async () => {
  const policy = {
    observe: vi.fn().mockResolvedValue({ token, text: 'fixture' }),
    approvalDigest: vi.fn().mockReturnValue('target-and-action-digest'),
    execute: vi.fn().mockResolvedValue({ text: 'done' }),
  };
  const session = new KimiCuToolSession(
    policy as unknown as KimiDesktopTargetPolicy,
  );
  await session.call('observe_window', {});
  const unverified = await session.call('act_on_window', { token, action: 'click', index: 3 });
  expect(unverified).toMatchObject({
    effect: 'unverified',
    guidance: expect.stringContaining('do not automatically repeat'),
  });
  expect(policy.approvalDigest).toHaveBeenCalledWith(token, {
    action: 'click',
    index: 3,
  });
  expect(policy.execute).toHaveBeenCalledWith(
    { action: 'click', index: 3 },
    token,
    'target-and-action-digest',
  );
  await expect(
    session.call('act_on_window', {
      token,
      action: 'click',
      index: 3,
      app: 'other.app',
    }),
  ).rejects.toThrow();
  await expect(
    session.call('act_on_window', { token, action: 'set_value', index: 3 }),
  ).rejects.toThrow();
  expect(policy.execute).toHaveBeenCalledTimes(1);
});

test('only an explicit verified native receipt is reported as verified', async () => {
  const policy = {
    approvalDigest: vi.fn().mockReturnValue('target-and-action-digest'),
    execute: vi.fn().mockResolvedValue({ text: JSON.stringify({ ok: true, verified: true }) }),
  };
  const session = new KimiCuToolSession(policy as unknown as KimiDesktopTargetPolicy);
  await expect(session.call('act_on_window', { token, action: 'click', index: 3 }))
    .resolves.toMatchObject({ effect: 'native_verified' });
  policy.execute.mockResolvedValue({ text: JSON.stringify({ ok: true, verified: false, verification_required: 'screenshot' }) });
  await expect(session.call('act_on_window', { token, action: 'click', index: 3 }))
    .resolves.toMatchObject({ effect: 'unverified' });
  policy.execute.mockResolvedValue({ text: JSON.stringify({ ok: true, verified: true, verification_required: 'screenshot' }) });
  await expect(session.call('act_on_window', { token, action: 'click', index: 3 }))
    .resolves.toMatchObject({ effect: 'unverified' });
});

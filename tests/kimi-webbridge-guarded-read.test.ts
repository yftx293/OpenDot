import { expect, test, vi } from 'vitest';
import { KimiWebBridgeGuardedReader } from '../src/personal-agent/kimi-webbridge-guarded-read.js';
const scope = {
  session: 'fixture',
  tabId: 123,
  origin: 'http://127.0.0.1:18347',
};
test('uses a fixed expression and the real tabId parameter', async () => {
  const send = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      data: {
        type: 'object',
        value: { url: scope.origin + '/', title: 'fixture', text: 'public' },
      },
    });
  const result = await new KimiWebBridgeGuardedReader(send, scope).read();
  expect(result.text).toBe('public');
  expect(send.mock.calls[0][0].args.tabId).toBe(123);
  expect(send.mock.calls[0][0].args).not.toHaveProperty('tab_id');
  expect(send.mock.calls[0][0].args.code).toContain('location.origin!==');
});
test('does not return a denied page or accept an origin forged in the result', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      data: { type: 'object', value: { denied: true } },
    })
    .mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'object',
        value: {
          url: 'http://127.0.0.1:18348/',
          title: 'other',
          text: 'secret',
        },
      },
    });
  const reader = new KimiWebBridgeGuardedReader(send, scope);
  await expect(reader.read()).rejects.toThrow();
  await expect(reader.read()).rejects.toThrow('origin');
});
test('rejects scopes with paths, userinfo or non-web schemes', () => {
  for (const origin of [
    'http://127.0.0.1:18347/path',
    'http://user@127.0.0.1:18347',
    'file:///tmp/',
  ])
    expect(
      () => new KimiWebBridgeGuardedReader(vi.fn(), { ...scope, origin }),
    ).toThrow();
});

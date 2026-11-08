import { expect, test } from 'vitest';
import { KimiCuWindowDiscovery } from '../src/personal-agent/kimi-cu-window-discovery.js';

test('window handles hide OS identifiers and reject stale or changed targets', async () => {
  let now = 1000;
  let windows = [
    {
      appId: 'net.opendot.fixture',
      pid: 234,
      windowId: 567,
      appName: 'Fixture',
      title: 'Synthetic window',
    },
  ];
  const discovery = new KimiCuWindowDiscovery(
    async () => windows,
    () => now,
  );
  const [item] = await discovery.list();
  expect(item).toEqual({
    handle: expect.any(String),
    appName: 'Fixture',
    title: 'Synthetic window',
    label: 'Fixture — Synthetic window',
  });
  expect(await discovery.resolve(item.handle)).toEqual(windows[0]);
  windows = [{ ...windows[0], pid: 235 }];
  await expect(discovery.resolve(item.handle)).rejects.toThrow(
    'Window changed',
  );
  const [next] = await discovery.list();
  now += 120_000;
  await expect(discovery.resolve(next.handle)).rejects.toThrow('expired');
});

import { expect, test, vi } from 'vitest';
import { KimiCuAgentSession } from '../src/personal-agent/kimi-cu-agent-session.js';
import { KimiCuWindowDiscovery } from '../src/personal-agent/kimi-cu-window-discovery.js';
import type { KimiCuToolSession } from '../src/personal-agent/kimi-cu-tool-session.js';

test('agent discovers and observes a target before acting; launch resets selection', async () => {
  const discovery = new KimiCuWindowDiscovery(async () => [
    {
      appId: 'net.opendot.fixture',
      pid: 1,
      windowId: 2,
      appName: 'Fixture',
      title: 'Synthetic',
    },
  ]);
  const call = vi
    .fn()
    .mockResolvedValue({
      token: 'fixture',
      text: '- pid: 1\n- bundle_id: net.opendot.fixture\n- [1] AXButton Button',
    });
  const makeSession = vi.fn(() => ({ call }) as unknown as KimiCuToolSession);
  const launch = vi.fn();
  const session = new KimiCuAgentSession(discovery, makeSession, launch);
  await expect(session.call('act_on_window', {})).rejects.toThrow('observe');
  const listing = (await session.call('list_windows', {})) as {
    windows: { handle: string; label: string }[];
  };
  const observation = await session.call('observe_window', {
    window: listing.windows[0].handle,
    label: listing.windows[0].label,
  });
  expect(observation).toMatchObject({ text: '- [1] AXButton Button' });
  await expect(session.call('act_on_window', { action: 'click', index: 1, token: 'fixture', label: listing.windows[0].label, element: '- [1] AXButton Other' })).rejects.toThrow('Element description changed');
  await expect(session.call('act_on_window', { action: 'click', index: 1, token: 'fixture', label: 'Other window', element: '- [1] AXButton Button' })).rejects.toThrow('Window selection changed');
  await session.call('act_on_window', {
    action: 'click',
    index: 1,
    token: 'fixture',
    label: listing.windows[0].label,
    element: '- [1] AXButton Button',
  });
  expect(call).toHaveBeenCalledTimes(2);
  await session.call('open_application', { application: 'Safari' });
  expect(launch).toHaveBeenCalledWith('Safari');
  await expect(session.call('act_on_window', {})).rejects.toThrow('observe');
  await expect(
    session.call('open_application', { application: '-bad' }),
  ).rejects.toThrow();
});

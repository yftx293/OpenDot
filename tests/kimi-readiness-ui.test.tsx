// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../web/src/api/client', () => ({ api: { get }, apiFetch: vi.fn() }));
import { DeviceNodes } from '../web/src/components/goals/DeviceNodes';

test('device screen labels KimiCU doctor output without claiming service permission or a grant', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  get.mockImplementation(async (path: string) => path.endsWith('/availability')
    ? { enabled: true }
    : { devices: [{ id: 'fixture', name: 'Synthetic device', state: 'active', revision: 1, online: true, last_seen_at: null,
      manifest: { capability: 'files.read', root_label: 'test', root_fingerprint: 'fixture', paths: [] }, grants: [], mcp_grants: [],
      kimi_readiness: { state: 'connected', scopedControlAvailable: false,
        computerUse: { state: 'registered', permissions: 'unknown', scopedControlAvailable: false,
          doctorPermissions: { accessibility: 'reported_granted', screenRecording: 'unknown' } } } }] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(DeviceNodes, { ownerId: 'owner', workspaces: [] })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Kimi 桌面服务：已注册');
    expect(host.textContent).toContain('诊断进程报告：辅助功能可用，屏幕录制未确认');
    expect(host.textContent).toContain('服务进程权限仍需实际验证');
    expect(host.textContent).toContain('桌面控制需要单独授权');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

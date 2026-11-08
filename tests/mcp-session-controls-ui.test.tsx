// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  receipt: vi.fn(),
  acknowledge: vi.fn(),
  owner: 'owner-1',
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));
vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ user: { id: mocks.owner } }),
    { getState: () => ({ user: { id: mocks.owner } }) },
  ),
}));
vi.mock('../web/src/utils/input-receipts', () => ({
  pendingInputRequest: mocks.receipt,
}));
const { SessionMcpTools } =
  await import('../web/src/features/pocket/SessionMcpTools');

let host: HTMLDivElement;
let root: Root;
const refresh = vi.fn(async () => {});
const base = '/api/groups/web%3Aowner/sessions/session-1';
const approval = {
  id: 'call-1',
  parameters_digest: 'a'.repeat(64),
  state: 'pending',
  expires_at: Date.now() + 60_000,
  intent: {
    server_id: 'fixture',
    original_name: 'echo',
    arguments_digest: 'b'.repeat(64),
  },
};
function render(rows = [approval]) {
  return act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionMcpTools, {
          jid: 'web:owner',
          sessionId: 'session-1',
          rows,
          refresh,
        }),
      ),
    );
  });
}
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === name,
  )!;
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.owner = 'owner-1';
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.delete.mockReset();
  mocks.receipt.mockReset();
  mocks.acknowledge.mockReset();
  refresh.mockReset().mockResolvedValue(undefined);
  mocks.receipt.mockResolvedValue({
    requestId: '11111111-1111-4111-8111-111111111111',
    acknowledge: mocks.acknowledge,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('an owner sees exact arguments before an MCP call can be approved', async () => {
  mocks.get.mockResolvedValue({ arguments: { text: 'owner-only-value' } });
  mocks.post.mockResolvedValue({ approval: { state: 'approved' } });
  await render();
  expect(button('批准此次调用').disabled).toBe(true);
  await act(async () => button('查看此次参数').click());
  expect(mocks.get).toHaveBeenCalledWith(
    `${base}/mcp/approvals/call-1/arguments`,
  );
  expect(
    host.querySelector('[aria-label="此次工具参数"]')?.textContent,
  ).toContain('owner-only-value');
  expect(button('批准此次调用').disabled).toBe(false);
  await act(async () => button('批准此次调用').click());
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    `${base}/mcp/approvals/call-1`,
    {
      parametersDigest: approval.parameters_digest,
      decision: 'approve',
      requestId: '11111111-1111-4111-8111-111111111111',
    },
  );
  expect(mocks.acknowledge).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

test('session startup consent sends only selected tools and a stable receipt', async () => {
  mocks.get.mockResolvedValue({
    supported: true,
    servers: [
      {
        server_id: 'fixture',
        configuration_digest: 'c'.repeat(64),
        tools: ['echo', 'read'],
        transport: 'stdio',
        target: '/fixture',
      },
    ],
    consents: [],
  });
  mocks.post.mockResolvedValue({ consent: { state: 'active' } });
  await render([]);
  await act(async () => {
    host.querySelector('details')!.open = true;
    host.querySelector('details')!.dispatchEvent(new Event('toggle'));
  });
  const service = host.querySelector<HTMLSelectElement>(
    '[aria-label="外部工具服务"]',
  )!;
  await act(async () => {
    service.value = 'fixture';
    service.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const checks = host.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  await act(async () => {
    checks[0].click();
    checks[2].click();
  });
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    `${base}/mcp/consents`,
    {
      server_id: 'fixture',
      configuration_digest: 'c'.repeat(64),
      tools: ['echo'],
      ttl_seconds: 900,
      confirmed_startup_and_restart: true,
      request_id: '11111111-1111-4111-8111-111111111111',
    },
    45000,
  );
  expect(mocks.acknowledge).toHaveBeenCalledOnce();
});

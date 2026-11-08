// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DurableSnapshot } from '../web/src/features/pocket/useDurableControl';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  owner: 'alice',
  handlers: new Map<string, (event?: unknown) => void>(),
}));
vi.mock('../web/src/api/client', () => ({ api: { get: mocks.get } }));
vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    on: (name: string, callback: (event?: unknown) => void) => {
      mocks.handlers.set(name, callback);
      return () => mocks.handlers.delete(name);
    },
  },
}));
vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (value: unknown) => unknown) =>
      select({ user: { id: mocks.owner } }),
    { getState: () => ({ user: { id: mocks.owner } }) },
  ),
}));
const { useDurableControl } =
  await import('../web/src/features/pocket/useDurableControl');
let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useDurableControl>;
const pending: {
  resolve: (value: DurableSnapshot) => void;
  reject: (error: Error) => void;
}[] = [];
const snapshot = (revision: number, epoch = 'one'): DurableSnapshot => ({
  epoch,
  revision,
  runtime: { session_id: 'session', revision },
  goal: null,
  executionState: 'active',
  approvals: [],
  live: {
    busy: true,
    taskId: 1,
    queue: [],
    queueDigest: 'digest',
    partialText: '',
    retrying: false,
    tools: [],
  },
});
function Probe({ session = 'session' }: { session?: string }) {
  current = useDurableControl('web:project', session, true);
  return null;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.owner = 'alice';
  mocks.get.mockReset();
  mocks.handlers.clear();
  pending.length = 0;
  mocks.get.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
test('ordered invalidations and a gap reconcile with full snapshots, never accept an older HTTP fence', async () => {
  await act(async () => {
    mocks.handlers.get('durable_session_update')?.({
      chatJid: 'web:project',
      agentId: 'session',
      epoch: 'one',
      revision: 8,
    });
    pending[0].resolve(snapshot(2));
  });
  expect(current.snapshot).toBeNull();
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1].resolve(snapshot(8));
  });
  expect(current.snapshot?.revision).toBe(8);
  await act(async () => {
    mocks.handlers.get('durable_session_update')?.({
      chatJid: 'web:project',
      agentId: 'session',
      epoch: 'one',
      revision: 3,
    });
    pending[2].resolve(snapshot(8));
  });
  expect(current.snapshot?.revision).toBe(8);
  expect(
    mocks.get.mock.calls.every(([url]) => String(url).endsWith('/runtime')),
  ).toBe(true);
});
test('disconnect and process epoch change discard a response already in flight', async () => {
  await act(async () => {
    mocks.handlers.get('disconnected')?.();
    mocks.handlers.get('connected')?.();
    pending[0].resolve(snapshot(99, 'old'));
  });
  expect(current.snapshot).toBeNull();
  await act(async () => {
    pending[1].resolve(snapshot(1, 'new'));
  });
  expect(current.snapshot?.epoch).toBe('new');
});
test('session and account changes discard private stale responses', async () => {
  await act(async () => {
    root.render(createElement(Probe, { session: 'other' }));
    pending[0].resolve(snapshot(9));
  });
  expect(current.snapshot).toBeNull();
  await act(async () => {
    mocks.owner = 'bob';
    root.render(createElement(Probe, { session: 'other' }));
    pending[1].resolve(snapshot(10));
  });
  expect(current.snapshot).toBeNull();
  await act(async () => {
    pending[2].reject(new Error('Denied'));
  });
  expect(current.snapshot).toBeNull();
  expect(current.error).toContain('不可用');
});

// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BotGroupSnapshot } from '../src/bot-groups/types';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  fetch: vi.fn(),
  owner: 'alice',
  handlers: new Map<string, (event?: unknown) => void>(),
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: mocks.get },
  apiFetch: mocks.fetch,
}));
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
    (select: (state: unknown) => unknown) =>
      select({ user: { id: mocks.owner } }),
    { getState: () => ({ user: { id: mocks.owner } }) },
  ),
}));
const { useBotGroup, useGroupCommand } =
  await import('../web/src/features/bot-groups/useBotGroup');
let root: Root,
  host: HTMLDivElement,
  current: ReturnType<typeof useBotGroup>,
  command: ReturnType<typeof useGroupCommand>;
let pending: {
  resolve: (value: BotGroupSnapshot) => void;
  reject: (failure: unknown) => void;
}[] = [];
function Probe({ id = 'group' }: { id?: string }) {
  current = useBotGroup(id);
  command = useGroupCommand(id);
  return null;
}
const snapshot = (
  revision: number,
  epoch = 'first',
  actor = 'alice',
): BotGroupSnapshot =>
  ({
    epoch,
    group: { id: 'group' },
    membership: { subject_id: actor },
    revision,
    last_seq: revision,
    messages: [],
    members: [],
    has_more: false,
  }) as BotGroupSnapshot;
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.owner = 'alice';
  mocks.get.mockReset();
  mocks.fetch.mockReset();
  mocks.handlers.clear();
  sessionStorage.clear();
  pending = [];
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
  await act(async () => root.unmount());
  host.remove();
});
test('revocation fences a previously authorized in-flight response before it can restore private state', async () => {
  await act(async () => {
    pending[0].resolve(snapshot(1));
  });
  expect(current.snapshot?.revision).toBe(1);
  await act(async () => {
    current.refresh();
  });
  await act(async () => {
    mocks.handlers.get('bot_group_access_revoked')?.({ groupId: 'group' });
    pending[1].resolve(snapshot(2));
  });
  expect(current.snapshot).toBeNull();
  expect(current.verified).toBe(false);
  expect(pending).toHaveLength(3);
  await act(async () => {
    pending[2].reject({ status: 404 });
  });
  expect(current.snapshot).toBeNull();
  expect(current.error).toContain('不可访问');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
test('gaps, reordered hints and process changes are repaired by snapshots without command replay', async () => {
  await act(async () => {
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      revision: 8,
      epoch: 'first',
    });
    pending[0].resolve(snapshot(2));
  });
  expect(current.snapshot).toBeNull();
  await act(async () => {
    pending[1].resolve(snapshot(8));
  });
  await act(async () => {
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      revision: 3,
      epoch: 'first',
    });
    pending[2].resolve(snapshot(8));
  });
  expect(current.snapshot?.revision).toBe(8);
  await act(async () => {
    current.refresh();
  });
  await act(async () => {
    mocks.handlers.get('disconnected')?.();
    mocks.handlers.get('connected')?.();
    pending[3].resolve(snapshot(99, 'old'));
  });
  expect(current.verified).toBe(false);
  await act(async () => {
    pending[4].resolve(snapshot(1, 'new'));
  });
  expect(current.snapshot?.epoch).toBe('new');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
test('account and Group changes fence stale private snapshots', async () => {
  await act(async () => {
    mocks.owner = 'bob';
    root.render(createElement(Probe, { id: 'other' }));
    pending[0].resolve(snapshot(9));
  });
  expect(current.snapshot).toBeNull();
  await act(async () => {
    pending[1].reject({ status: 404 });
  });
  expect(current.snapshot).toBeNull();
  expect(current.verified).toBe(false);
});
test('uncertain writes retain exact keys across reconnect/remount; synchronous duplicate clicks cannot create another command', async () => {
  mocks.fetch.mockRejectedValue({ status: 0, message: 'lost ACK' });
  await act(async () => {
    await Promise.all([
      command.submit('/api/bot-groups/group/messages', 'POST', {
        content: 'one',
      }),
      command.submit('/api/bot-groups/group/messages', 'POST', {
        content: 'two',
      }),
    ]);
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const original = mocks.fetch.mock.calls[0];
  expect(command.pending?.body).toEqual({ content: 'one' });
  await act(async () => {
    root.render(null);
  });
  await act(async () => {
    root.render(createElement(Probe));
    mocks.handlers.get('connected')?.();
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(command.pending?.body).toEqual({ content: 'one' });
  const requestId = command.pending!.requestId;
  mocks.fetch.mockResolvedValue({
    receipt: { request_id: requestId, group_id: 'group', replayed: true },
    snapshot: snapshot(2),
  });
  await act(async () => {
    await command.retry();
  });
  expect(mocks.fetch.mock.calls[1]).toEqual(original);
  expect(command.pending).toBeNull();
});

test('mismatched or uncertain receipt checkpoints do not clear the original pending command', async () => {
  mocks.fetch.mockResolvedValue({
    receipt: { request_id: 'other-request', group_id: 'group' },
    snapshot: snapshot(2),
  });
  await act(async () => {
    await command.submit('/api/bot-groups/group/messages', 'POST', {
      content: 'Needs trustworthy ACK',
    });
  });
  const original = command.pending;
  expect(original?.requestId).toBeTruthy();
  mocks.fetch.mockRejectedValue({
    status: 409,
    body: { code: 'BOT_GROUP_RECEIPT_CHECKPOINT_CONFLICT' },
  });
  await act(async () => {
    await command.retry();
  });
  expect(command.pending).toEqual(original);
  expect(command.error).toContain('尚未确认');
});

test('a browser storage failure prevents sending an untraceable command', async () => {
  const denied = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  try {
    await act(async () => {
      await command.submit('/api/bot-groups/group/messages', 'POST', {
        content: 'Not sent',
      });
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(command.pending).toBeNull();
    expect(command.error).toContain('尚未发送');
  } finally {
    denied.mockRestore();
  }
});

test('same-epoch message/progress refresh cannot disable an authorized send gesture; configuration and epoch changes still require verification', async () => {
  await act(async () => pending[0].resolve(snapshot(1)));
  expect(current.verified).toBe(true);
  await act(async () =>
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      epoch: 'first',
      operation: 'post_message',
    }),
  );
  expect(current.verified).toBe(true);
  expect(current.refreshing).toBe(true);
  // Continuous ordinary hints still allow an in-flight authorized snapshot to
  // advance; its follow-up read then catches the latest invalidation.
  await act(async () =>
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      epoch: 'first',
      operation: 'post_message',
    }),
  );
  await act(async () => pending[1].resolve(snapshot(2)));
  expect(current.snapshot?.revision).toBe(2);
  expect(current.refreshing).toBe(true);
  await act(async () => pending[2].resolve(snapshot(2)));
  expect(current.refreshing).toBe(false);
  await act(async () =>
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      epoch: 'first',
      operation: 'bot_handoff_progress',
    }),
  );
  expect(current.verified).toBe(true);
  await act(async () => pending[3].resolve(snapshot(3)));
  await act(async () =>
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      epoch: 'first',
      operation: 'grant_bot_runtime',
    }),
  );
  expect(current.verified).toBe(false);
  await act(async () => pending[4].resolve(snapshot(4)));
  await act(async () =>
    mocks.handlers.get('bot_group_update')?.({
      groupId: 'group',
      epoch: 'replacement-process',
      operation: 'post_message',
    }),
  );
  expect(current.verified).toBe(false);
  await act(async () => pending[5].reject({ status: 404 }));
  expect(current.snapshot).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test.each([
  ['BOT_HANDOFF_RUNTIME_DISABLED', '尚未开启群聊对话'],
  ['BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE', '模型或对话配置未就绪'],
  ['GROUP_MEMBER_INBOX_LIMIT', '请停止本轮'],
  ['GROUP_MEMBER_MESSAGE_LIMIT', '这次提问内容过长'],
  ['GROUP_MEMBER_CONTEXT_LIMIT', '需要读取的内容过长'],
  ['GROUP_MEMBER_RESULT_LIMIT', '回复超过本次协作的长度上限'],
  [
    'GROUP_DISCUSSION_DEVICE_REQUIRES_GOAL',
    '设备文件权限仅用于已授权的工作任务',
  ],
])(
  'confirmed configuration rejection %s explains the cause and permits correction',
  async (code, message) => {
    mocks.fetch.mockRejectedValue({ status: 409, body: { code } });
    await act(async () => {
      await command.submit(
        '/api/bot-groups/group/members/bot/runtime-grants',
        'POST',
        { runtime_kind: 'node-durable' },
      );
    });
    expect(command.pending).toBeNull();
    expect(command.busy).toBe(false);
    expect(command.error).toContain(message);
    mocks.fetch.mockImplementation(
      async (_url: string, options: { headers: Record<string, string> }) => ({
        receipt: {
          request_id: options.headers['Idempotency-Key'],
          group_id: 'group',
        },
        snapshot: snapshot(2),
      }),
    );
    await act(async () => {
      await command.submit('/api/bot-groups/group', 'PATCH', {
        name: 'Corrected',
      });
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(command.pending).toBeNull();
    expect(command.error).toBe('');
  },
);

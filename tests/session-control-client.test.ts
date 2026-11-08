// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  owner: 'alice',
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: { id: mocks.owner } }) },
}));
const { abortDurableSession } = await import('../web/src/api/session-control');
const receipts = await import('../web/src/utils/session-control-receipts');
const digest = 'a'.repeat(64);
beforeEach(() => {
  sessionStorage.clear();
  mocks.owner = 'alice';
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockResolvedValue({
    live: { busy: true, taskId: 42, queueDigest: digest },
  });
});
test('lost Stop response retries its exact task and request key even after a later run starts', async () => {
  mocks.post.mockRejectedValueOnce(new Error('Response lost'));
  await expect(abortDurableSession('web:project', 'session')).rejects.toThrow(
    'lost',
  );
  const original = receipts.readSessionControl('alice', 'session');
  expect(original?.command).toEqual({
    action: 'abort',
    taskId: 42,
    expectedQueueDigest: digest,
  });
  mocks.get.mockResolvedValue({
    live: { busy: true, taskId: 99, queueDigest: digest },
  });
  mocks.post.mockResolvedValueOnce({ control: { state: 'applied' } });
  expect(await abortDurableSession('web:project', 'session')).toEqual({
    success: true,
    interrupted: true,
  });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[1][1]).toEqual(mocks.post.mock.calls[0][1]);
  expect(receipts.readSessionControl('alice', 'session')).toBeNull();
});
test('Stop cannot overwrite an unacknowledged queue edit', async () => {
  receipts.saveSessionControl('alice', 'session', {
    requestId: 'edit-original',
    command: {
      action: 'edit',
      submissionId: 7,
      content: 'private draft',
      expectedQueueDigest: digest,
    },
  });
  await expect(abortDurableSession('web:project', 'session')).rejects.toThrow(
    '队列操作',
  );
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(receipts.readSessionControl('alice', 'session')?.requestId).toBe(
    'edit-original',
  );
});
test('a rejected stale task never automatically targets the new run', async () => {
  mocks.post.mockResolvedValueOnce({ control: { state: 'rejected' } });
  await expect(abortDurableSession('web:project', 'session')).rejects.toThrow(
    '执行已变化',
  );
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(receipts.readSessionControl('alice', 'session')).toBeNull();
});
test('account changes during a snapshot or response cannot acknowledge another identity', async () => {
  mocks.get.mockImplementationOnce(async () => {
    mocks.owner = 'bob';
    return { live: { busy: true, taskId: 42, queueDigest: digest } };
  });
  await expect(abortDurableSession('web:project', 'session')).rejects.toThrow(
    '登录状态',
  );
  expect(mocks.post).not.toHaveBeenCalled();
  mocks.owner = 'alice';
  mocks.post.mockImplementationOnce(async () => {
    mocks.owner = 'bob';
    return { control: { state: 'applied' } };
  });
  await expect(abortDurableSession('web:project', 'session')).rejects.toThrow(
    '登录状态',
  );
  expect(receipts.readSessionControl('alice', 'session')).not.toBeNull();
  expect(receipts.readSessionControl('bob', 'session')).toBeNull();
});

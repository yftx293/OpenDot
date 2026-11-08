import { describe, expect, test, vi } from 'vitest';

import { GroupQueue } from '../src/group-queue.js';
import {
  DEFAULT_STOP_GRACE_MS,
  assessRunningQueryHealth,
} from '../src/run-health.js';

const TIMEOUT = 5 * 60 * 1000;

describe('running query health', () => {
  test('healthy while output keeps arriving', () => {
    expect(
      assessRunningQueryHealth({
        queryInFlight: true,
        active: true,
        lastActivityAt: 1_000,
        now: 1_000 + TIMEOUT - 1,
        progressTimeoutMs: TIMEOUT,
        processExited: false,
      }),
    ).toMatchObject({ status: 'healthy', message: null });
  });

  test('process exit is reported immediately as an abnormal exit', () => {
    const health = assessRunningQueryHealth({
      queryInFlight: true,
      active: true,
      lastActivityAt: 1_000,
      now: 2_000,
      progressTimeoutMs: TIMEOUT,
      processExited: true,
    });
    expect(health.status).toBe('exited');
    expect(health.message).toContain('异常退出');
  });

  test('silence beyond the progress budget is a stall', () => {
    const health = assessRunningQueryHealth({
      queryInFlight: true,
      active: true,
      lastActivityAt: 1_000,
      now: 1_000 + TIMEOUT,
      progressTimeoutMs: TIMEOUT,
      processExited: false,
    });
    expect(health.status).toBe('stalled');
    expect(health.message).toContain('长时间无响应');
  });

  test('idle or stopped runs are never reported', () => {
    const base = {
      active: true,
      lastActivityAt: 1_000,
      now: 1_000 + TIMEOUT,
      progressTimeoutMs: TIMEOUT,
      processExited: false,
    };
    expect(
      assessRunningQueryHealth({ ...base, queryInFlight: false }).status,
    ).toBe('healthy');
    expect(
      assessRunningQueryHealth({
        ...base,
        queryInFlight: true,
        stopRequested: true,
      }).status,
    ).toBe('healthy');
  });

  test('a stop that never completes stops suppressing the watchdog', () => {
    const base = {
      active: true,
      queryInFlight: true,
      lastActivityAt: 1_000,
      now: 1_000 + TIMEOUT,
      progressTimeoutMs: TIMEOUT,
      processExited: false,
      stopRequested: true,
    };
    expect(
      assessRunningQueryHealth({
        ...base,
        stopRequestedAt: base.now - DEFAULT_STOP_GRACE_MS + 1,
      }).status,
    ).toBe('healthy');
    expect(
      assessRunningQueryHealth({
        ...base,
        stopRequestedAt: base.now - DEFAULT_STOP_GRACE_MS,
      }).status,
    ).toBe('stalled');
  });
});

function seedRunner(
  queue: GroupQueue,
  jid: string,
  opts: {
    queryInFlight: boolean;
    lastActivityAt: number | null;
    processExited?: boolean;
    stopRequested?: boolean;
    stopRequestedAt?: number | null;
    unhealthyStopAttempts?: number;
  },
) {
  const state = {
    mutationKey: null,
    stopRequested: opts.stopRequested ?? false,
    stopRequestedAt: opts.stopRequestedAt ?? null,
    unhealthyStopAttempts: opts.unhealthyStopAttempts ?? 0,
    abandonedRunnerGenerations: new Set<number>(),
    terminalFailureReason: null,
    teardownWaiters: new Set(),
    active: true,
    runnerGeneration: 3,
    runnerRuntime: 'container',
    activeRunnerIsTask: false,
    activeTask: null,
    lastActivityAt: opts.lastActivityAt,
    queryInFlight: opts.queryInFlight,
    queryId: opts.queryInFlight ? 'query-3' : null,
    queryStartedAt: Date.now(),
    announcedQueryId: opts.queryInFlight ? 'query-3' : null,
    pendingMessages: false,
    pendingTasks: [],
    process: opts.processExited
      ? { exitCode: 1, signalCode: null, killed: false }
      : null,
    containerName: null,
    displayName: null,
    groupFolder: 'health',
    agentId: null,
    taskRunId: null,
    retryCount: 0,
    retryTimer: null,
    retryTask: null,
    messageRetrySnapshot: null,
    restarting: false,
    selectedProviderId: null,
    feishuCliAccountId: null,
    drainSentinelWritten: false,
    hasIpcInjectedMessages: false,
    ipcOwedSinceAt: null,
    pendingIpcDeliveries: new Map(),
    acknowledgedIpcDeliveryIds: new Set(),
  };
  const internals = queue as unknown as {
    groups: Map<string, Record<string, unknown>>;
  };
  internals.groups.set(jid, state);
  return state;
}

test('GroupQueue reports only announced runs that stopped progressing', () => {
  const queue = new GroupQueue();
  const unhealthyJid = 'web:stalled';
  const healthyJid = 'web:healthy';
  seedRunner(queue, unhealthyJid, {
    queryInFlight: true,
    lastActivityAt: Date.now() - TIMEOUT - 1_000,
  });
  seedRunner(queue, healthyJid, {
    queryInFlight: true,
    lastActivityAt: Date.now(),
  });
  const candidates = queue.getUnhealthyQueryGroups(TIMEOUT);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    jid: unhealthyJid,
    queryId: 'query-3',
    status: 'stalled',
  });
});

test('GroupQueue fails the exact attempt once and forces its runner down', () => {
  const queue = new GroupQueue();
  const jid = 'web:exited';
  const state = seedRunner(queue, jid, {
    queryInFlight: true,
    lastActivityAt: Date.now(),
    processExited: true,
  });
  const stop = vi.spyOn(queue, 'stopGroup').mockResolvedValue(undefined);
  const [candidate] = queue.getUnhealthyQueryGroups(TIMEOUT);
  expect(candidate.status).toBe('exited');
  expect(queue.failUnhealthyQuery(candidate)).toBe(true);
  expect(state.terminalFailureReason).toContain('异常退出');
  expect(stop).toHaveBeenCalledWith(jid, { force: true });
  expect(queue.failUnhealthyQuery(candidate)).toBe(false);
});

test('GroupQueue retries a failed stop before abandoning the attempt', async () => {
  const queue = new GroupQueue();
  const jid = 'web:paused-retry';
  const now = Date.now();
  const state = seedRunner(queue, jid, {
    queryInFlight: true,
    lastActivityAt: now - TIMEOUT - 1_000,
    stopRequested: true,
    stopRequestedAt: now - DEFAULT_STOP_GRACE_MS - 1,
    unhealthyStopAttempts: 0,
  });
  const stop = vi
    .spyOn(queue, 'stopGroup')
    .mockRejectedValue(new Error('container is paused'));

  const candidate = queue
    .getUnhealthyQueryGroups(TIMEOUT)
    .find((entry) => entry.jid === jid);
  expect(candidate).toBeDefined();
  expect(queue.failUnhealthyQuery(candidate!)).toBe(true);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledWith(jid, { force: true });
  expect(state.unhealthyStopAttempts).toBe(1);
  expect(state.active).toBe(true);
  // The retry gets its own grace window; the watchdog leaves it alone.
  expect(
    queue.getUnhealthyQueryGroups(TIMEOUT).find((entry) => entry.jid === jid),
  ).toBeUndefined();
});

test('GroupQueue force-abandons a runner that still cannot be killed', () => {
  const queue = new GroupQueue();
  const jid = 'web:paused-abandon';
  const now = Date.now();
  const state = seedRunner(queue, jid, {
    queryInFlight: true,
    lastActivityAt: now - TIMEOUT - 1_000,
    stopRequested: true,
    stopRequestedAt: now - DEFAULT_STOP_GRACE_MS - 1,
    unhealthyStopAttempts: 1,
  });
  const finished = vi.fn();
  queue.setOnQueryFinish(finished);
  const stop = vi.spyOn(queue, 'stopGroup');

  const candidate = queue
    .getUnhealthyQueryGroups(TIMEOUT)
    .find((entry) => entry.jid === jid);
  expect(candidate).toBeDefined();
  expect(queue.failUnhealthyQuery(candidate!)).toBe(true);
  expect(stop).not.toHaveBeenCalled();
  expect(state.active).toBe(false);
  expect(state.queryInFlight).toBe(false);
  expect(state.queryId).toBeNull();
  expect(state.containerName).toBeNull();
  expect(
    (
      state as unknown as { abandonedRunnerGenerations: Set<number> }
    ).abandonedRunnerGenerations.has(3),
  ).toBe(true);
  expect(finished).toHaveBeenCalledWith(
    jid,
    'query-3',
    'failed',
    expect.any(Number),
    expect.stringContaining('长时间无响应'),
  );
});

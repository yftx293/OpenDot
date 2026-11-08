import { expect, test } from 'vitest';
import {
  activeExecutionMs,
  durableBudgetExceededMessage,
  durableExecutionBudgetMs,
  durableIncompleteAnswer,
  executionBudgetExhausted,
  humanWaitMs,
} from '../src/personal-agent/durable-execution-budget.js';
import {
  applyDurableProgress,
  durableProgressFromLive,
  retainDurableView,
} from '../src/personal-agent/durable-progress.js';
import {
  classifyComputerError,
  computerAllowanceMatches,
  maskSensitiveComputerArguments,
  shouldAutoApproveComputerCall,
} from '../src/personal-agent/computer-approval-policy.js';
import { mcpWaitVerdict } from '../src/personal-agent/mcp-wait-budget.js';
import {
  productNavActive,
  workRailPath,
} from '../web/src/components/layout/nav-routing.ts';
import {
  durableInputNeedsAction,
  durableStatusLine,
} from '../web/src/features/pocket/durable-status-copy.ts';
import { applyDurableProgress as applyClientProgress } from '../web/src/features/pocket/durable-progress-client.ts';
import {
  classifyDurableFailure,
  durableFailureAnswer,
  sanitizeRuntimeFailureText,
} from '../src/personal-agent/durable-failure.js';
import {
  detectDurableRunStall,
  durableProgressTimeoutMs,
} from '../src/personal-agent/durable-run-health.js';
import { resolveSnapshotExecutionState } from '../src/personal-agent/product-execution-state.js';

const minute = 60_000;

test('execution budget ignores queue time and human approval waits', () => {
  const started = 1_000_000;
  const now = started + 40 * minute;
  const queued = activeExecutionMs(
    { state: 'admitted', executionStartedAtMs: null },
    [],
    now,
  );
  expect(queued).toBe(0);
  const waits = [
    { startedAtMs: started + 5 * minute, endedAtMs: started + 25 * minute },
  ];
  expect(humanWaitMs(waits, started, now)).toBe(20 * minute);
  expect(
    activeExecutionMs(
      { state: 'submitted', executionStartedAtMs: started },
      waits,
      now,
    ),
  ).toBe(20 * minute);
  expect(
    executionBudgetExhausted(
      [{ state: 'submitted', executionStartedAtMs: started }],
      waits,
      now,
      30 * minute,
    ),
  ).toBe(false);
  expect(
    executionBudgetExhausted(
      [{ state: 'submitted', executionStartedAtMs: started }],
      [],
      now,
      30 * minute,
    ),
  ).toBe(true);
  expect(durableExecutionBudgetMs(30 * minute, '600000')).toBe(10 * minute);
  expect(durableExecutionBudgetMs(30 * minute, 'nope')).toBe(30 * minute);
});

test('incomplete durable answers name the reason in Chinese and offer continue', () => {
  expect(durableBudgetExceededMessage()).toContain('继续');
  expect(
    durableIncompleteAnswer('Durable execution duration budget exhausted'),
  ).toContain('超时');
  expect(durableIncompleteAnswer('approval pending')).toContain('确认');
  expect(durableIncompleteAnswer(null)).toContain('重试');
  expect(durableIncompleteAnswer('blocked')).not.toMatch(/[A-Za-z]{12,}/);
});

test('provider failures are sanitized, classified and shown instead of a generic interruption', () => {
  const detail =
    'HTTP 403: model not available in your country (Authorization: Bearer sk-secret123456)';
  const sanitized = sanitizeRuntimeFailureText(detail);
  expect(sanitized).toContain('403');
  expect(sanitized).toContain('model not available in your country');
  expect(sanitized).not.toContain('sk-secret123456');
  expect(sanitized).not.toContain('Bearer sk-');

  const failure = classifyDurableFailure('model_error', detail);
  expect(failure.status).toBe(403);
  expect(failure.retryable).toBe(false);
  expect(failure.hint).toContain('模型');
  expect(durableFailureAnswer(failure)).toContain('HTTP 403');
  expect(durableFailureAnswer(failure)).toContain(
    'model not available in your country',
  );
  expect(durableIncompleteAnswer('model_error', detail)).toContain('403');
  expect(durableIncompleteAnswer('model_error', detail)).not.toContain('继续');

  expect(
    classifyDurableFailure('model_error', 'HTTP 500: provider internal error')
      .retryable,
  ).toBe(true);
  expect(
    classifyDurableFailure('model_error', 'HTTP 503: provider unavailable')
      .retryable,
  ).toBe(true);
  expect(
    classifyDurableFailure('model_error', 'HTTP 429: rate limit exceeded')
      .retryable,
  ).toBe(true);
  expect(classifyDurableFailure('no_model', null).retryable).toBe(false);
  expect(classifyDurableFailure('aborted', null).kind).toBe('aborted');
});

test('failed runs stop showing an in-progress line even before the next snapshot', () => {
  const snapshot = {
    executionState: 'active',
    live: {
      busy: true,
      partialText: '',
      retrying: false,
      tools: [],
      queue: [],
    },
  };
  const idle = {
    executionState: 'idle',
    busy: false,
    partialText: '',
    currentTool: null,
    toolStatus: null,
    retrying: false,
    pendingApprovals: 0,
    failure: null,
  };
  expect(applyDurableProgress(snapshot, idle)?.executionState).toBe('idle');
  expect(applyClientProgress(snapshot, idle)?.executionState).toBe('idle');

  const failure = classifyDurableFailure('model_error', 'HTTP 403 forbidden');
  const failed = { ...idle, executionState: 'failed', failure };
  expect(applyDurableProgress(snapshot, failed)?.executionState).toBe('failed');
  expect(applyClientProgress(snapshot, failed)?.failure).toEqual(failure);
  expect(
    durableStatusLine({
      dotName: 'Mini',
      executionState: 'failed',
      busy: false,
    }),
  ).toBe('Mini · 没有完成');
});

test('durable progress watchdog fails a run with no progress', () => {
  const timeout = durableProgressTimeoutMs('60000');
  expect(timeout).toBe(60_000);
  expect(durableProgressTimeoutMs('nope')).toBe(5 * 60 * 1000);
  expect(
    detectDurableRunStall({
      running: true,
      lastProgressAt: 1_000,
      now: 30_000,
      timeoutMs: timeout,
    }),
  ).toBeNull();
  const stall = detectDurableRunStall({
    running: true,
    lastProgressAt: 1_000,
    now: 100_000,
    timeoutMs: timeout,
  });
  expect(stall?.message).toContain('长时间无响应');
  expect(
    detectDurableRunStall({
      running: false,
      lastProgressAt: 1_000,
      now: 100_000,
      timeoutMs: timeout,
    }),
  ).toBeNull();
});

test('durable progress keeps the last view and applies a live hint', () => {
  const previous = {
    executionState: 'active',
    live: {
      busy: true,
      partialText: '已经写了一半',
      retrying: false,
      tools: [{ callId: 'a', name: 'list_windows', status: 'running' }],
      queue: [],
    },
  };
  expect(retainDurableView(previous, null)).toBe(previous);
  const progress = durableProgressFromLive(
    {
      busy: true,
      partialText: '继续写',
      retrying: false,
      tools: [{ name: 'observe_window', status: 'running' }],
      queueLength: 0,
    },
    1,
  );
  expect(progress.executionState).toBe('waiting_for_approval');
  const next = applyDurableProgress(previous, progress);
  expect(next?.live?.partialText).toBe('继续写');
  expect(next?.executionState).toBe('waiting_for_approval');
  expect(applyClientProgress(previous, progress)?.live?.tools[0]?.name).toBe(
    'observe_window',
  );
});

test('read-only computer calls skip a click; mutating calls need an allowance', () => {
  const now = 1_000;
  expect(
    shouldAutoApproveComputerCall({
      toolName: 'list_windows',
      serverId: 'opendot_computer_abc',
      args: {},
      allowances: [],
      now,
    }),
  ).toBe(true);
  expect(
    shouldAutoApproveComputerCall({
      toolName: 'observe_window',
      serverId: 'opendot_computer_abc',
      args: {},
      allowances: [],
      now,
      requireReadApproval: true,
    }),
  ).toBe(false);
  expect(
    shouldAutoApproveComputerCall({
      toolName: 'act_on_window',
      serverId: 'opendot_computer_abc',
      args: { label: 'Safari — Inbox' },
      allowances: [],
      now,
    }),
  ).toBe(false);
  expect(
    shouldAutoApproveComputerCall({
      toolName: 'act_on_window',
      serverId: 'opendot_computer_abc',
      args: { label: 'Safari — Inbox' },
      allowances: [
        { serverId: 'opendot_computer_abc', appKey: '*', expiresAt: now + 10 },
      ],
      now,
    }),
  ).toBe(true);
  expect(
    computerAllowanceMatches(
      [
        {
          serverId: 'opendot_computer_abc',
          appKey: 'Safari',
          expiresAt: now + 10,
        },
      ],
      { serverId: 'opendot_computer_abc', appKey: 'Mail', now },
    ),
  ).toBe(false);
});

test('typed computer errors and password masking', () => {
  expect(
    classifyComputerError(new Error('Window label changed; list windows again'))
      .code,
  ).toBe('window_gone');
  expect(
    classifyComputerError(
      new Error('Element description changed; observe again'),
    ).code,
  ).toBe('stale_snapshot');
  expect(
    classifyComputerError(new Error('Desktop app outside authorization')).code,
  ).toBe('permission_denied');
  expect(classifyComputerError(new Error('operation timed out')).code).toBe(
    'timeout',
  );
  expect(
    classifyComputerError(new Error('The application is not running')).code,
  ).toBe('app_not_running');
  expect(
    classifyComputerError(new Error('Computer operation unavailable')).message,
  ).toContain('list_windows');
  const masked = maskSensitiveComputerArguments({
    action: 'set_value',
    element: 'AXSecureTextField 密码',
    value: 'hunter2',
  });
  expect(masked.value).toBe('••••••');
  expect(
    maskSensitiveComputerArguments({
      action: 'set_value',
      element: 'AXTextField 标题',
      value: '公开',
    }).value,
  ).toBe('公开');
});

test('approval wait does not consume the computer execution budget', () => {
  const start = 0;
  expect(
    mcpWaitVerdict({
      state: 'pending',
      now: 110_000,
      approvalStartedAt: start,
      executionStartedAt: null,
      approvalWaitMs: 30 * minute,
      executionBudgetMs: 120_000,
    }),
  ).toBe('ok');
  expect(
    mcpWaitVerdict({
      state: 'dispatching',
      now: 200_000,
      approvalStartedAt: start,
      executionStartedAt: 100_000,
      executionBudgetMs: 120_000,
    }),
  ).toBe('ok');
  expect(
    mcpWaitVerdict({
      state: 'dispatching',
      now: 230_000,
      approvalStartedAt: start,
      executionStartedAt: 100_000,
      executionBudgetMs: 120_000,
    }),
  ).toBe('execution_timeout');
  expect(
    mcpWaitVerdict({
      state: 'pending',
      now: 31 * minute,
      approvalStartedAt: start,
      executionStartedAt: null,
    }),
  ).toBe('approval_timeout');
});

test('work rail items do not light up together when goals are off', () => {
  expect(workRailPath(false, 'work')).toBe('/tasks');
  expect(workRailPath(false, 'attention')).toBe('/tasks?view=attention');
  expect(workRailPath(true, 'attention')).toBe('/goals?view=attention');
  expect(productNavActive('/tasks', '/tasks', '?view=attention')).toBe(false);
  expect(
    productNavActive('/tasks?view=attention', '/tasks', '?view=attention'),
  ).toBe(true);
  expect(productNavActive('/tasks', '/tasks', '')).toBe(true);
  expect(productNavActive('/goals', '/goals', '?view=attention')).toBe(false);
  expect(
    durableStatusLine({
      dotName: 'Mini',
      executionState: 'active',
      busy: true,
      currentTool: 'mcp__opendot_computer__list_windows',
    }),
  ).toBe('Mini · 正在查看窗口');
  expect(
    durableStatusLine({
      dotName: 'Mini',
      executionState: 'waiting_for_approval',
      pendingApprovals: 1,
    }),
  ).toBe('Mini · 等你确认');
  expect(durableInputNeedsAction({ state: 'failed' })).toBe(true);
  expect(durableInputNeedsAction({ state: 'completed' })).toBe(false);
});

test('a settled snapshot is idle, not active, after a successful run', () => {
  const settled = {
    botPausedState: null,
    waiting: false,
    goalStatus: null,
    remote: null,
    hasTerminalFailure: false,
    activeInput: false,
    busy: false,
  };
  expect(resolveSnapshotExecutionState(settled)).toBe('idle');

  // A completed input whose live turn already ended must not look busy.
  expect(
    resolveSnapshotExecutionState({
      ...settled,
      remote: { state: 'active', deadlineExceeded: false },
    }),
  ).toBe('idle');

  expect(
    resolveSnapshotExecutionState({
      ...settled,
      activeInput: true,
      busy: true,
    }),
  ).toBe('active');
  expect(resolveSnapshotExecutionState({ ...settled, activeInput: true })).toBe(
    'active',
  );
  expect(resolveSnapshotExecutionState({ ...settled, busy: true })).toBe(
    'active',
  );
  expect(
    resolveSnapshotExecutionState({
      ...settled,
      hasTerminalFailure: true,
    }),
  ).toBe('failed');
  expect(
    resolveSnapshotExecutionState({
      ...settled,
      remote: { state: 'suspended', deadlineExceeded: true },
    }),
  ).toBe('suspended');
  expect(
    resolveSnapshotExecutionState({
      ...settled,
      botPausedState: 'paused',
    }),
  ).toBe('paused');
  expect(
    resolveSnapshotExecutionState({
      ...settled,
      waiting: true,
      goalStatus: 'completed',
    }),
  ).toBe('completed');
});

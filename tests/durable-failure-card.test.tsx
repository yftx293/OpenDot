// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DurableFailure } from '../web/src/features/pocket/durable-progress-client';

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  progress: null as unknown,
}));
vi.mock('../web/src/features/pocket/useDurableControl', () => ({
  useDurableControl: () => ({
    snapshot: state.snapshot,
    progress: state.progress,
    reconnecting: false,
  }),
}));
vi.mock('../web/src/features/pocket/ComputerApprovals', () => ({
  ComputerApprovals: () => null,
}));
vi.mock('../web/src/features/pocket/DurableApprovals', () => ({
  DurableApprovals: () => null,
}));

const { DurableInlineStatus } =
  await import('../web/src/features/pocket/DurableInlineStatus');

const failure403: DurableFailure = {
  kind: 'provider',
  status: 403,
  message: 'model not available in your country',
  retryable: false,
  hint: '请检查模型配置、服务地区或网络设置后再试。',
};

function snapshot(failure: DurableFailure | null, busy = false) {
  return {
    epoch: 'epoch',
    revision: 1,
    runtime: { session_id: 'session', revision: 1 },
    goal: null,
    executionState: busy ? 'active' : 'failed',
    failure,
    approvals: [],
    mcp_approvals: [],
    inputs: [
      {
        state: busy ? 'submitted' : 'failed',
        failure: busy ? null : failure,
      },
    ],
    live: {
      busy,
      taskId: null,
      queue: [],
      queueDigest: '',
      partialText: '',
      retrying: false,
      tools: [],
    },
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render() {
  const onContinue = vi.fn();
  const onRetry = vi.fn();
  act(() =>
    root.render(
      createElement(DurableInlineStatus, {
        jid: 'web:project',
        sessionId: 'session',
        dotName: 'Mini',
        onContinue,
        onRetry,
      }),
    ),
  );
  return { onContinue, onRetry };
}

test('non-retryable provider failure shows the cause and settings action only', () => {
  state.snapshot = snapshot(failure403);
  state.progress = null;
  render();
  expect(host.textContent).toContain('HTTP 403');
  expect(host.textContent).toContain('model not available in your country');
  expect(host.textContent).toContain('请检查模型配置');
  expect(host.textContent).toContain('检查模型设置');
  expect(host.textContent).not.toContain('继续');
  expect(host.textContent).not.toContain('重试');
  expect(host.textContent).not.toContain('正在处理');
  expect(host.textContent).toContain('没有完成');
});

test('retryable failure keeps retry actions', () => {
  state.snapshot = snapshot({
    ...failure403,
    status: 503,
    message: 'provider unavailable',
    retryable: true,
    hint: '可以稍后发送「重试」，或检查网络后重新发送上一条。',
  });
  state.progress = null;
  render();
  expect(host.textContent).toContain('继续');
  expect(host.textContent).toContain('重试');
  expect(host.textContent).not.toContain('检查模型设置');
});

test('a newly running input hides the previous failure card and actions', () => {
  state.snapshot = snapshot(failure403, true);
  state.progress = null;
  render();
  expect(host.querySelector('[data-durable-failure]')).toBeNull();
  expect(host.textContent).not.toContain('HTTP 403');
  expect(host.textContent).not.toContain('检查模型设置');
  expect(host.textContent).not.toContain('继续');
});

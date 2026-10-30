/** Active durable execution time. Queue wait and human approval wait do not count. */

import {
  classifyDurableFailure,
  durableFailureAnswer,
} from './durable-failure.js';

export const DEFAULT_DURABLE_EXECUTION_BUDGET_MS = 30 * 60 * 1000;
const MIN_BUDGET_MS = 1000;
const MAX_BUDGET_MS = 24 * 60 * 60 * 1000;

export type ExecutionClock = {
  /** Admitted inputs are still queued and have not started. */
  state: 'admitted' | 'submitted' | 'completed' | 'failed';
  /** Wall time when execution actually started. Null while queued. */
  executionStartedAtMs: number | null;
};

export type HumanWait = {
  startedAtMs: number;
  /** Null while the person has not decided. */
  endedAtMs: number | null;
};

export function durableExecutionBudgetMs(
  containerTimeoutMs: number,
  envValue?: string,
): number {
  const parsed = Number(envValue);
  if (
    Number.isFinite(parsed) &&
    parsed >= MIN_BUDGET_MS &&
    parsed <= MAX_BUDGET_MS
  )
    return parsed;
  if (
    Number.isFinite(containerTimeoutMs) &&
    containerTimeoutMs >= MIN_BUDGET_MS &&
    containerTimeoutMs <= MAX_BUDGET_MS
  )
    return containerTimeoutMs;
  return DEFAULT_DURABLE_EXECUTION_BUDGET_MS;
}

/** Merged overlap of human waits inside [rangeStart, rangeEnd). */
export function humanWaitMs(
  waits: readonly HumanWait[],
  rangeStart: number,
  rangeEnd: number,
): number {
  if (!(rangeEnd > rangeStart)) return 0;
  const clipped = waits
    .map((wait) => ({
      start: Math.max(wait.startedAtMs, rangeStart),
      end: Math.min(wait.endedAtMs ?? rangeEnd, rangeEnd),
    }))
    .filter((wait) => Number.isFinite(wait.start) && wait.end > wait.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = rangeStart;
  for (const wait of clipped) {
    const start = Math.max(wait.start, cursor);
    if (wait.end > start) {
      total += wait.end - start;
      cursor = wait.end;
    }
  }
  return total;
}

export function activeExecutionMs(
  input: ExecutionClock,
  waits: readonly HumanWait[],
  now: number,
): number {
  if (input.state === 'admitted' || input.executionStartedAtMs == null)
    return 0;
  if (!Number.isFinite(input.executionStartedAtMs) || !Number.isFinite(now))
    return Number.POSITIVE_INFINITY;
  if (now <= input.executionStartedAtMs) return 0;
  const paused = humanWaitMs(waits, input.executionStartedAtMs, now);
  return Math.max(0, now - input.executionStartedAtMs - paused);
}

export function executionBudgetExhausted(
  inputs: readonly ExecutionClock[],
  waits: readonly HumanWait[],
  now: number,
  budgetMs: number,
): boolean {
  return inputs.some(
    (input) =>
      (input.state === 'admitted' || input.state === 'submitted') &&
      activeExecutionMs(input, waits, now) > budgetMs,
  );
}

export function durableBudgetExceededMessage(): string {
  return '这项工作超时了：实际执行超过了时间上限。排队等待和等你确认的时间没有计入。可以在对话里发送「继续」接着做，或重新发送上一条来重试。';
}

export function durableIncompleteAnswer(
  reason: string | null | undefined,
  detail?: unknown,
): string {
  const text = (reason ?? '').trim();
  if (
    /budget|timeout|timed out|时长/i.test(text) ||
    text.includes('时间上限') ||
    text.includes('超时')
  )
    return durableBudgetExceededMessage();
  if (/approval|批准|等你确认/i.test(text))
    return '这项工作停住了，因为还在等你确认。确认之后可以在对话里发送「继续」。';
  if (/block|permission|revok|阻断/i.test(text))
    return '这项工作被阻断了，需要先核对。核对之后可以在对话里发送「继续」，或重新发送上一条来重试。';
  // Provider/runtime terminals carry the real cause. Keep it short and
  // sanitized, and do not suggest 「继续」 when repeating cannot help.
  if (text || (detail !== undefined && detail !== null))
    return durableFailureAnswer(classifyDurableFailure(text, detail));
  return '这项工作没有完成。原因：执行中断，没有写出完整结果。可以在对话里发送「继续」接着做，或重新发送上一条来重试。';
}

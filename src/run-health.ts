/**
 * Runner progress watchdog for an announced logical query.
 *
 * A container/Agent crash normally reaches `run_finished` through the runner
 * close handler. This module covers the other two cases: the process already
 * exited but the waiter never settled, and a runner that stays alive without
 * any output for longer than its progress budget.
 */

export type RunningQueryHealthInput = {
  queryInFlight: boolean;
  /** False while no runner is active or the run belongs to a scheduled task. */
  active: boolean;
  /** Timestamp of the latest runner output/start. Null when unknown. */
  lastActivityAt: number | null;
  now: number;
  progressTimeoutMs: number;
  /** Node child-process exit already observed. */
  processExited: boolean;
  stopRequested?: boolean;
  /** Timestamp the current stop was requested. Null/undefined keeps the
   * legacy behaviour for callers that do not track it. */
  stopRequestedAt?: number | null;
  /** How long a requested stop may be in flight before health checks resume.
   * Defaults to a value long enough for a force-kill plus teardown. */
  stopGraceMs?: number;
};

export const DEFAULT_STOP_GRACE_MS = 20_000;

export type RunningQueryHealth = {
  status: 'healthy' | 'exited' | 'stalled';
  idleMs: number;
  message: string | null;
};

export function assessRunningQueryHealth(
  input: RunningQueryHealthInput,
): RunningQueryHealth {
  if (!input.active || !input.queryInFlight)
    return { status: 'healthy', idleMs: 0, message: null };
  if (input.stopRequested) {
    // A stop normally resolves within the force-kill + teardown window. If it
    // does not (paused/unresponsive container), keep reporting the run as
    // unhealthy so the watchdog can retry the kill and ultimately clean up.
    const stopGraceMs = input.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const stopAge =
      input.stopRequestedAt === null || input.stopRequestedAt === undefined
        ? null
        : Math.max(0, input.now - input.stopRequestedAt);
    if (stopAge === null || stopAge < stopGraceMs)
      return { status: 'healthy', idleMs: 0, message: null };
  }
  if (input.processExited)
    return {
      status: 'exited',
      idleMs: 0,
      message: '容器或 Agent 进程异常退出，本次处理没有完成。',
    };
  const idleMs =
    input.lastActivityAt === null
      ? 0
      : Math.max(0, input.now - input.lastActivityAt);
  if (idleMs < input.progressTimeoutMs)
    return { status: 'healthy', idleMs, message: null };
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return {
    status: 'stalled',
    idleMs,
    message: `长时间无响应（约 ${minutes} 分钟没有进度），本次处理已中断。`,
  };
}

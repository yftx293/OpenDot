/**
 * Durable run progress watchdog.
 *
 * Pi Durable reports every generation/tool change through the conversation
 * watch. A run that keeps an input submitted without any change for longer
 * than the bounded progress timeout is considered hung, so the host can fail
 * it with a visible reason instead of leaving the session "busy" forever.
 */

export const DEFAULT_DURABLE_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_PROGRESS_TIMEOUT_MS = 10_000;
const MAX_PROGRESS_TIMEOUT_MS = 60 * 60 * 1000;

export function durableProgressTimeoutMs(
  envValue: string | undefined = process.env
    .MINICLAW_DURABLE_PROGRESS_TIMEOUT_MS,
): number {
  const parsed = Number(envValue);
  if (
    Number.isFinite(parsed) &&
    parsed >= MIN_PROGRESS_TIMEOUT_MS &&
    parsed <= MAX_PROGRESS_TIMEOUT_MS
  )
    return Math.floor(parsed);
  return DEFAULT_DURABLE_PROGRESS_TIMEOUT_MS;
}

export type DurableStallInput = {
  /** A committed input is still submitted to the native runtime. */
  running: boolean;
  /** Last watch/update timestamp for the session. */
  lastProgressAt: number | null;
  now: number;
  timeoutMs: number;
};

export type DurableStall = {
  idleMs: number;
  message: string;
};

export function detectDurableRunStall(
  input: DurableStallInput,
): DurableStall | null {
  if (!input.running || input.lastProgressAt === null) return null;
  const idleMs = Math.max(0, input.now - input.lastProgressAt);
  if (idleMs < input.timeoutMs) return null;
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return {
    idleMs,
    message: `长时间无响应（约 ${minutes} 分钟没有进度）`,
  };
}

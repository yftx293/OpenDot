/** Browser copy of the live-hint merge. The server owns the same field names. */

export type DurableFailure = {
  kind: 'provider' | 'runtime' | 'stalled' | 'aborted' | 'unknown';
  status: number | null;
  message: string;
  retryable: boolean;
  hint: string;
};

export type DurableProgress = {
  executionState: string;
  busy: boolean;
  partialText: string;
  currentTool: string | null;
  toolStatus: string | null;
  retrying: boolean;
  pendingApprovals: number;
  failure?: DurableFailure | null;
};

export type DurableView = {
  executionState?: string;
  failure?: DurableFailure | null;
  live: null | {
    busy: boolean;
    taskId?: number | null;
    partialText: string;
    retrying: boolean;
    tools: { callId: string; name: string; status: string }[];
    queueDigest?: string;
    queue: unknown[];
  };
};

export function retainDurableView<T>(
  previous: T | null,
  next: T | null,
): T | null {
  return next ?? previous;
}

export function applyDurableProgress<T extends DurableView>(
  snapshot: T | null,
  progress: DurableProgress,
): T | null {
  if (!snapshot) return snapshot;
  const tools = progress.currentTool
    ? [
        {
          callId: 'live',
          name: progress.currentTool,
          status: progress.toolStatus ?? 'running',
        },
      ]
    : (snapshot.live?.tools ?? []);
  const terminalState = [
    'failed',
    'suspended',
    'blocked',
    'cancelled',
  ].includes(snapshot.executionState ?? '');
  return {
    ...snapshot,
    executionState:
      progress.pendingApprovals > 0
        ? 'waiting_for_approval'
        : progress.retrying
          ? 'recovering'
          : progress.busy
            ? 'active'
            : progress.failure
              ? 'failed'
              : progress.executionState === 'idle' && !terminalState
                ? 'idle'
                : (snapshot.executionState ?? progress.executionState),
    failure: progress.failure ?? null,
    live: {
      ...(snapshot.live ?? {
        taskId: null,
        queueDigest: '',
      }),
      busy: progress.busy,
      partialText: progress.partialText || snapshot.live?.partialText || '',
      retrying: progress.retrying,
      tools,
      queue: snapshot.live?.queue ?? [],
    },
  };
}
